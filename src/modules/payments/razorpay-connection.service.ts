import { Injectable } from '@nestjs/common';
import { EntitlementsService } from '../entitlements/entitlements.service.js';
import { sql } from 'drizzle-orm';
import {
  AppException,
  forbidden,
  notFound,
} from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import { CredentialsKeyError } from './credentials-key.js';
import type { RazorpayStatusDto } from './payments.dto.js';
import { PaymentsEventLogger } from './payments.logger.js';
import {
  PaymentsService,
  PAYMENTS_UNAVAILABLE_MESSAGE,
} from './payments.service.js';
import { RazorpayClient, RazorpayError } from './razorpay.client.js';
import {
  loadRazorpayAccount,
  type RazorpayAccount,
} from './razorpay-credentials.js';

/**
 * Connects a tenant's saved Razorpay keys to Razorpay: proves they work, and turns payments on or off.
 * Only the Owner reaches it (controller guard), and the database functions it calls re-check the Owner role.
 */
@Injectable()
export class RazorpayConnectionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly payments: PaymentsService,
    private readonly client: RazorpayClient,
    private readonly events: PaymentsEventLogger,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Calls Razorpay with the saved keys and records the outcome. Nothing is created at Razorpay. */
  async verify(org: OrgContext): Promise<RazorpayStatusDto> {
    const account = await this.account(org);
    try {
      await this.client.validateCredentials(account);
    } catch (error) {
      if (error instanceof RazorpayError && error.kind === 'unavailable')
        // Nothing was learned about the keys, so the stored state is left as it was.
        throw new AppException(
          'UNAVAILABLE',
          'Razorpay could not be reached. Please try again in a moment.',
          { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
        );
      const message =
        error instanceof RazorpayError
          ? error.kind === 'auth'
            ? 'Razorpay did not accept this Key ID and Key Secret. Check them and save again.'
            : error.message
          : 'The connection check failed.';
      await this.record(org, false, message);
      this.events.record({
        actorUserId: org.userId,
        tenantId: org.tenantId,
        action: 'verify_failed',
      });
      return this.payments.get(org);
    }
    await this.record(org, true, null);
    this.events.record({
      actorUserId: org.userId,
      tenantId: org.tenantId,
      action: 'verify',
    });
    return this.payments.get(org);
  }

  async setEnabled(
    org: OrgContext,
    enabled: boolean,
  ): Promise<RazorpayStatusDto> {
    // Switching OFF is always allowed, so a plan change can never trap a store with payments it cannot turn off.
    if (enabled)
      await this.entitlements.assertFeatureAs(
        org.userId,
        org.tenantId,
        'online_payments',
      );
    const outcome = await this.db.withUser(
      org.userId,
      async (tx) =>
        rowsOf<{ r: string }>(
          await tx.execute(
            sql`select public.set_razorpay_enabled(${org.tenantId}::uuid, ${enabled}) as r`,
          ),
        )[0]?.r,
    );
    if (outcome === 'forbidden') throw forbidden();
    if (outcome === 'not_configured')
      throw notFound(
        'Save your Razorpay keys first.',
        'RAZORPAY_NOT_CONFIGURED',
      );
    if (outcome === 'not_verified')
      throw new AppException(
        'CONFLICT',
        'Check the connection to Razorpay successfully before turning payments on.',
        { code: 'RAZORPAY_NOT_VERIFIED' },
      );
    this.events.record({
      actorUserId: org.userId,
      tenantId: org.tenantId,
      action: enabled ? 'enable' : 'disable',
    });
    return this.payments.get(org);
  }

  private async account(org: OrgContext): Promise<RazorpayAccount> {
    let account: RazorpayAccount | null;
    try {
      // The Owner was authorised by the controller; the pinned role only ever reaches this one tenant's credentials.
      account = await this.db.withCheckout(org.tenantId, (tx) =>
        loadRazorpayAccount(tx, org.tenantId),
      );
    } catch (error) {
      if (error instanceof CredentialsKeyError)
        this.events.keyFailure(error.category);
      // A missing key, a rotated-away key version or tampered data: the Owner is told the safe, generic message.
      throw new AppException('UNAVAILABLE', PAYMENTS_UNAVAILABLE_MESSAGE, {
        code: 'PAYMENTS_UNAVAILABLE',
      });
    }
    if (!account)
      throw notFound(
        'Save your Razorpay keys first.',
        'RAZORPAY_NOT_CONFIGURED',
      );
    return account;
  }

  private async record(org: OrgContext, ok: boolean, error: string | null) {
    await this.db.withUser(org.userId, async (tx) => {
      await tx.execute(
        sql`select public.record_razorpay_verification(${org.tenantId}::uuid, ${ok}, ${error})`,
      );
    });
  }
}
