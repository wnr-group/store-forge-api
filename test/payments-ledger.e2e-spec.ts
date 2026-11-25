import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import {
  createPaymentsWorld,
  orderBody,
  type PaymentsWorld,
} from './support/payments-world.js';
import { migrationsAvailable } from './support/pglite.js';

async function failure(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe.skipIf(!migrationsAvailable)(
  'payment transactions and refunds (migration 0048)',
  () => {
    let p: PaymentsWorld;
    let n = 0;
    const rkey = () => `refund-key-${String(++n).padStart(6, '0')}`;

    beforeAll(async () => {
      p = await createPaymentsWorld();
      await p.connectRazorpay();
    });
    afterAll(() => p.t.close());

    describe('refunds', () => {
      it('refunds a payment in full and marks the order refunded', async () => {
        await p.product(p.w.tenantA, 'refund-full', 5, 50000);
        const { placed, transactionId, payment } = await p.paidOrder(
          'refund-full',
          2,
        );
        const refund = await p.refunds.create(
          p.owner(),
          transactionId,
          { reason: 'Customer changed their mind' },
          rkey(),
        );
        expect(refund).toMatchObject({
          amountMinor: 100000,
          status: 'processed',
          source: 'storeforge',
          orderNumber: placed.orderNumber,
        });
        expect(refund.razorpayRefundId).toMatch(/^rfnd_/);
        expect(p.fake.refunds.get(refund.razorpayRefundId!)).toMatchObject({
          payment_id: payment.id,
          amount: 100000,
          receipt: refund.id,
        });
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { payment_status: 'refunded' },
        );
      });

      it('supports partial refunds that add up, and never refunds more than was received', async () => {
        await p.product(p.w.tenantA, 'refund-part', 5, 50000);
        const { placed, transactionId } = await p.paidOrder('refund-part', 2); // 1000.00
        const first = await p.refunds.create(
          p.owner(),
          transactionId,
          { amountMinor: 30000, reason: 'Damaged item' },
          rkey(),
        );
        expect(first.amountMinor).toBe(30000);
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { payment_status: 'partially_refunded' },
        );

        const tooMuch = await failure(
          p.refunds.create(
            p.owner(),
            transactionId,
            { amountMinor: 80000, reason: 'x' },
            rkey(),
          ),
        );
        expect(tooMuch.code).toBe('REFUND_EXCEEDS_PAYMENT');
        expect(tooMuch.details).toEqual({ refundableMinor: 70000 });

        // "Full refund" now means the remainder, and the total lands exactly on the amount received.
        const rest = await p.refunds.create(
          p.owner(),
          transactionId,
          { reason: 'Rest of the order' },
          rkey(),
        );
        expect(rest.amountMinor).toBe(70000);
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { payment_status: 'refunded' },
        );
        expect(
          (
            await failure(
              p.refunds.create(
                p.owner(),
                transactionId,
                { reason: 'again' },
                rkey(),
              ),
            )
          ).code,
        ).toBe('NOTHING_TO_REFUND');
      });

      it('returns the same refund for the same Idempotency-Key and never refunds twice', async () => {
        await p.product(p.w.tenantA, 'refund-idem', 5, 50000);
        const { transactionId } = await p.paidOrder('refund-idem', 1);
        const k = rkey();
        const a = await p.refunds.create(
          p.owner(),
          transactionId,
          { amountMinor: 10000, reason: 'Late delivery' },
          k,
        );
        const b = await p.refunds.create(
          p.owner(),
          transactionId,
          { amountMinor: 10000, reason: 'Late delivery' },
          k,
        );
        expect(b.id).toBe(a.id);
        expect(
          [...p.fake.refunds.values()].filter((r) => r.receipt === a.id),
        ).toHaveLength(1);
        // The same key for a different amount is a mistake, not a replay.
        expect(
          (
            await failure(
              p.refunds.create(
                p.owner(),
                transactionId,
                { amountMinor: 20000, reason: 'x' },
                k,
              ),
            )
          ).code,
        ).toBe('IDEMPOTENCY_KEY_REUSED');
      });

      it('needs an Idempotency-Key', async () => {
        await p.product(p.w.tenantA, 'refund-nokey', 5);
        const { transactionId } = await p.paidOrder('refund-nokey', 1);
        expect(
          (
            await failure(
              p.refunds.create(
                p.owner(),
                transactionId,
                { reason: 'x' },
                undefined,
              ),
            )
          ).code,
        ).toBe('IDEMPOTENCY_KEY_REQUIRED');
      });

      it('survives a lost response: the refund is found by its receipt, not sent twice', async () => {
        await p.product(p.w.tenantA, 'refund-lost', 5, 50000);
        const { transactionId, payment } = await p.paidOrder('refund-lost', 1);
        const k = rkey();
        p.fake.loseNextRefundResponse = true;
        const first = await failure(
          p.refunds.create(
            p.owner(),
            transactionId,
            { amountMinor: 20000, reason: 'Lost answer' },
            k,
          ),
        );
        expect(first.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
        // Razorpay did create it; we only never heard.
        expect(
          [...p.fake.refunds.values()].filter(
            (r) => r.payment_id === payment.id,
          ),
        ).toHaveLength(1);
        const saved = await p.t.asOwner(
          async (pg) =>
            (
              await pg.query<{ status: string }>(
                `select status from refunds where idempotency_key = $1`,
                [k],
              )
            ).rows[0],
        );
        expect(saved.status).toBe('pending');

        const again = await p.refunds.create(
          p.owner(),
          transactionId,
          { amountMinor: 20000, reason: 'Lost answer' },
          k,
        );
        expect(again.status).toBe('processed');
        expect(
          [...p.fake.refunds.values()].filter(
            (r) => r.payment_id === payment.id,
          ),
        ).toHaveLength(1);
      });

      it('a refund Razorpay refuses is recorded as failed and the amount becomes refundable again', async () => {
        await p.product(p.w.tenantA, 'refund-refused', 5, 50000);
        const { placed, transactionId } = await p.paidOrder(
          'refund-refused',
          1,
        );
        p.fake.rejectNextRefundWith = 400;
        const refused = await p.refunds.create(
          p.owner(),
          transactionId,
          { reason: 'Try' },
          rkey(),
        );
        expect(refused).toMatchObject({ status: 'failed' });
        expect(refused.failureReason).toMatch(/not valid/);
        expect(await p.orderRow(p.w.tenantA, placed.orderNumber)).toMatchObject(
          { payment_status: 'paid' },
        );
        const retry = await p.refunds.create(
          p.owner(),
          transactionId,
          { reason: 'Try again' },
          rkey(),
        );
        expect(retry.status).toBe('processed');
      });

      it('keeps a refund "processing" until Razorpay finishes it, then syncs it', async () => {
        await p.product(p.w.tenantA, 'refund-slow', 5, 50000);
        const { placed, transactionId } = await p.paidOrder('refund-slow', 1);
        p.fake.refundStartsAs = 'pending';
        try {
          const slow = await p.refunds.create(
            p.owner(),
            transactionId,
            { reason: 'Slow bank' },
            rkey(),
          );
          expect(slow.status).toBe('processing');
          expect(
            await p.orderRow(p.w.tenantA, placed.orderNumber),
          ).toMatchObject({ payment_status: 'refunded' });
          p.fake.refunds.get(slow.razorpayRefundId!)!.status = 'processed';
          const synced = await p.refunds.sync(p.owner(), slow.id);
          expect(synced.status).toBe('processed');
          expect(synced.processedAt).toBeInstanceOf(Date);
        } finally {
          p.fake.refundStartsAs = 'processed';
        }
      });

      it('clears the "needs a refund" flag once a flagged payment is fully refunded', async () => {
        await p.product(p.w.tenantA, 'refund-flagged', 5, 50000);
        const { transactionId } = await p.paidOrder('refund-flagged', 1);
        await p.t.asOwner((pg) =>
          pg.query(
            'update payment_transactions set refund_required = true where id = $1',
            [transactionId],
          ),
        );
        await p.refunds.create(
          p.owner(),
          transactionId,
          { reason: 'Sold out' },
          rkey(),
        );
        expect(
          (await p.transactions.get(p.owner(), transactionId)).refundRequired,
        ).toBe(false);
      });

      it('cannot refund cash on delivery here, an unpaid payment, or someone else’s payment', async () => {
        await p.cod.save(p.owner(), {
          enabled: true,
          minOrderMinor: 0,
          maxOrderMinor: null,
          feeMinor: 0,
        });
        await p.product(p.w.tenantA, 'refund-cod', 5);
        const cod = await p.checkout.placeOrder(
          'alpha-shop',
          orderBody('refund-cod', 1, 'cod'),
          p.key(),
        );
        const codTx = (await p.txOf(p.w.tenantA, cod.orderNumber))!
          .id as string;
        expect(
          (
            await failure(
              p.refunds.create(p.owner(), codTx, { reason: 'x' }, rkey()),
            )
          ).code,
        ).toBe('COD_REFUND_MANUAL');

        await p.product(p.w.tenantA, 'refund-unpaid', 5);
        const { placed } = await p.startOnline('refund-unpaid');
        const unpaidTx = (await p.txOf(p.w.tenantA, placed.orderNumber))!
          .id as string;
        expect(
          (
            await failure(
              p.refunds.create(p.owner(), unpaidTx, { reason: 'x' }, rkey()),
            )
          ).code,
        ).toBe('NOT_REFUNDABLE');

        await p.product(p.w.tenantA, 'refund-foreign', 5);
        const { transactionId } = await p.paidOrder('refund-foreign');
        expect(
          (
            await failure(
              p.refunds.create(
                p.ownerB(),
                transactionId,
                { reason: 'x' },
                rkey(),
              ),
            )
          ).code,
        ).toBe('TRANSACTION_NOT_FOUND');
      });

      it('lets a fully refunded order be cancelled, which a paid one never could', async () => {
        await p.product(p.w.tenantA, 'refund-cancel', 5, 50000);
        const { placed, transactionId } = await p.paidOrder('refund-cancel');
        const id = (await p.one<string>(
          'select id as v from orders where tenant_id = $1 and order_number = $2',
          [p.w.tenantA, placed.orderNumber],
        ))!;
        expect(
          (
            await failure(
              p.orders.cancel(p.owner(), id, { reason: 'Changed mind' }),
            )
          ).code,
        ).toBe('REFUND_REQUIRED');
        await p.refunds.create(
          p.owner(),
          transactionId,
          { reason: 'Changed mind' },
          rkey(),
        );
        const cancelled = await p.orders.cancel(p.owner(), id, {
          reason: 'Changed mind',
        });
        expect(cancelled.status).toBe('cancelled');
      });
    });

    describe('transaction history', () => {
      it('lists transactions with refund state, and filters by status, provider, method and refund state', async () => {
        const all = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
        } as never);
        expect(all.items.length).toBeGreaterThan(5);
        expect(all.items.every((t) => t.currency === 'INR')).toBe(true);

        const full = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
          refundStatus: 'full',
        } as never);
        expect(full.items.length).toBeGreaterThan(0);
        expect(
          full.items.every(
            (t) =>
              t.refundStatus === 'full' && t.refundedMinor === t.amountMinor,
          ),
        ).toBe(true);

        const partial = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
          refundStatus: 'partial',
        } as never);
        expect(
          partial.items.every(
            (t) => t.refundedMinor > 0 && t.refundedMinor < t.amountMinor,
          ),
        ).toBe(true);

        const cod = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
          provider: 'cod',
        } as never);
        expect(cod.items.length).toBeGreaterThan(0);
        expect(
          cod.items.every(
            (t) => t.provider === 'cod' && t.status === 'pending_collection',
          ),
        ).toBe(true);

        const upi = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
          method: 'upi',
          status: 'captured',
        } as never);
        expect(
          upi.items.every((t) => t.method === 'upi' && t.status === 'captured'),
        ).toBe(true);
      });

      it('searches by order number and by Razorpay ids, and paginates', async () => {
        await p.product(p.w.tenantA, 'history-search', 5);
        const { placed, session, payment } = await p.paidOrder(
          'history-search',
          1,
          'search@example.test',
        );
        const byOrder = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 10,
          search: String(placed.orderNumber),
          sortOrder: 'desc',
        } as never);
        expect(byOrder.items.map((t) => t.orderNumber)).toContain(
          placed.orderNumber,
        );
        const byPay = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 10,
          search: payment.id,
          sortOrder: 'desc',
        } as never);
        expect(byPay.items).toHaveLength(1);
        expect(byPay.items[0]).toMatchObject({
          razorpayOrderId: session.razorpayOrderId,
          razorpayPaymentId: payment.id,
          status: 'captured',
        });

        const page1 = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 2,
          search: '',
          sortOrder: 'desc',
        } as never);
        const page2 = await p.transactions.list(p.owner(), {
          page: 2,
          limit: 2,
          search: '',
          sortOrder: 'desc',
        } as never);
        expect(page1.items).toHaveLength(2);
        expect(page2.items.map((t) => t.id)).not.toEqual(
          page1.items.map((t) => t.id),
        );
        expect(
          page1.meta?.total ?? (page1 as never as { total: number }).total,
        ).toBeGreaterThan(2);
      });

      it('filters by date range', async () => {
        const future = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 10,
          search: '',
          sortOrder: 'desc',
          from: '2100-01-01T00:00:00Z',
        } as never);
        expect(future.items).toEqual([]);
        const past = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 10,
          search: '',
          sortOrder: 'desc',
          to: '2000-01-01T00:00:00Z',
        } as never);
        expect(past.items).toEqual([]);
      });

      it('shows a transaction in full: failure reason, refunds and what Razorpay reported', async () => {
        await p.product(p.w.tenantA, 'history-detail', 5);
        const { placed, session, token } =
          await p.startOnline('history-detail');
        const failed = p.fake.pay(session.razorpayOrderId, 'failed');
        await p.razorpay.reportFailure(
          'alpha-shop',
          placed.orderNumber,
          token,
          {
            razorpay_order_id: session.razorpayOrderId,
            razorpay_payment_id: failed.id,
          },
        );
        const id = (await p.txOf(p.w.tenantA, placed.orderNumber))!
          .id as string;
        const detail = await p.transactions.get(p.owner(), id);
        expect(detail).toMatchObject({
          status: 'failed',
          attempts: 1,
          failureCode: 'BAD_REQUEST_ERROR',
          failureDescription: 'Payment failed at the bank',
          refunds: [],
        });
        expect(detail.orderNumber).toBe(placed.orderNumber);
      });

      it('never shows another organization’s transactions', async () => {
        const mine = await p.transactions.list(p.owner(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
        } as never);
        const theirs = await p.transactions.list(p.ownerB(), {
          page: 1,
          limit: 100,
          search: '',
          sortOrder: 'desc',
        } as never);
        expect(theirs.items).toEqual([]);
        expect(mine.items.length).toBeGreaterThan(0);
        const someId = mine.items[0].id;
        expect(
          (await failure(p.transactions.get(p.ownerB(), someId))).code,
        ).toBe('TRANSACTION_NOT_FOUND');
      });
    });
  },
);
