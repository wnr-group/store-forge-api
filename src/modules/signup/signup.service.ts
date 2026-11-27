import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  AppException,
  conflict,
  forbidden,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { errorChain } from '../../common/db-errors.js';
import type { AuthUser } from '../../common/interfaces/request-context.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { signupOrders } from '../../database/schema/index.js';
import { verifyCheckoutSignature } from '../payments/razorpay-signature.js';
import { PlatformRazorpayService } from '../billing/platform-razorpay.service.js';
import { mapProvisioningError } from '../platform-admin/platform-errors.js';
import { TenantProvisioningService } from '../provisioning/tenant-provisioning.service.js';
import type {
  CreateStoreDto,
  SignupCheckoutDto,
  SignupPaymentVerifiedDto,
  SignupStatusDto,
  SignupStoreDto,
  StartCheckoutDto,
} from './signup.dto.js';
import type { VerifyPaymentDto } from '../billing/billing.dto.js';

type StatusRaw = Partial<
  Omit<SignupStatusDto, 'state'> & { state: SignupStatusDto['state'] }
> & { state: SignupStatusDto['state'] };
type PreparedRaw = {
  signupId: string;
  status: 'created' | 'paid';
  planCode: string;
  planName: string;
  billingInterval: 'monthly' | 'yearly';
  currency: string;
  subtotalMinor: number | string;
  taxMinor: number | string;
  totalMinor: number | string;
  existingOrderId: string | null;
};
type ProvisionedRaw = {
  tenant_id: string;
  store_slug: string;
  public_id: string;
  created: boolean;
};

const num = (v: number | string | null | undefined) =>
  v === null || v === undefined ? null : Number(v);

const paymentNotCaptured = () =>
  new AppException('CONFLICT', 'The payment has not been completed yet.', {
    code: 'PAYMENT_NOT_CAPTURED',
  });
const signatureInvalid = () =>
  new AppException('VALIDATION', 'The payment could not be verified.', {
    code: 'PAYMENT_SIGNATURE_INVALID',
  });

/** Maps the signup_* SQL functions' RAISE codes to client-safe errors. Unrecognised errors are passed on unchanged. */
function mapSignupError(error: unknown): never {
  if (error instanceof AppException) throw error;
  const msg = errorChain(error);
  if (msg.includes('platform_admin_cannot_be_member'))
    throw forbidden(
      'Platform admin accounts cannot own a store. Use a different account.',
      'PLATFORM_ADMIN_CANNOT_BUY',
    );
  if (msg.includes('payment_required'))
    throw new AppException('CONFLICT', 'Complete the payment first.', {
      code: 'PAYMENT_REQUIRED',
    });
  if (msg.includes('order_not_open'))
    throw conflict(
      'That purchase is no longer open. Choose your plan again.',
      undefined,
      'SIGNUP_NOT_OPEN',
    );
  if (msg.includes('amount_mismatch'))
    throw conflict(
      'The amount paid does not match the plan price.',
      undefined,
      'PAYMENT_AMOUNT_MISMATCH',
    );
  if (msg.includes('interval_unavailable'))
    throw invalid(
      'That billing period is not available for this plan.',
      { billingInterval: 'Choose another billing period' },
      'INTERVAL_UNAVAILABLE',
    );
  // 'plan_not_found' contains 'not_found'.
  if (msg.includes('plan_not_found'))
    throw notFound('That plan is not available.', 'PLAN_NOT_FOUND');
  if (msg.includes('not_found'))
    throw notFound('That purchase was not found.', 'SIGNUP_NOT_FOUND');
  throw error;
}

