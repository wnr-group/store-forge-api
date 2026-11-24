import { Injectable, Logger } from '@nestjs/common';
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  AppException,
  conflict,
  invalid,
  notFound,
} from '../../common/app.exception.js';
import { errorChain } from '../../common/db-errors.js';
import { Paginated } from '../../common/dto/api-response.dto.js';
import { parseMoney } from '../../common/utils/money.js';
import {
  DatabaseService,
  rowsOf,
  type DbTx,
} from '../../database/database.service.js';
import {
  billingInvoices,
  billingPayments,
  billingRefunds,
  billingSettings,
  type BillingInvoice,
  type BillingPayment,
  type BillingRefund,
} from '../../database/schema/index.js';
import { recordAudit } from '../platform-admin/audit/audit.service.js';
import { mapProvisioningError } from '../platform-admin/platform-errors.js';
import type {
  BillingPaymentDto,
  BillingRefundDto,
  BillingRunDto,
  BillingSettingsDto,
  BillingSummaryDto,
  InvoiceDetailDto,
  InvoiceDto,
  InvoiceListQueryDto,
  ManualPaymentDto,
  PaymentDetailDto,
  PaymentListQueryDto,
  RefundPaymentDto,
  SummaryQueryDto,
  TenantBillingDto,
  UpdateBillingSettingsDto,
} from './billing.dto.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import { PlatformRazorpayService } from './platform-razorpay.service.js';

