import { describe, expect, it } from 'vitest';
import { AppException } from '../../common/app.exception.js';
import { formatMoney, renderInvoicePdf } from './invoice-pdf.js';
import { SimplePdf, textWidth } from './pdf-lite.js';
import { PlatformRazorpayService } from './platform-razorpay.service.js';
import type {
  BillingInvoice,
  BillingPayment,
} from '../../database/schema/index.js';

const config = (settings: Record<string, string | undefined>) =>
  ({ get: () => settings }) as never;

const invoice = (over: Partial<BillingInvoice> = {}): BillingInvoice => ({
  id: 'i1',
  number: 'SF-2026-000007',
  tenantId: 't1',
  tenantName: 'Acme (Pvt) Ltd \\ Co',
  subscriptionId: 's1',
  planCode: 'growth',
  planName: 'Growth',
  billingInterval: 'monthly',
  description: 'Growth plan, monthly subscription',
  periodStart: new Date('2026-11-01T00:00:00Z'),
  periodEnd: new Date('2026-12-01T00:00:00Z'),
  currency: 'INR',
  subtotalMinor: 149950,
  taxRateBps: 1800,
  taxMinor: 26991,
  totalMinor: 176941,
  seller: {
    legalName: 'StoreForge',
    address: '1 Road',
    gstin: '19ABCDE1234F1Z5',
    taxLabel: 'GST',
  },
  status: 'open',
  issuedAt: new Date('2026-11-01T00:00:00Z'),
  dueAt: new Date('2026-11-08T00:00:00Z'),
  paidAt: null,
  voidedAt: null,
  voidReason: null,
  createdBy: null,
  ...over,
});

describe('formatMoney', () => {
  it('groups digits the Indian way and keeps the currency code', () => {
    expect(formatMoney(176941, 'INR')).toBe('INR 1,769.41');
    expect(formatMoney(0, 'INR')).toBe('INR 0.00');
    expect(formatMoney(12345678900, 'INR')).toBe('INR 12,34,56,789.00');
  });
  it('follows the currency decimals', () => {
    expect(formatMoney(500, 'JPY')).toBe('JPY 500');
  });
});

describe('SimplePdf', () => {
  it('writes a well-formed PDF whose cross-reference table points at every object', () => {
    const buf = new SimplePdf()
      .text(40, 60, 'Hello (world) \\ test', { size: 12, bold: true })
      .line(10, 10, 100, 10)
      .band(10, 20, 80, 10)
      .build();
    const text = buf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe('xref');
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map(
      (m) => Number(m[1]),
    );
    expect(entries).toHaveLength(6);
    entries.forEach((offset, i) =>
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(
        `${i + 1} 0 obj`,
      ),
    );
    // Special characters in text are escaped, never able to end the string early.
    expect(text).toContain('(Hello \\(world\\) \\\\ test)');
  });

  it('turns characters outside Latin-1 into "?" and measures wider text as wider', () => {
    const text = new SimplePdf()
      .text(0, 0, 'Rs ₹ 100')
      .build()
      .toString('latin1');
    expect(text).toContain('(Rs ? 100)');
    expect(textWidth('WWWW', 10)).toBeGreaterThan(textWidth('iiii', 10));
    expect(textWidth('abc', 10, true)).toBeGreaterThan(textWidth('abc', 10));
  });
});

describe('renderInvoicePdf', () => {
  it('prints the stored amounts, tax and seller, and marks an unpaid invoice UNPAID', () => {
    const text = renderInvoicePdf(invoice(), []).toString('latin1');
    for (const expected of [
      'SF-2026-000007',
      'INR 1,499.50',
      'INR 269.91',
      'INR 1,769.41',
      'GST \\(18%\\)',
      'GSTIN: 19ABCDE1234F1Z5',
      'UNPAID',
    ])
      expect(text, expected).toContain(expected);
    // The organization name contains brackets and a backslash: they must be escaped.
    expect(text).toContain('Acme \\(Pvt\\) Ltd \\\\ Co');
  });

  it('shows the verified payment on a paid invoice, and the reason on a void one', () => {
    const payment = {
      status: 'succeeded',
      provider: 'razorpay',
      method: 'upi',
      razorpayPaymentId: 'pay_ABC123',
      amountMinor: 176941,
      currency: 'INR',
      refundedMinor: 0,
      capturedAt: new Date('2026-11-02T00:00:00Z'),
    } as BillingPayment;
    const paid = renderInvoicePdf(
      invoice({ status: 'paid', paidAt: new Date() }),
      [payment],
    ).toString('latin1');
    expect(paid).toContain('PAID');
    expect(paid).toContain('pay_ABC123');
    // A failed attempt is not payment.
    const failed = renderInvoicePdf(
      invoice({ status: 'paid', paidAt: new Date() }),
      [{ ...payment, status: 'failed' } as BillingPayment],
    ).toString('latin1');
    expect(failed).not.toContain('pay_ABC123');
    const voided = renderInvoicePdf(
      invoice({
        status: 'void',
        voidedAt: new Date(),
        voidReason: 'Billing mistake',
      }),
      [],
    ).toString('latin1');
    expect(voided).toContain('VOID');
    expect(voided).toContain('Billing mistake');
  });
});

describe('PlatformRazorpayService', () => {
  const service = (settings: Record<string, string | undefined>) =>
    new PlatformRazorpayService(config(settings), {} as never);

  it('reports payments as unavailable, with no hint of the keys, when they are not configured', () => {
    for (const settings of [
      {},
      { keyId: 'rzp_test_abcdefgh' },
      { keySecret: 'secretsecretsecret' },
    ]) {
      const s = service(settings);
      expect(s.configured).toBe(false);
      try {
        s.credentials();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(AppException);
        expect((e as AppException).code).toBe('BILLING_PAYMENTS_UNAVAILABLE');
        expect((e as AppException).getStatus()).toBe(503);
        expect((e as Error).message).not.toMatch(/rzp_|secret/i);
      }
    }
  });

  it('refuses webhooks when no webhook secret is configured, and hands the keys only to callers inside the class graph', () => {
    expect(() =>
      service({
        keyId: 'rzp_test_abcdefgh',
        keySecret: 'secretsecretsecret',
      }).webhookSecret(),
    ).toThrowError(
      expect.objectContaining({ code: 'BILLING_WEBHOOK_DISABLED' }),
    );
    const ok = service({
      keyId: 'rzp_test_abcdefgh',
      keySecret: 'secretsecretsecret',
      webhookSecret: 'hooksecrethooksecret',
    });
    expect(ok.configured).toBe(true);
    expect(ok.keyId).toBe('rzp_test_abcdefgh');
    expect(ok.webhookSecret()).toBe('hooksecrethooksecret');
  });
});