/**
 * Self-service sign-up after the account exists: buy a plan, then name the store. The rules (price, settlement, idempotency, who owns
 * what) live in the `signup_*` SQL functions; this service only sequences them and talks to Razorpay. A payment counts only after the
 * server has checked Razorpay's signature AND asked Razorpay itself, or Razorpay's signed webhook reported it (billing-webhook.service).
 * The store is created by the same SQL routine the Platform Admin uses, so both ways of getting a tenant behave alike.
 */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly razorpay: PlatformRazorpayService,
    private readonly provisioning: TenantProvisioningService,
  ) {}

  private toStatus(raw: StatusRaw): SignupStatusDto {
    return {
      state: raw.state,
      signupId: raw.signupId ?? null,
      planCode: raw.planCode ?? null,
      planName: raw.planName ?? null,
      billingInterval: raw.billingInterval ?? null,
      currency: raw.currency ?? null,
      subtotalMinor: num(raw.subtotalMinor),
      taxMinor: num(raw.taxMinor),
      totalMinor: num(raw.totalMinor),
      tenantId: raw.tenantId ?? null,
      lastFailure: raw.lastFailure ?? null,
    };
  }

  /** Where the signed-in person is in the sign-up: nothing started, must pay, must name the store, or done. */
  async status(user: AuthUser): Promise<SignupStatusDto> {
    const raw = await this.db.withUser(
      user.id,
      async (tx) =>
        rowsOf<{ r: StatusRaw }>(
          await tx.execute(sql`select public.signup_status() as r`),
        )[0].r,
    );
    return this.toStatus(raw);
  }

  /**
   * Starts (or resumes) the purchase of a plan and returns what Razorpay Checkout needs. Calling it again after a failed or abandoned
   * payment returns the same Razorpay order, so a retry needs no new account and cannot be charged twice for one order.
   */
  async startCheckout(
    user: AuthUser,
    dto: StartCheckoutDto,
  ): Promise<SignupCheckoutDto> {
    let prepared: PreparedRaw;
    try {
      prepared = await this.db.withUser(
        user.id,
        async (tx) =>
          rowsOf<{ r: PreparedRaw }>(
            await tx.execute(
              sql`select public.signup_prepare(${dto.planCode}, ${dto.billingInterval}) as r`,
            ),
          )[0].r,
      );
    } catch (error) {
      return mapSignupError(error);
    }

    const status = await this.status(user);
    if (prepared.status === 'paid') return { ...status, payment: null }; // free plan, or already paid: the store step is next

    this.razorpay.credentials(); // fail early, with a clear message, when payments are not set up
    let orderId = prepared.existingOrderId;
    if (!orderId) {
      // The outside call happens with no transaction open.
      const order = await this.razorpay.createOrder({
        amountMinor: Number(prepared.totalMinor),
        currency: prepared.currency,
        receipt: `SU-${prepared.signupId.replace(/-/g, '').slice(0, 12)}`,
        notes: { signupId: prepared.signupId },
      });
      try {
        orderId = await this.db.withUser(
          user.id,
          async (tx) =>
            rowsOf<{ r: string }>(
              await tx.execute(
                sql`select public.signup_attach_order(${prepared.signupId}::uuid, ${order.id}, ${order.amountMinor}::bigint, ${order.currency}) as r`,
              ),
            )[0].r,
        );
      } catch (error) {
        this.logger.error(
          `could not record the Razorpay order for signup ${prepared.signupId}`,
        );
        return mapSignupError(error);
      }
    }
    return { ...status, payment: { orderId, keyId: this.razorpay.keyId } };
  }

  /** Confirms a checkout result. Idempotent: confirming the same payment again changes nothing. */
  async verifyPayment(
    user: AuthUser,
    v: VerifyPaymentDto,
  ): Promise<SignupPaymentVerifiedDto> {
    this.razorpay.credentials();

    // The order must be this person's own (row level security) before anything is sent to Razorpay.
    const own = await this.db.withUser(user.id, async (tx) => {
      const [r] = await tx
        .select({ id: signupOrders.id })
        .from(signupOrders)
        .where(eq(signupOrders.razorpayOrderId, v.razorpayOrderId));
      return r;
    });
    if (!own)
      throw notFound('That payment was not found.', 'PAYMENT_NOT_FOUND');

    if (
      !verifyCheckoutSignature(
        v.razorpayOrderId,
        v.razorpayPaymentId,
        v.razorpaySignature,
        this.razorpay.keySecret(),
      )
    )
      throw signatureInvalid();

    // The browser's word is not enough: ask Razorpay what really happened.
    let payment = await this.razorpay.fetchPayment(v.razorpayPaymentId);
    if (payment.orderId !== v.razorpayOrderId) throw signatureInvalid();
    if (payment.status === 'authorized')
      payment = await this.razorpay.capturePayment(payment);
    if (payment.status !== 'captured') throw paymentNotCaptured();

    try {
      const result = await this.db.withUser(
        user.id,
        async (tx) =>
          rowsOf<{ r: { result: string; status: string } }>(
            await tx.execute(sql`select public.signup_apply_payment(
              ${v.razorpayOrderId}, ${payment.id}, ${payment.amountMinor}::bigint, ${payment.currency}, ${payment.method},
              'captured', null, null) as r`),
          )[0].r,
      );
      return {
        result: result.result === 'captured' ? 'captured' : 'duplicate',
        state:
          result.status === 'provisioned' ? 'provisioned' : 'store_required',
      };
    } catch (error) {
      if (errorChain(error).includes('amount_mismatch'))
        this.logger.error(`amount mismatch on order ${v.razorpayOrderId}`);
      return mapSignupError(error);
    }
  }

  /**
   * Creates the paid customer's store: tenant, Owner membership (the person who paid), the store itself and the plan they paid for.
   * Only a paid purchase can be used, and sending it twice returns the same store instead of creating a second one.
   */
  async createStore(
    user: AuthUser,
    dto: CreateStoreDto,
  ): Promise<SignupStoreDto> {
    const status = await this.status(user);
    if (status.state === 'none' || !status.signupId)
      throw notFound('Choose a plan first.', 'SIGNUP_NOT_FOUND');
    if (status.state === 'payment_required')
      throw new AppException('CONFLICT', 'Complete the payment first.', {
        code: 'PAYMENT_REQUIRED',
      });
    const signupId = status.signupId;

    try {
      const out = await this.provisioning.withStoreSlug(
        dto.storeName,
        (slug, publicId) =>
          this.db
            .withUser(
              user.id,
              async (tx) =>
                rowsOf<{ r: ProvisionedRaw }>(
                  await tx.execute(
                    sql`select public.signup_provision(${signupId}::uuid, ${dto.storeName}, ${slug}, ${publicId}) as r`,
                  ),
                )[0].r,
            )
            .catch((error: unknown) => mapSignupError(error)),
      );
      return {
        tenantId: out.tenant_id,
        storeSlug: out.store_slug,
        publicId: out.public_id,
        created: out.created,
      };
    } catch (error) {
      return mapProvisioningError(error);
    }
  }
}
