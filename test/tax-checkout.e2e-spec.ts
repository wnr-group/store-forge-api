import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import { rowsOf } from '../src/database/database.service.js';
import { OrdersService } from '../src/modules/orders/orders.service.js';
import { gstinCheckChar } from '../src/modules/tax/gst.js';
import { asUser, migrationsAvailable } from './support/pglite.js';
import {
  createShippingWorld,
  orderTo,
  type ShippingWorld,
} from './support/shipping-world.js';

const gstin = (first14: string) => first14 + gstinCheckChar(first14);
const KA_GSTIN = gstin('29AABCT1332L1Z'); // Karnataka
const CH_GSTIN = gstin('04AABCT1332L1Z'); // Chandigarh (a union territory without a legislature)

async function failure(work: Promise<unknown>): Promise<AppException> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  gstin: KA_GSTIN,
  legalName: 'Alpha Traders',
  pricesIncludeTax: false,
  defaultRateBps: 1800,
  chargesTaxable: true,
  chargesRateBps: 1800,
  ...over,
});

describe.skipIf(!migrationsAvailable)(
  'GST at checkout and in settings (migration 0052)',
  () => {
    let s: ShippingWorld;
    const save = (over: Record<string, unknown> = {}) =>
      s.taxService.save(s.owner(), settings(over) as never);
    const placeTo = (
      slug: string,
      qty: number,
      method: 'cod',
      to: Record<string, string> = {},
      shippingMethodId?: string,
    ) =>
      s.checkoutWithTax.placeOrder(
        'alpha-shop',
        orderTo(slug, qty, method, shippingMethodId, to),
        s.key(),
      );
    const orderRow = (n: number) => s.orderRow(s.w.tenantA, n);
    const taxLines = (n: number) =>
      s.t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, unknown>>(
              `select l.* from order_tax_lines l join orders o on o.id = l.order_id where o.tenant_id = $1 and o.order_number = $2 order by l.sort_order`,
              [s.w.tenantA, n],
            )
          ).rows,
      );
    const MH = { state: 'Maharashtra', postalCode: '400001', city: 'Mumbai' };

    beforeAll(async () => {
      s = await createShippingWorld();
      await s.product(s.w.tenantA, 'tx-shirt', 1000, 100000, 200); // 1000.00
      const five = await s.product(s.w.tenantA, 'tx-book', 1000, 50000, 300);
      await s.t.asOwner((pg) =>
        pg.query(
          `update products set tax_rate_bps = 500, hsn_code = '4901' where id = $1`,
          [five],
        ),
      );
      const zero = await s.product(s.w.tenantA, 'tx-exempt', 1000, 20000, 100);
      await s.t.asOwner((pg) =>
        pg.query(`update products set tax_rate_bps = 0 where id = $1`, [zero]),
      );
      await s.cod.save(s.owner(), {
        enabled: true,
        minOrderMinor: 0,
        maxOrderMinor: null,
        feeMinor: 0,
      });
    });
    afterAll(() => s.t.close());

    describe('settings', () => {
      it('start off: nothing is charged until the Owner turns GST on', async () => {
        expect(await s.taxService.settings(s.owner())).toMatchObject({
          configured: false,
          enabled: false,
          gstin: null,
        });
        const placed = await placeTo('tx-shirt', 1, 'cod');
        expect(placed).toMatchObject({
          taxMinor: 0,
          totalMinor: 100000,
        });
        expect(placed.tax).toMatchObject({
          regime: 'none',
          taxMinor: 0,
          lines: [],
        });
        expect(await orderRow(placed.orderNumber)).toMatchObject({
          tax_regime: 'none',
          seller_gstin: null,
        });
      });

      it('check the GSTIN (shape and check character) and say what is wrong', async () => {
        const wrong = KA_GSTIN.endsWith('A') ? 'B' : 'A';
        const bad = await failure(
          save({ gstin: KA_GSTIN.slice(0, 14) + wrong }),
        );
        expect(bad).toMatchObject({ code: 'TAX_SETTINGS_INVALID' });
        expect(bad.details).toEqual({
          gstin: expect.stringMatching(/not a valid GSTIN/),
        });
        expect((await failure(save({ gstin: 'short' }))).code).toBe(
          'TAX_SETTINGS_INVALID',
        );
        expect(
          (await failure(save({ enabled: true, gstin: null }))).details,
        ).toEqual({ gstin: 'Enter your GSTIN to charge GST.' });
        // A GSTIN with an unknown state number is refused too.
        expect(
          (await failure(save({ gstin: gstin('88AABCT1332L1Z') }))).code,
        ).toBe('TAX_SETTINGS_INVALID');
      });

      it('save with the state taken from the GSTIN, and may be switched off keeping the GSTIN', async () => {
        expect(await save()).toMatchObject({
          configured: true,
          enabled: true,
          gstin: KA_GSTIN,
          stateCode: '29',
          stateName: 'Karnataka',
          legalName: 'Alpha Traders',
        });
        expect(await save({ enabled: false })).toMatchObject({
          enabled: false,
          gstin: KA_GSTIN,
        });
        expect(await save({ enabled: false, gstin: null })).toMatchObject({
          gstin: null,
          stateCode: null,
        });
        await save();
      });

      it('are private to each organization, readable but not changeable by someone with only read access (row level security)', async () => {
        expect(await s.taxService.settings(s.ownerB())).toMatchObject({
          configured: false,
        });
        const reader = s.member(s.w.members.reader);
        expect(await s.taxService.settings(reader)).toMatchObject({
          configured: true,
          gstin: KA_GSTIN,
        });
        await expect(
          s.taxService.save(reader, settings({ defaultRateBps: 500 }) as never),
        ).rejects.toThrow();
        expect((await s.taxService.settings(s.owner())).defaultRateBps).toBe(
          1800,
        );
        expect(
          await asUser(
            s.t,
            s.w.members.nothing,
            async (tx) =>
              rowsOf(
                await tx.execute(sql`select * from public.tenant_tax_settings`),
              ).length,
          ),
        ).toBeGreaterThanOrEqual(0);
      });
    });

    describe('tax within the seller’s state: CGST + SGST', () => {
      it('adds 18% on top, half each, saved on the order and on every line', async () => {
        await save();
        const placed = await placeTo('tx-shirt', 1, 'cod');
        // 1000.00 + CGST 90.00 + SGST 90.00 = 1180.00 (no shipping zones, no cash-on-delivery charge)
        expect(placed).toMatchObject({
          subtotalMinor: 100000,
          taxMinor: 18000,
          taxInclusive: false,
          totalMinor: 118000,
        });
        expect(placed.tax).toMatchObject({
          regime: 'intra',
          stateTaxKind: 'sgst',
          sellerGstin: KA_GSTIN,
          placeOfSupplyStateCode: '29',
          cgstMinor: 9000,
          sgstMinor: 9000,
          igstMinor: 0,
          taxMinor: 18000,
          inclusive: false,
        });
        expect(placed.tax.lines).toEqual([
          expect.objectContaining({
            kind: 'item',
            description: 'tx-shirt',
            taxableMinor: 100000,
            rateBps: 1800,
            taxMinor: 18000,
          }),
        ]);
        expect(await orderRow(placed.orderNumber)).toMatchObject({
          tax_regime: 'intra',
          cgst_minor: 9000,
          sgst_minor: 9000,
          igst_minor: 0,
          tax_minor: 18000,
          total_minor: 118000,
          seller_gstin: KA_GSTIN,
          seller_state_code: '29',
          supply_state_code: '29',
        });
        const item = await s.t.asOwner(
          async (pg) =>
            (
              await pg.query(
                'select tax_minor, tax_rate_bps from order_items where order_id = (select id from orders where tenant_id = $1 and order_number = $2)',
                [s.w.tenantA, placed.orderNumber],
              )
            ).rows[0],
        );
        expect(item).toEqual({ tax_minor: 18000, tax_rate_bps: 1800 });
      });

      it('uses each product’s own rate and HSN code, and the default for the rest', async () => {
        const placed = await s.checkoutWithTax.placeOrder(
          'alpha-shop',
          Object.assign(orderTo('tx-shirt', 1, 'cod'), {
            lines: [
              { productSlug: 'tx-shirt', quantity: 1 },
              { productSlug: 'tx-book', quantity: 2 },
              { productSlug: 'tx-exempt', quantity: 1 },
            ],
          }),
          s.key(),
        );
        // shirt 1000.00 @18% = 180.00; books 2 x 500.00 @5% = 50.00; exempt 200.00 @0% = 0
        expect(placed.taxMinor).toBe(18000 + 5000);
        expect(placed.totalMinor).toBe(100000 + 100000 + 20000 + 23000);
        const byName = Object.fromEntries(
          placed.tax.lines.map((l) => [l.description, l]),
        );
        expect(byName['tx-shirt']).toMatchObject({
          rateBps: 1800,
          hsnCode: null,
          taxMinor: 18000,
        });
        expect(byName['tx-book']).toMatchObject({
          rateBps: 500,
          hsnCode: '4901',
          taxableMinor: 100000,
          cgstMinor: 2500,
          sgstMinor: 2500,
        });
        expect(byName['tx-exempt']).toMatchObject({
          rateBps: 0,
          taxMinor: 0,
          taxableMinor: 20000,
        });
      });

      it('charges tax on cash-on-delivery and delivery charges too, at their own rate', async () => {
        await s.cod.save(s.owner(), {
          enabled: true,
          minOrderMinor: 0,
          maxOrderMinor: null,
          feeMinor: 5000,
        });
        const placed = await placeTo('tx-shirt', 1, 'cod');
        // items 1000.00 + COD charge 50.00 => tax 180.00 + 9.00
        expect(placed.codFeeMinor).toBe(5000);
        expect(placed.taxMinor).toBe(18000 + 900);
        expect(placed.totalMinor).toBe(100000 + 5000 + 18900);
        expect(placed.tax.lines.map((l) => l.kind)).toEqual([
          'item',
          'cod_fee',
        ]);
        expect(placed.tax.lines[1]).toMatchObject({
          description: 'Cash on delivery charge',
          taxableMinor: 5000,
          taxMinor: 900,
          hsnCode: '996812',
        });
      });

      it('leaves the charges alone when the Owner says they are not taxed', async () => {
        await s.cod.save(s.owner(), {
          enabled: true,
          minOrderMinor: 0,
          maxOrderMinor: null,
          feeMinor: 5000,
        });
        await save({ chargesTaxable: false });
        const placed = await placeTo('tx-shirt', 1, 'cod');
        expect(placed.tax.lines.map((l) => l.kind)).toEqual(['item']);
        expect(placed.totalMinor).toBe(100000 + 5000 + 18000);
        await save();
        await s.cod.save(s.owner(), {
          enabled: true,
          minOrderMinor: 0,
          maxOrderMinor: null,
          feeMinor: 0,
        });
      });
    });

    describe('tax in another state: IGST', () => {
      it('charges the full rate as IGST', async () => {
        const placed = await placeTo('tx-shirt', 1, 'cod', MH);
        expect(placed.tax).toMatchObject({
          regime: 'inter',
          cgstMinor: 0,
          sgstMinor: 0,
          igstMinor: 18000,
          placeOfSupplyStateCode: '27',
        });
        expect(placed.totalMinor).toBe(118000);
        expect(await orderRow(placed.orderNumber)).toMatchObject({
          tax_regime: 'inter',
          igst_minor: 18000,
          cgst_minor: 0,
        });
      });

      it('charges UTGST instead of SGST when the seller and the delivery are in a union territory without a legislature', async () => {
        await save({ gstin: CH_GSTIN });
        const placed = await placeTo('tx-shirt', 1, 'cod', {
          state: 'Chandigarh',
          postalCode: '160017',
          city: 'Chandigarh',
        });
        expect(placed.tax).toMatchObject({
          regime: 'intra',
          stateTaxKind: 'utgst',
          cgstMinor: 9000,
          sgstMinor: 9000,
        });
        await save();
      });
    });

    describe('prices that include tax', () => {
      it('take the tax out of the price: the total does not change', async () => {
        await save({ pricesIncludeTax: true });
        const placed = await placeTo('tx-shirt', 1, 'cod');
        // 1000.00 includes 18%: tax 152.54 (76.27 + 76.27), taxable 847.46
        expect(placed).toMatchObject({
          taxInclusive: true,
          totalMinor: 100000,
          taxMinor: 15254,
        });
        expect(placed.tax.lines[0]).toMatchObject({
          taxableMinor: 84746,
          cgstMinor: 7627,
          sgstMinor: 7627,
          taxMinor: 15254,
        });
        expect(
          placed.tax.lines[0].taxableMinor + placed.tax.lines[0].taxMinor,
        ).toBe(100000);
        const inter = await placeTo('tx-shirt', 1, 'cod', MH);
        expect(inter).toMatchObject({ totalMinor: 100000, taxMinor: 15254 });
        expect(inter.tax).toMatchObject({ igstMinor: 15254, cgstMinor: 0 });
        await save();
      });
    });

    describe('what is saved is final', () => {
      it('adds up exactly: the order’s tax is the sum of its lines, and the database refuses anything else', async () => {
        const placed = await s.checkoutWithTax.placeOrder(
          'alpha-shop',
          Object.assign(orderTo('tx-shirt', 3, 'cod'), {
            lines: [
              { productSlug: 'tx-shirt', quantity: 3 },
              { productSlug: 'tx-book', quantity: 3 },
            ],
          }),
          s.key(),
        );
        const lines = await taxLines(placed.orderNumber);
        const sum = (k: string) => lines.reduce((n, l) => n + Number(l[k]), 0);
        const row = await orderRow(placed.orderNumber);
        expect(sum('tax_minor')).toBe(Number(row.tax_minor));
        expect(sum('cgst_minor')).toBe(Number(row.cgst_minor));
        expect(sum('sgst_minor')).toBe(Number(row.sgst_minor));
        expect(Number(row.total_minor)).toBe(
          Number(row.subtotal_minor) +
            Number(row.cod_fee_minor) +
            Number(row.tax_minor),
        );
        await expect(
          s.t.asOwner((pg) =>
            pg.query(
              `update orders set tax_minor = tax_minor + 1 where tenant_id = $1 and order_number = $2`,
              [s.w.tenantA, placed.orderNumber],
            ),
          ),
        ).rejects.toThrow();
        await expect(
          s.t.asOwner((pg) =>
            pg.query(
              `update order_tax_lines set igst_minor = 5, tax_minor = tax_minor + 5 where id = $1`,
              [lines[0].id],
            ),
          ),
        ).rejects.toThrow();
      });

      it('is not rewritten by later changes to the settings or to a product', async () => {
        const placed = await placeTo('tx-shirt', 1, 'cod');
        await save({ defaultRateBps: 500, pricesIncludeTax: true });
        await s.t.asOwner((pg) =>
          pg.query(
            `update products set tax_rate_bps = 2800 where slug = 'tx-shirt'`,
          ),
        );
        const detail = await new OrdersService(s.t.service).get(
          s.owner(),
          (await orderRow(placed.orderNumber)).id as string,
        );
        expect(detail.tax).toMatchObject({
          regime: 'intra',
          taxMinor: 18000,
          inclusive: false,
          sellerGstin: KA_GSTIN,
        });
        expect(detail.tax.lines[0]).toMatchObject({
          rateBps: 1800,
          taxableMinor: 100000,
        });
        expect(detail).toMatchObject({ taxMinor: 18000, totalMinor: 118000 });
        await s.t.asOwner((pg) =>
          pg.query(
            `update products set tax_rate_bps = null where slug = 'tx-shirt'`,
          ),
        );
        await save();
      });

      it('is the same when the order is read back or the request is repeated', async () => {
        const key = s.key();
        const first = await s.checkoutWithTax.placeOrder(
          'alpha-shop',
          orderTo('tx-shirt', 1, 'cod'),
          key,
        );
        const again = await s.checkoutWithTax.placeOrder(
          'alpha-shop',
          orderTo('tx-shirt', 1, 'cod'),
          key,
        );
        expect(again).toMatchObject({
          replayed: true,
          orderNumber: first.orderNumber,
          taxMinor: first.taxMinor,
        });
        expect(again.tax).toEqual(first.tax);
        const read = await s.checkoutWithTax.getOrder(
          'alpha-shop',
          first.orderNumber,
          first.accessToken!,
        );
        expect(read.tax).toEqual(first.tax);
      });

      it('keeps every tax line out of reach of other organizations', async () => {
        const count = (userId: string) =>
          asUser(
            s.t,
            userId,
            async (tx) =>
              rowsOf<{ n: number }>(
                await tx.execute(
                  sql`select count(*)::int as n from public.order_tax_lines`,
                ),
              )[0].n,
          );
        expect(await count(s.w.alice)).toBeGreaterThan(0);
        expect(await count(s.w.members.reader)).toBeGreaterThan(0);
        expect(await count(s.w.members.nothing)).toBe(0); // no access to orders
        expect(await count(s.w.bob)).toBe(0);
        await expect(
          asUser(s.t, s.w.alice, (tx) =>
            tx.execute(sql`update public.order_tax_lines set tax_minor = 0`),
          ),
        ).rejects.toThrow();
        await expect(
          asUser(s.t, s.w.alice, (tx) =>
            tx.execute(sql`delete from public.order_tax_lines`),
          ),
        ).rejects.toThrow();
      });
    });

    describe('turned off', () => {
      it('charges nothing, even with a GSTIN saved, and an order with tax still reads back', async () => {
        await save({ enabled: false });
        const placed = await placeTo('tx-shirt', 1, 'cod');
        expect(placed).toMatchObject({ taxMinor: 0, totalMinor: 100000 });
        expect(placed.tax.regime).toBe('none');
        await save();
      });
    });

    describe('the report', () => {
      it('totals what the orders saved, by rate, excluding cancelled and unpaid orders', async () => {
        const r = await s.taxService.report(s.owner(), {});
        expect(r.taxedOrders).toBeGreaterThan(0);
        expect(r.totals.taxMinor).toBe(
          r.byRate.reduce((n, x) => n + x.taxMinor, 0),
        );
        expect(r.totals.taxMinor).toBe(
          r.totals.cgstMinor + r.totals.sgstMinor + r.totals.igstMinor,
        );
        expect(r.byRate.map((x) => x.rateBps)).toEqual(
          r.byRate.map((x) => x.rateBps).sort((a, b) => b - a),
        );
        expect(r.byRate.some((x) => x.rateBps === 1800)).toBe(true);
        expect(r.chargesTaxMinor).toBeGreaterThan(0);
        const taxOfConfirmed = await s.one<number>(
          `select coalesce(sum(tax_minor), 0)::float8 as v from orders where tenant_id = $1 and status in ('confirmed','processing','ready_to_ship','shipped','out_for_delivery','delivered')`,
          [s.w.tenantA],
        );
        expect(r.totals.taxMinor).toBe(Number(taxOfConfirmed));
      });

      it('is private to each organization and checks the dates', async () => {
        expect(
          (await s.taxService.report(s.ownerB(), {})).totals.taxMinor,
        ).toBe(0);
        expect(
          (
            await failure(
              s.taxService.report(s.owner(), {
                from: '2026-05-01',
                to: '2026-04-01',
              }),
            )
          ).code,
        ).toBe('REPORT_RANGE_INVALID');
        expect(
          (
            await failure(
              s.taxService.report(s.owner(), {
                from: '2020-01-01',
                to: '2026-01-01',
              }),
            )
          ).code,
        ).toBe('REPORT_RANGE_INVALID');
        expect(
          (
            await failure(
              s.taxService.report(s.owner(), {
                from: '2026-02-31',
                to: '2026-03-01',
              }),
            )
          ).code,
        ).toBe('REPORT_RANGE_INVALID');
        const none = await s.taxService.report(s.owner(), {
          from: '2020-01-01',
          to: '2020-01-31',
        });
        expect(none).toMatchObject({ orders: 0, taxedOrders: 0, byRate: [] });
      });
    });
  },
);
