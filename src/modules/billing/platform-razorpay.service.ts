import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/app.exception.js';
import type { AppConfig } from '../../config/configuration.js';
import {
  RazorpayClient,
  RazorpayError,
  type RazorpayCredentials,
  type RazorpayOrder,
  type RazorpayPayment,
  type RazorpayRefund,
} from '../payments/razorpay.client.js';

const unavailable = (message: string, code = 'BILLING_PAYMENTS_UNAVAILABLE') =>
  new AppException('UNAVAILABLE', message, { code });

/**
 * StoreForge's OWN Razorpay account, used to collect subscription payments. It reuses the one reviewed Razorpay client of the payments
 * module (timeouts, no automatic retry of money-moving calls, no secret in any message) and the signature checks in
 * payments/razorpay-signature.ts; it only supplies different credentials, which come from the server environment and never leave it.
 */
@Injectable()
export class PlatformRazorpayService {
  private readonly logger = new Logger(PlatformRazorpayService.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly client: RazorpayClient,
  ) {}

  private get settings() {
    return this.config.get('razorpayPlatform', { infer: true });
  }

  /** True when payments can be taken (both keys are set). */
  get configured(): boolean {
    return !!(this.settings.keyId && this.settings.keySecret);
  }

  get keyId(): string {
    return this.credentials().keyId;
  }

  /** The secret never leaves this class except as the argument of a Razorpay call. */
  credentials(): RazorpayCredentials {
    const { keyId, keySecret } = this.settings;
    if (!keyId || !keySecret)
      throw unavailable(
        'Online payment is not available right now. Please contact StoreForge.',
      );
    return { keyId, keySecret };
  }

  /** For checking the signature of a Checkout response. */
  keySecret(): string {
    return this.credentials().keySecret;
  }

  webhookSecret(): string {
    const secret = this.settings.webhookSecret;
    if (!secret)
      throw unavailable(
        'Billing webhooks are not configured.',
        'BILLING_WEBHOOK_DISABLED',
      );
    return secret;
  }

  /** Turns a Razorpay failure into a safe error: no key, no response body, nothing that helps an attacker. */
  private fail(error: unknown): never {
    if (error instanceof AppException) throw error;
    if (error instanceof RazorpayError) {
      this.logger.error(
        `razorpay ${error.kind}${error.status ? ` ${error.status}` : ''}`,
      );
      if (error.kind === 'auth')
        throw unavailable(
          'Online payment is not available right now. Please contact StoreForge.',
        );
      throw unavailable(
        'The payment provider could not be reached. Please try again in a moment.',
        'PAYMENT_PROVIDER_UNAVAILABLE',
      );
    }
    throw error;
  }

  async createOrder(input: {
    amountMinor: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder> {
    try {
      return await this.client.createOrder(this.credentials(), input);
    } catch (e) {
      return this.fail(e);
    }
  }

  async fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    try {
      return await this.client.fetchPayment(this.credentials(), paymentId);
    } catch (e) {
      return this.fail(e);
    }
  }

  async capturePayment(p: RazorpayPayment): Promise<RazorpayPayment> {
    try {
      return await this.client.capturePayment(
        this.credentials(),
        p.id,
        p.amountMinor,
        p.currency,
      );
    } catch (e) {
      return this.fail(e);
    }
  }

  async createRefund(
    paymentId: string,
    input: { amountMinor: number; receipt: string; reason?: string },
  ): Promise<RazorpayRefund> {
    try {
      return await this.client.createRefund(
        this.credentials(),
        paymentId,
        input,
      );
    } catch (e) {
      return this.fail(e);
    }
  }

  async fetchRefunds(paymentId: string): Promise<RazorpayRefund[]> {
    try {
      return await this.client.fetchRefunds(this.credentials(), paymentId);
    } catch (e) {
      return this.fail(e);
    }
  }
}