const likePattern = (s: string) =>
  `%${s.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

const startOfDay = (s: string | undefined, plusDays = 0): Date | undefined => {
  if (!s) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d;
};

/** Maps the billing SQL functions' RAISE codes to client-safe errors; anything else is a platform error or rethrown. */
export function mapBillingError(error: unknown): never {
  if (error instanceof AppException) throw error;
  const msg = errorChain(error);
  if (msg.includes('nothing_to_bill'))
    throw invalid(
      'This organization is on a free plan (or has no period to bill), so there is nothing to invoice.',
      undefined,
      'NOTHING_TO_BILL',
    );
  if (msg.includes('invoice_exists'))
    throw conflict(
      'That period has already been invoiced.',
      undefined,
      'INVOICE_EXISTS',
    );
  if (msg.includes('invoice_not_open'))
    throw conflict(
      'That invoice is not open (it is already paid or void).',
      undefined,
      'INVOICE_NOT_OPEN',
    );
  if (msg.includes('payment_not_refundable'))
    throw conflict(
      'Only a successful payment can be refunded.',
      undefined,
      'PAYMENT_NOT_REFUNDABLE',
    );
  if (msg.includes('invalid_refund_amount'))
    throw invalid(
      'The refund is more than what is left to refund on this payment.',
      { amount: 'More than the refundable amount' },
      'REFUND_AMOUNT_INVALID',
    );
  if (msg.includes('amount_mismatch'))
    throw conflict(
      'The amount paid does not match the invoice.',
      undefined,
      'PAYMENT_AMOUNT_MISMATCH',
    );
  return mapProvisioningError(error, 'That record was not found.');
}

export const toInvoiceDto = (
  i: BillingInvoice,
  now = new Date(),
): InvoiceDto => ({
  id: i.id,
  number: i.number,
  tenantId: i.tenantId,
  tenantName: i.tenantName,
  planCode: i.planCode,
  planName: i.planName,
  billingInterval: i.billingInterval,
  description: i.description,
  periodStart: i.periodStart,
  periodEnd: i.periodEnd,
  currency: i.currency,
  subtotalMinor: i.subtotalMinor,
  taxRateBps: i.taxRateBps,
  taxMinor: i.taxMinor,
  totalMinor: i.totalMinor,
  status: i.status,
  overdue: i.status === 'open' && i.dueAt.getTime() < now.getTime(),
  issuedAt: i.issuedAt,
  dueAt: i.dueAt,
  paidAt: i.paidAt,
  voidedAt: i.voidedAt,
  voidReason: i.voidReason,
  seller: i.seller,
});

const toPaymentDto = (
  p: BillingPayment,
  invoice: Pick<BillingInvoice, 'number' | 'tenantName'>,
): BillingPaymentDto => ({
  id: p.id,
  invoiceId: p.invoiceId,
  invoiceNumber: invoice.number,
  tenantId: p.tenantId,
  tenantName: invoice.tenantName,
  provider: p.provider,
  status: p.status,
  amountMinor: p.amountMinor,
  currency: p.currency,
  razorpayOrderId: p.razorpayOrderId,
  razorpayPaymentId: p.razorpayPaymentId,
  method: p.method,
  reference: p.reference,
  note: p.note,
  failureCode: p.failureCode,
  failureDescription: p.failureDescription,
  refundRequired: p.refundRequired,
  refundedMinor: p.refundedMinor,
  capturedAt: p.capturedAt,
  createdAt: p.createdAt,
});

const toRefundDto = (r: BillingRefund): BillingRefundDto => ({
  id: r.id,
  paymentId: r.paymentId,
  amountMinor: r.amountMinor,
  currency: r.currency,
  status: r.status,
  reason: r.reason,
  razorpayRefundId: r.razorpayRefundId,
  failureReason: r.failureReason,
  createdAt: r.createdAt,
  processedAt: r.processedAt,
});

const invoiceNotFound = () =>
  notFound('That invoice was not found.', 'INVOICE_NOT_FOUND');
const paymentNotFound = () =>
  notFound('That payment was not found.', 'PAYMENT_NOT_FOUND');

/**
 * Subscription billing for Platform Admins, and the read side the tenant Owner shares. Money rules (settling an invoice, extending a
 * subscription, refunds, renewals) are SQL functions; this service reads, validates, calls them in one transaction with the audit entry,
 * and talks to Razorpay outside any transaction. Reads run as the caller, so row level security alone limits an Owner to its own tenant.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly razorpay: PlatformRazorpayService,
  ) {}

  // --- reads ----------------------------------------------------------------------------------------------------------------------

  async listInvoices(
    userId: string,
    q: InvoiceListQueryDto,
    tenantId?: string,
  ): Promise<Paginated<InvoiceDto>> {
    return this.db.withUser(userId, async (tx) => {
      const now = new Date();
      const where = and(
        tenantId
          ? eq(billingInvoices.tenantId, tenantId)
          : q.org
            ? eq(billingInvoices.tenantId, q.org)
            : undefined,
        q.status === 'overdue'
          ? and(
              eq(billingInvoices.status, 'open'),
              lt(billingInvoices.dueAt, now),
            )
          : q.status === 'all'
            ? undefined
            : eq(billingInvoices.status, q.status),
        q.from ? gte(billingInvoices.issuedAt, startOfDay(q.from)!) : undefined,
        q.to ? lt(billingInvoices.issuedAt, startOfDay(q.to, 1)!) : undefined,
        q.search
          ? or(
              ilike(billingInvoices.number, likePattern(q.search)),
              ilike(billingInvoices.tenantName, likePattern(q.search)),
            )
          : undefined,
      );
      const [{ total }] = await tx
        .select({ total: count() })
        .from(billingInvoices)
        .where(where);
      const rows = await tx
        .select()
        .from(billingInvoices)
        .where(where)
        .orderBy(desc(billingInvoices.issuedAt), desc(billingInvoices.id))
        .limit(q.limit)
        .offset((q.page - 1) * q.limit);
      return new Paginated(
        rows.map((r) => toInvoiceDto(r, now)),
        {
          page: q.page,
          limit: q.limit,
          total: Number(total),
        },
      );
    });
  }

  private async paymentsOf(tx: DbTx, invoiceIds: string[]) {
    if (invoiceIds.length === 0) return [];
    return tx
      .select({ p: billingPayments, i: billingInvoices })
      .from(billingPayments)
      .innerJoin(
        billingInvoices,
        eq(billingInvoices.id, billingPayments.invoiceId),
      )
      .where(inArray(billingPayments.invoiceId, invoiceIds))
      .orderBy(desc(billingPayments.createdAt));
  }

  private async invoiceDetail(
    tx: DbTx,
    id: string,
    tenantId?: string,
  ): Promise<InvoiceDetailDto> {
    const [invoice] = await tx
      .select()
      .from(billingInvoices)
      .where(
        and(
          eq(billingInvoices.id, id),
          tenantId ? eq(billingInvoices.tenantId, tenantId) : undefined,
        ),
      );
    if (!invoice) throw invoiceNotFound();
    const pays = await this.paymentsOf(tx, [id]);
    const refunds = pays.length
      ? await tx
          .select()
          .from(billingRefunds)
          .where(
            inArray(
              billingRefunds.paymentId,
              pays.map((p) => p.p.id),
            ),
          )
          .orderBy(desc(billingRefunds.createdAt))
      : [];
    return {
      ...toInvoiceDto(invoice),
      payments: pays.map((p) => toPaymentDto(p.p, p.i)),
      refunds: refunds.map(toRefundDto),
    };
  }

  getInvoice(
    userId: string,
    id: string,
    tenantId?: string,
  ): Promise<InvoiceDetailDto> {
    return this.db.withUser(userId, (tx) =>
      this.invoiceDetail(tx, id, tenantId),
    );
  }

  /** The invoice PDF, built from the stored records only. */
  async invoicePdf(
    userId: string,
    id: string,
    tenantId?: string,
  ): Promise<{ number: string; pdf: Buffer }> {
    return this.db.withUser(userId, async (tx) => {
      const [invoice] = await tx
        .select()
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.id, id),
            tenantId ? eq(billingInvoices.tenantId, tenantId) : undefined,
          ),
        );
      if (!invoice) throw invoiceNotFound();
      const pays = await tx
        .select()
        .from(billingPayments)
        .where(eq(billingPayments.invoiceId, id));
      return { number: invoice.number, pdf: renderInvoicePdf(invoice, pays) };
    });
  }

  async listPayments(
    userId: string,
    q: PaymentListQueryDto,
    tenantId?: string,
  ): Promise<Paginated<BillingPaymentDto>> {
    return this.db.withUser(userId, async (tx) => {
      const filters: (SQL | undefined)[] = [
        tenantId
          ? eq(billingPayments.tenantId, tenantId)
          : q.org
            ? eq(billingPayments.tenantId, q.org)
            : undefined,
        q.status === 'all' ? undefined : eq(billingPayments.status, q.status),
        q.from
          ? gte(billingPayments.createdAt, startOfDay(q.from)!)
          : undefined,
        q.to ? lt(billingPayments.createdAt, startOfDay(q.to, 1)!) : undefined,
        q.refundRequired
          ? and(
              eq(billingPayments.refundRequired, true),
              sql`${billingPayments.refundedMinor} < ${billingPayments.amountMinor}`,
            )
          : undefined,
        q.search
          ? or(
              ilike(billingInvoices.number, likePattern(q.search)),
              ilike(billingInvoices.tenantName, likePattern(q.search)),
              ilike(billingPayments.razorpayPaymentId, likePattern(q.search)),
              ilike(billingPayments.razorpayOrderId, likePattern(q.search)),
              ilike(billingPayments.reference, likePattern(q.search)),
            )
          : undefined,
      ];
      const where = and(...filters);
      const [{ total }] = await tx
        .select({ total: count() })
        .from(billingPayments)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingPayments.invoiceId),
        )
        .where(where);
      const rows = await tx
        .select({ p: billingPayments, i: billingInvoices })
        .from(billingPayments)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingPayments.invoiceId),
        )
        .where(where)
        .orderBy(desc(billingPayments.createdAt), desc(billingPayments.id))
        .limit(q.limit)
        .offset((q.page - 1) * q.limit);
      return new Paginated(
        rows.map((r) => toPaymentDto(r.p, r.i)),
        {
          page: q.page,
          limit: q.limit,
          total: Number(total),
        },
      );
    });
  }

  async getPayment(userId: string, id: string): Promise<PaymentDetailDto> {
    return this.db.withUser(userId, async (tx) => {
      const [row] = await tx
        .select({ p: billingPayments, i: billingInvoices })
        .from(billingPayments)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingPayments.invoiceId),
        )
        .where(eq(billingPayments.id, id));
      if (!row) throw paymentNotFound();
      const refunds = await tx
        .select()
        .from(billingRefunds)
        .where(eq(billingRefunds.paymentId, id))
        .orderBy(desc(billingRefunds.createdAt));
      return {
        ...toPaymentDto(row.p, row.i),
        refunds: refunds.map(toRefundDto),
      };
    });
  }

  /** One tenant's billing position: plan, renewal date, open and overdue invoices, latest invoices and payments. */
  async tenantBilling(
    userId: string,
    tenantId: string,
  ): Promise<TenantBillingDto> {
    return this.db.withUser(userId, async (tx) => {
      const now = new Date();
      // Through the member-safe function: a tenant Owner cannot read the plan and subscription tables themselves.
      const sub = rowsOf<{
        e: {
          subscription: {
            status: string;
            plan_name: string;
            billing_interval: string;
            current_period_end: string | null;
          };
        } | null;
      }>(
        await tx.execute(
          sql`select public.tenant_entitlements(${tenantId}::uuid) as e`,
        ),
      )[0]?.e?.subscription;
      const invoices = await tx
        .select()
        .from(billingInvoices)
        .where(eq(billingInvoices.tenantId, tenantId))
        .orderBy(desc(billingInvoices.issuedAt))
        .limit(6);
      const [open] = await tx
        .select({
          n: count(),
          overdueN: sql<number>`count(*) filter (where ${billingInvoices.dueAt} < now())`,
          overdueSum: sql<number>`coalesce(sum(${billingInvoices.totalMinor}) filter (where ${billingInvoices.dueAt} < now()), 0)`,
        })
        .from(billingInvoices)
        .where(
          and(
            eq(billingInvoices.tenantId, tenantId),
            eq(billingInvoices.status, 'open'),
          ),
        );
      const pays = await tx
        .select({ p: billingPayments, i: billingInvoices })
        .from(billingPayments)
        .innerJoin(
          billingInvoices,
          eq(billingInvoices.id, billingPayments.invoiceId),
        )
        .where(eq(billingPayments.tenantId, tenantId))
        .orderBy(desc(billingPayments.createdAt))
        .limit(6);
      return {
        planName: sub?.plan_name ?? null,
        subscriptionStatus: sub?.status ?? null,
        billingInterval: sub?.billing_interval ?? null,
        renewsAt: sub?.current_period_end
          ? new Date(sub.current_period_end)
          : null,
        overdue: Number(open.overdueN) > 0,
        overdueAmountMinor: Number(open.overdueSum),
        openInvoices: Number(open.n),
        recentInvoices: invoices.map((i) => toInvoiceDto(i, now)),
        recentPayments: pays.map((r) => toPaymentDto(r.p, r.i)),
      };
    });
  }

  async summary(
    userId: string,
    q: SummaryQueryDto,
  ): Promise<BillingSummaryDto> {
    const to = q.to ?? new Date().toISOString().slice(0, 10);
    const from =
      q.from ??
      new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const fromD = startOfDay(from)!;
    const toD = startOfDay(to, 1)!;
    return this.db.withUser(userId, async (tx) => {
      const money = (rows: { currency: string; amount: unknown }[]) =>
        rows.map((r) => ({
          currency: r.currency,
          amountMinor: Math.round(Number(r.amount ?? 0)),
        }));
      const [mrr, byStatus, refunded, needRefund, overdue, open] =
        await Promise.all([
          tx.execute(sql`
          select p.currency, sum(case when s.billing_interval = 'yearly' then p.yearly_price_minor::numeric / 12 else p.monthly_price_minor end) as amount
          from public.tenant_subscriptions s join public.plans p on p.id = s.plan_id
          where s.status in ('active', 'past_due') group by p.currency having sum(case when s.billing_interval = 'yearly' then p.yearly_price_minor else p.monthly_price_minor end) > 0`),
          tx.execute(sql`
          select status, currency, count(*)::int as n, coalesce(sum(amount_minor), 0) as amount
          from public.billing_payments where created_at >= ${fromD} and created_at < ${toD} group by status, currency`),
          tx.execute(sql`
          select currency, coalesce(sum(amount_minor), 0) as amount from public.billing_refunds
          where status = 'processed' and processed_at >= ${fromD} and processed_at < ${toD} group by currency`),
          tx.execute(
            sql`select count(*)::int as n from public.billing_payments where refund_required and refunded_minor < amount_minor`,
          ),
          tx.execute(sql`
          select currency, count(*)::int as n, coalesce(sum(total_minor), 0) as amount from public.billing_invoices
          where status = 'open' and due_at < now() group by currency`),
          tx.execute(
            sql`select count(*)::int as n from public.billing_invoices where status = 'open'`,
          ),
        ]);
      const statusRows = rowsOf<{
        status: string;
        currency: string;
        n: number;
        amount: unknown;
      }>(byStatus);
      const ok = ['succeeded', 'refunded', 'partially_refunded'];
      const overdueRows = rowsOf<{
        currency: string;
        n: number;
        amount: unknown;
      }>(overdue);
      const collected = new Map<string, number>();
      for (const r of statusRows.filter((x) => ok.includes(x.status)))
        collected.set(
          r.currency,
          (collected.get(r.currency) ?? 0) + Number(r.amount),
        );
      return {
        from,
        to,
        mrr: money(rowsOf<{ currency: string; amount: unknown }>(mrr)),
        successfulPayments: statusRows
          .filter((x) => ok.includes(x.status))
          .reduce((a, x) => a + Number(x.n), 0),
        collected: [...collected].map(([currency, amountMinor]) => ({
          currency,
          amountMinor,
        })),
        failedPayments: statusRows
          .filter((x) => x.status === 'failed')
          .reduce((a, x) => a + Number(x.n), 0),
        pendingPayments: statusRows
          .filter((x) => x.status === 'pending')
          .reduce((a, x) => a + Number(x.n), 0),
        refunded: money(
          rowsOf<{ currency: string; amount: unknown }>(refunded),
        ),
        paymentsNeedingRefund: Number(
          rowsOf<{ n: number }>(needRefund)[0]?.n ?? 0,
        ),
        overdueInvoices: overdueRows.reduce((a, r) => a + Number(r.n), 0),
        overdue: money(overdueRows),
        openInvoices: Number(rowsOf<{ n: number }>(open)[0]?.n ?? 0),
      };
    });
  }

  // --- settings -------------------------------------------------------------------------------------------------------------------

  private async readSettings(tx: DbTx): Promise<BillingSettingsDto> {
    const [s] = await tx.select().from(billingSettings);
    return {
      legalName: s.legalName,
      address: s.address,
      gstin: s.gstin,
      taxLabel: s.taxLabel,
      taxRateBps: s.taxRateBps,
      dueDays: s.dueDays,
      graceDays: s.graceDays,
      renewalNoticeDays: s.renewalNoticeDays,
      updatedAt: s.updatedAt,
      paymentsConfigured: this.razorpay.configured,
    };
  }

  getSettings(adminId: string): Promise<BillingSettingsDto> {
    return this.db.withUser(adminId, (tx) => this.readSettings(tx));
  }

  async updateSettings(
    adminId: string,
    v: UpdateBillingSettingsDto,
  ): Promise<BillingSettingsDto> {
    return this.db.withUser(adminId, async (tx) => {
      const before = await this.readSettings(tx);
      const patch: Partial<typeof billingSettings.$inferInsert> = {};
      for (const key of [
        'legalName',
        'address',
        'gstin',
        'taxLabel',
        'taxRateBps',
        'dueDays',
        'graceDays',
        'renewalNoticeDays',
      ] as const) {
        if (v[key] !== undefined && v[key] !== before[key])
          (patch as Record<string, unknown>)[key] = v[key];
      }
      if (Object.keys(patch).length === 0) return before;
      await tx
        .update(billingSettings)
        .set({ ...patch, updatedBy: adminId })
        .where(eq(billingSettings.id, true));
      const after = await this.readSettings(tx);
      const changed = Object.keys(patch) as (keyof BillingSettingsDto)[];
      await recordAudit(tx, {
        action: 'billing.settings_updated',
        entityType: 'billing_settings',
        description: `Updated billing settings: ${changed.join(', ')}`,
        previous: Object.fromEntries(changed.map((k) => [k, before[k]])),
        next: Object.fromEntries(changed.map((k) => [k, after[k]])),
      });
      return after;
    });
  }

  // --- invoice actions ------------------------------------------------------------------------------------------------------------

  async issueInvoice(
    adminId: string,
    tenantId: string,
    period: 'current' | 'next',
  ): Promise<InvoiceDetailDto> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const id = rowsOf<{ id: string }>(
          await tx.execute(
            sql`select public.platform_issue_invoice(${tenantId}::uuid, ${period}) as id`,
          ),
        )[0].id;
        const detail = await this.invoiceDetail(tx, id);
        await recordAudit(tx, {
          action: 'invoice.issued',
          entityType: 'invoice',
          entityId: id,
          organizationId: tenantId,
          description: `Issued invoice ${detail.number} for ${detail.planName} (${detail.currency} ${detail.totalMinor / 100})`,
          next: {
            number: detail.number,
            period: `${detail.periodStart.toISOString()} to ${detail.periodEnd.toISOString()}`,
            totalMinor: detail.totalMinor,
            currency: detail.currency,
          },
        });
        return detail;
      });
    } catch (error) {
      return mapBillingError(error);
    }
  }

  async voidInvoice(
    adminId: string,
    id: string,
    reason: string,
  ): Promise<InvoiceDetailDto> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const before = await this.invoiceDetail(tx, id);
        await tx.execute(
          sql`select public.platform_void_invoice(${id}::uuid, ${reason})`,
        );
        await recordAudit(tx, {
          action: 'invoice.voided',
          entityType: 'invoice',
          entityId: id,
          organizationId: before.tenantId,
          description: `Voided invoice ${before.number}`,
          previous: {
            number: before.number,
            status: before.status,
            totalMinor: before.totalMinor,
          },
          next: { status: 'void', reason },
        });
        return this.invoiceDetail(tx, id);
      });
    } catch (error) {
      return mapBillingError(error);
    }
  }

  async recordManualPayment(
    adminId: string,
    id: string,
    v: ManualPaymentDto,
  ): Promise<InvoiceDetailDto> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const before = await this.invoiceDetail(tx, id);
        const paymentId = rowsOf<{ id: string }>(
          await tx.execute(
            sql`select public.platform_record_manual_payment(${id}::uuid, ${v.reference}, ${v.method}, ${v.note ?? null}) as id`,
          ),
        )[0].id;
        await recordAudit(tx, {
          action: 'payment.manual_recorded',
          entityType: 'payment',
          entityId: paymentId,
          organizationId: before.tenantId,
          description: `Recorded an offline payment for invoice ${before.number} (${v.method})`,
          next: {
            invoice: before.number,
            method: v.method,
            reference: v.reference,
            amountMinor: before.totalMinor,
            currency: before.currency,
          },
        });
        return this.invoiceDetail(tx, id);
      });
    } catch (error) {
      return mapBillingError(error);
    }
  }

  // --- refunds --------------------------------------------------------------------------------------------------------------------

  /**
   * Refunds a successful payment, in full or in part. The refund is reserved in the database first (pending, keyed by `requestId`, so a
   * repeated request is the same refund), then Razorpay is called with the refund's own id as the receipt, then the result is recorded. If
   * Razorpay cannot be reached the refund stays pending: asking again with the same requestId looks it up at Razorpay before sending
   * anything, so a lost response can never refund twice. Offline payments are bookkept only.
   */
  async refundPayment(
    adminId: string,
    paymentId: string,
    v: RefundPaymentDto,
  ): Promise<PaymentDetailDto> {
    const payment = await this.getPayment(adminId, paymentId);
    let amountMinor: number;
    if (v.amount !== undefined) {
      const parsed = parseMoney(v.amount, payment.currency);
      if (parsed === null || parsed < 1)
        throw invalid('Enter a valid amount.', {
          amount: `Not a valid amount in ${payment.currency}`,
        });
      amountMinor = parsed;
    } else {
      amountMinor = payment.amountMinor - payment.refundedMinor;
    }

    let begun: {
      refundId: string;
      created: boolean;
      status: string;
      provider: string;
      razorpayPaymentId: string | null;
      amountMinor: number;
    };
    try {
      begun = await this.db.withUser(
        adminId,
        async (tx) =>
          rowsOf<{ r: typeof begun }>(
            await tx.execute(
              sql`select public.platform_refund_begin(${paymentId}::uuid, ${amountMinor}::bigint, ${v.reason}, ${v.requestId}) as r`,
            ),
          )[0].r,
      );
    } catch (error) {
      return mapBillingError(error);
    }
    if (begun.status !== 'pending') return this.getPayment(adminId, paymentId);

    let outcome: {
      id: string | null;
      status: 'pending' | 'processed' | 'failed';
      failure: string | null;
    } = {
      id: null,
      status: 'processed',
      failure: null,
    };
    if (begun.provider === 'razorpay') {
      if (!begun.razorpayPaymentId)
        throw conflict(
          'That payment has no Razorpay payment to refund.',
          undefined,
          'PAYMENT_NOT_REFUNDABLE',
        );
      // After an unclear earlier attempt, look the refund up by its receipt before sending it again.
      const existing = begun.created
        ? undefined
        : (await this.razorpay.fetchRefunds(begun.razorpayPaymentId)).find(
            (r) => r.receipt === begun.refundId,
          );
      try {
        const r =
          existing ??
          (await this.razorpay.createRefund(begun.razorpayPaymentId, {
            amountMinor: begun.amountMinor,
            receipt: begun.refundId,
            reason: v.reason,
          }));
        outcome = {
          id: r.id,
          status:
            r.status === 'processed'
              ? 'processed'
              : r.status === 'failed'
                ? 'failed'
                : 'pending',
          failure: null,
        };
      } catch (error) {
        // Nothing is known about the outcome: leave it pending (the webhook or a repeat of the same request settles it).
        this.logger.warn(
          `refund ${begun.refundId} left pending after a provider error`,
        );
        throw error;
      }
    }

    try {
      return await this.db.withUser(adminId, async (tx) => {
        await tx.execute(
          sql`select public.platform_refund_finish(${begun.refundId}::uuid, ${outcome.id}, ${outcome.status}, ${outcome.failure})`,
        );
        await recordAudit(tx, {
          action:
            outcome.status === 'failed'
              ? 'payment.refund_failed'
              : 'payment.refunded',
          entityType: 'payment',
          entityId: paymentId,
          organizationId: payment.tenantId,
          description: `${outcome.status === 'failed' ? 'Refund failed' : 'Refund started'} for invoice ${payment.invoiceNumber} (${payment.currency} ${begun.amountMinor / 100})`,
          next: {
            invoice: payment.invoiceNumber,
            amountMinor: begun.amountMinor,
            currency: payment.currency,
            status: outcome.status,
            reason: v.reason,
          },
        });
        return this.getPaymentInTx(tx, paymentId);
      });
    } catch (error) {
      return mapBillingError(error);
    }
  }

  private async getPaymentInTx(
    tx: DbTx,
    id: string,
  ): Promise<PaymentDetailDto> {
    const [row] = await tx
      .select({ p: billingPayments, i: billingInvoices })
      .from(billingPayments)
      .innerJoin(
        billingInvoices,
        eq(billingInvoices.id, billingPayments.invoiceId),
      )
      .where(eq(billingPayments.id, id));
    if (!row) throw paymentNotFound();
    const refunds = await tx
      .select()
      .from(billingRefunds)
      .where(eq(billingRefunds.paymentId, id))
      .orderBy(desc(billingRefunds.createdAt));
    return { ...toPaymentDto(row.p, row.i), refunds: refunds.map(toRefundDto) };
  }

  // --- renewals -------------------------------------------------------------------------------------------------------------------

  /** Issues invoices for upcoming renewals and moves unpaid subscriptions to past due and expired. Safe to run again at any time. */
  async runBilling(adminId: string): Promise<BillingRunDto> {
    try {
      return await this.db.withUser(adminId, async (tx) => {
        const r = rowsOf<{ r: BillingRunDto }>(
          await tx.execute(sql`select public.platform_run_billing() as r`),
        )[0].r;
        if (r.invoicesIssued || r.markedPastDue || r.expired)
          await recordAudit(tx, {
            action: 'billing.run_completed',
            entityType: 'billing_settings',
            description: `Billing run: ${r.invoicesIssued} invoices issued, ${r.markedPastDue} marked past due, ${r.expired} expired`,
            next: { ...r },
          });
        return r;
      });
    } catch (error) {
      return mapBillingError(error);
    }
  }

  /** The scheduler's run: no user, the database function refuses everything but the application. */
  scheduledRun(): Promise<BillingRunDto> {
    return this.db.withPublic(
      async (tx) =>
        rowsOf<{ r: BillingRunDto }>(
          await tx.execute(sql`select public.billing_run_scheduled() as r`),
        )[0].r,
    );
  }
}
