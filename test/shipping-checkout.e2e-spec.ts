import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppException } from '../src/common/app.exception.js';
import {
  ORIGIN,
  createShippingWorld,
  orderTo,
  type ShippingWorld,
} from './support/shipping-world.js';
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
  'shipping at checkout (zones, methods, COD rules, live carrier prices)',
  () => {
    let s: ShippingWorld;
    const id: Record<string, string> = {};
    const place = (
      slug: string,
      qty: number,
      method: 'razorpay' | 'cod',
      methodName?: string,
      to: Record<string, string> = {},
      key = s.key(),
    ) =>
      s.checkout.placeOrder(
        'alpha-shop',
        orderTo(slug, qty, method, methodName ? id[methodName] : undefined, to),
        key,
      );
    const orders = () =>
      s.one<number>(
        'select count(*)::int as v from orders where tenant_id = $1',
        [s.w.tenantA],
      );

    beforeAll(async () => {
      s = await createShippingWorld();
      await s.cod.save(s.owner(), {
        enabled: true,
        minOrderMinor: 0,
        maxOrderMinor: null,
        feeMinor: 3000,
      });
      await s.product(s.w.tenantA, 'ship-mug', 1000, 50000, 400);
      await s.product(s.w.tenantA, 'ship-heavy', 1000, 20000, 3000);
      await s.product(s.w.tenantA, 'ship-noweight', 1000, 10000, 0);

      const ka = await s.zone('Karnataka', { states: ['Karnataka'] });
      const sikkim = await s.zone(
        'Sikkim',
        { states: ['Sikkim'] },
        { codAllowed: false },
      );
      const mh = await s.zone('Maharashtra', { states: ['Maharashtra'] });
      const goa = await s.zone(
        'Goa (closed)',
        { states: ['Goa'] },
        { enabled: false },
      );
      const rest = await s.zone('Rest of India', { country: true });
      const make = async (
        zoneId: string,
        name: string,
        fields: Record<string, unknown>,
      ) => {
        id[name] = (await s.method(zoneId, name, fields)).id;
      };
      await make(ka.id, 'Standard', {
        pricingType: 'flat',
        flatRateMinor: 4000,
        estimatedDaysMin: 2,
        estimatedDaysMax: 4,
      });
      await make(ka.id, 'Express', {
        pricingType: 'flat',
        kind: 'express',
        flatRateMinor: 9000,
        estimatedDaysMin: 1,
        estimatedDaysMax: 1,
      });
      await make(ka.id, 'Free over 1000', {
        pricingType: 'flat',
        flatRateMinor: 5000,
        freeOverMinor: 100000,
      });
      await make(ka.id, 'By weight', {
        pricingType: 'weight',
        tiers: [
          { from: 0, to: 1000, rateMinor: 4500 },
          { from: 1000, to: null, rateMinor: 8000 },
        ],
      });
      await make(ka.id, 'Prepaid only', {
        pricingType: 'flat',
        flatRateMinor: 3500,
        codAllowed: false,
      });
      await make(sikkim.id, 'Hill post', {
        pricingType: 'flat',
        flatRateMinor: 7000,
      });
      await make(mh.id, 'Live rate', {
        pricingType: 'carrier',
        handlingMinor: 1000,
      });
      await make(goa.id, 'Never', { pricingType: 'free' });
      await make(rest.id, 'Anywhere', {
        pricingType: 'flat',
        flatRateMinor: 12000,
      });
      await s.tools.saveOrigin(s.owner(), ORIGIN as never);
      await s.connect('shiprocket');
      await s.connect('delhivery');
    });
    afterAll(() => s.t.close());

    describe('an organization with no shipping zones', () => {
      it('is unaffected: no delivery option to choose, no shipping charge', async () => {
        await s.product(s.w.tenantB, 'b-item', 10, 30000, 100);
        await s.cod.save(s.ownerB(), {
          enabled: true,
          minOrderMinor: 0,
          maxOrderMinor: null,
          feeMinor: 0,
        });
        const placed = await s.checkout.placeOrder(
          'beta-shop',
          orderTo('b-item', 1, 'cod'),
          s.key(),
        );
        expect(placed).toMatchObject({
          shippingMinor: 0,
          totalMinor: 30000,
          shippingMethodName: null,
          shippingDays: null,
        });
      });
    });

    describe('an organization with shipping zones', () => {
      it('needs a delivery option, and says so as a field error', async () => {
        const before = await orders();
        const err = await failure(place('ship-mug', 1, 'cod'));
        expect(err).toMatchObject({
          kind: 'VALIDATION',
          code: 'SHIPPING_METHOD_REQUIRED',
        });
        expect(err.details).toEqual({
          shippingMethodId: 'Choose a delivery option.',
        });
        expect(await orders()).toBe(before);
      });

      it('refuses an address that is not served, even with a valid option', async () => {
        const err = await failure(
          place('ship-mug', 1, 'cod', 'Standard', {
            state: 'Goa',
            postalCode: '403001',
            city: 'Panaji',
          }),
        );
        expect(err.code).toBe('NOT_DELIVERABLE');
      });

      it('refuses an option that belongs to another zone, one that does not exist, and one the cart is not eligible for', async () => {
        const wrongZone = await failure(
          place('ship-mug', 1, 'cod', 'Hill post'),
        );
        expect(wrongZone.code).toBe('SHIPPING_METHOD_UNAVAILABLE');
        expect(
          (wrongZone.details as { available: { name: string }[] }).available
            .map((o) => o.name)
            .sort(),
        ).toEqual([
          'By weight',
          'Express',
          'Free over 1000',
          'Prepaid only',
          'Standard',
        ]);
        const unknown = await failure(
          s.checkout.placeOrder(
            'alpha-shop',
            orderTo(
              'ship-mug',
              1,
              'cod',
              '00000000-0000-4000-8000-000000000000',
            ),
            s.key(),
          ),
        );
        expect(unknown.code).toBe('SHIPPING_METHOD_UNAVAILABLE');
      });

      it('charges the price the SERVER works out, records what was chosen, and shows it to the shopper and the Owner', async () => {
        const placed = await place('ship-mug', 2, 'cod', 'Standard');
        // subtotal 2 x 500.00 = 1000.00; shipping 40.00; cash on delivery charge 30.00
        expect(placed).toMatchObject({
          subtotalMinor: 100000,
          shippingMinor: 4000,
          codFeeMinor: 3000,
          totalMinor: 107000,
          shippingMethodName: 'Standard',
          shippingZoneName: 'Karnataka',
          shippingDays: { min: 2, max: 4 },
        });
        const row = await s.orderRow(s.w.tenantA, placed.orderNumber);
        expect(row).toMatchObject({
          shipping_minor: 4000,
          shipping_method_id: id.Standard,
          shipping_method_name: 'Standard',
          shipping_zone_name: 'Karnataka',
          shipping_days_min: 2,
          shipping_days_max: 4,
          shipping_weight_grams: 800,
          shipping_carrier_code: null,
        });
      });

      it('applies a free-shipping threshold exactly', async () => {
        expect(
          (await place('ship-mug', 1, 'cod', 'Free over 1000')).shippingMinor,
        ).toBe(5000); // 500.00 < 1000.00
        expect(
          (await place('ship-mug', 2, 'cod', 'Free over 1000')).shippingMinor,
        ).toBe(0); // 1000.00 reaches it
      });

      it('prices by the weight of the cart, from the products’ own weights', async () => {
        expect(
          (await place('ship-mug', 2, 'cod', 'By weight')).shippingMinor,
        ).toBe(4500); // 800 g
        expect(
          (await place('ship-mug', 3, 'cod', 'By weight')).shippingMinor,
        ).toBe(8000); // 1200 g
        expect(
          (await place('ship-heavy', 1, 'cod', 'By weight')).shippingMinor,
        ).toBe(8000); // 3000 g
      });

      it('never prices by weight when a product has no weight set, but still offers flat methods', async () => {
        const before = await orders();
        expect(
          (await failure(place('ship-noweight', 1, 'cod', 'By weight'))).code,
        ).toBe('SHIPPING_METHOD_UNAVAILABLE');
        expect(await orders()).toBe(before);
        expect(
          (await place('ship-noweight', 1, 'cod', 'Standard')).shippingMinor,
        ).toBe(4000);
      });

      it('lets a zone or a method forbid cash on delivery', async () => {
        expect(
          (await failure(place('ship-mug', 1, 'cod', 'Prepaid only'))).code,
        ).toBe('COD_NOT_AVAILABLE');
        const sikkim = await failure(
          place('ship-mug', 1, 'cod', 'Hill post', {
            state: 'Sikkim',
            postalCode: '737101',
            city: 'Gangtok',
          }),
        );
        expect(sikkim.code).toBe('COD_NOT_AVAILABLE');
        expect(sikkim.message).toMatch(/delivery option or area/);
      });

      it('falls to the country zone for everywhere else', async () => {
        const placed = await place('ship-mug', 1, 'cod', 'Anywhere', {
          state: 'Kerala',
          postalCode: '682001',
          city: 'Kochi',
        });
        expect(placed).toMatchObject({
          shippingMinor: 12000,
          shippingZoneName: 'Rest of India',
        });
      });

      it('leaves no trace when shipping refuses the order: no order, no stock held', async () => {
        const before = await orders();
        const held = () =>
          s.one<number>(
            "select count(*)::int as v from inventory_reservations r join products p on p.id = r.product_id where p.slug = 'ship-mug' and r.status = 'active'",
          );
        const heldBefore = await held();
        await failure(place('ship-mug', 5, 'cod', 'Hill post'));
        expect(await orders()).toBe(before);
        expect(await held()).toBe(heldBefore);
      });
    });

    describe('live carrier prices', () => {
      const mumbai = {
        state: 'Maharashtra',
        postalCode: '400001',
        city: 'Mumbai',
      };

      it('prices the order from the best live quote plus handling, and records the carrier', async () => {
        const placed = await place('ship-mug', 2, 'cod', 'Live rate', mumbai);
        // Shiprocket's Xpressbees at 62.50 is the cheapest; handling 10.00 is added.
        expect(placed).toMatchObject({
          shippingMinor: 6250 + 1000,
          shippingMethodName: 'Live rate',
          shippingDays: { min: 4, max: 4 },
        });
        expect(await s.orderRow(s.w.tenantA, placed.orderNumber)).toMatchObject(
          { shipping_carrier_code: 'shiprocket', shipping_service_code: '10' },
        );
      });

      it('asks the carriers BEFORE the order transaction opens, never while stock is locked', async () => {
        let open = 0;
        const original = s.t.service.withCheckout.bind(s.t.service);
        s.t.service.withCheckout = ((tenantId: string, fn: never) => {
          open += 1;
          return (original as (t: string, f: never) => Promise<unknown>)(
            tenantId,
            fn,
          ).finally(() => {
            open -= 1;
          });
        }) as never;
        const depths: number[] = [];
        s.carrier.onRequest = () => depths.push(open);
        try {
          await place('ship-mug', 1, 'cod', 'Live rate', mumbai);
        } finally {
          s.carrier.onRequest = undefined;
          s.t.service.withCheckout = original as never;
        }
        expect(depths.length).toBeGreaterThan(0);
        expect(depths.every((d) => d === 0)).toBe(true);
      });

      it('repeating a finished checkout does not ask a carrier anything', async () => {
        const key = s.key();
        const first = await place(
          'ship-mug',
          1,
          'cod',
          'Live rate',
          mumbai,
          key,
        );
        const calls = s.carrier.requests.length;
        const again = await place(
          'ship-mug',
          1,
          'cod',
          'Live rate',
          mumbai,
          key,
        );
        expect(again).toMatchObject({
          replayed: true,
          orderNumber: first.orderNumber,
        });
        expect(s.carrier.requests.length).toBe(calls);
      });

      it('refuses the order, safely, when no live price is available (never a made-up price)', async () => {
        const before = await orders();
        const err = await failure(
          place('ship-mug', 1, 'cod', 'Live rate', {
            state: 'Maharashtra',
            postalCode: '900001',
            city: 'Nowhere',
          }),
        );
        expect(err.code).toBe('NOT_DELIVERABLE');
        expect(JSON.stringify(err.details)).toContain(
          'not available right now',
        );
        expect(await orders()).toBe(before);
      });

      it('does not use a live price for a different weight than the one it was asked for', async () => {
        const options = await s.quotes.options(s.w.tenantA, {
          destination: {
            stateCode: '27',
            postalCode: '400001',
            city: 'Mumbai',
          },
          subtotalMinor: 50000,
          weightGrams: 400,
        });
        expect(options.options[0].chargeMinor).toBe(7250);
        // A price prepared for 400 g is ignored for an 800 g cart: with nothing usable the method is not offered.
        const loaded = await s.t.service.withCheckout(s.w.tenantA, (tx) =>
          s.quotes.load(tx, s.w.tenantA, {
            stateCode: '27',
            postalCode: '400001',
            city: 'Mumbai',
          }),
        );
        const prices = await s.quotes.carrierPrices(s.w.tenantA, loaded, {
          destination: {
            stateCode: '27',
            postalCode: '400001',
            city: 'Mumbai',
          },
          subtotalMinor: 50000,
          weightGrams: 400,
        });
        const mismatched = await s.t.service.withCheckout(
          s.w.tenantA,
          async (tx) =>
            s.adjuster
              .adjust(
                tx,
                {
                  tenantId: s.w.tenantA,
                  lines: [
                    {
                      productId: 'p',
                      variantId: null,
                      name: 'x',
                      sku: null,
                      quantity: 2,
                      unitPriceMinor: 50000,
                      totalMinor: 100000,
                      trackInventory: false,
                      weightGrams: 400,
                      taxRateBps: null,
                      hsnCode: null,
                    },
                  ],
                  subtotalMinor: 100000,
                  destination: {
                    stateCode: '27',
                    stateName: 'Maharashtra',
                    city: 'Mumbai',
                    postalCode: '400001',
                  },
                  shippingMethodId: id['Live rate'],
                  paymentMethod: 'cod',
                  currency: 'INR',
                },
                { weightGrams: 400, prices },
              )
              .catch((e: unknown) => e),
        );
        expect((mismatched as AppException).code).toBe('NOT_DELIVERABLE');
      });
    });

    describe('what each side sees', () => {
      it('shows the Owner the shipping that was chosen and the weight it was based on', async () => {
        const placed = await place('ship-mug', 2, 'cod', 'Standard');
        const orderId = await s.one<string>(
          'select id as v from orders where tenant_id = $1 and order_number = $2',
          [s.w.tenantA, placed.orderNumber],
        );
        const { OrdersService } =
          await import('../src/modules/orders/orders.service.js');
        const detail = await new OrdersService(s.t.service).get(
          s.owner(),
          orderId!,
        );
        expect(detail).toMatchObject({
          shippingMethodName: 'Standard',
          shippingZoneName: 'Karnataka',
          shippingDays: { min: 2, max: 4 },
          shippingWeightGrams: 800,
          shippingMinor: 4000,
          shippingCarrierCode: null,
        });
      });
    });
  },
);
