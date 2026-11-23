import { randomBytes } from 'node:crypto';
import { NoAdjustments } from '../../src/modules/orders/checkout-hooks.js';
import type { PlaceOrderDto } from '../../src/modules/orders/checkout.dto.js';
import { CheckoutService } from '../../src/modules/orders/checkout.service.js';
import { CheckoutTaxService } from '../../src/modules/tax/checkout-tax.service.js';
import { TaxService } from '../../src/modules/tax/tax.service.js';
import { ShippingAdjuster } from '../../src/modules/orders/shipping-adjuster.js';
import { CodService } from '../../src/modules/payments/cod.service.js';
import { PaymentMethodsPolicy } from '../../src/modules/payments/payment-methods.policy.js';
import { CarrierSelectionService } from '../../src/modules/shipping/carrier-selection.service.js';
import { CarriersService } from '../../src/modules/shipping/carriers.service.js';
import { MethodsService } from '../../src/modules/shipping/methods.service.js';
import { BlueDartProvider } from '../../src/modules/shipping/providers/bluedart.provider.js';
import { CarrierHttp } from '../../src/modules/shipping/providers/carrier-http.js';
import { DelhiveryProvider } from '../../src/modules/shipping/providers/delhivery.provider.js';
import { ShippingProviderRegistry } from '../../src/modules/shipping/providers/provider-registry.js';
import { ShiprocketProvider } from '../../src/modules/shipping/providers/shiprocket.provider.js';
import { ShippingQuoteService } from '../../src/modules/shipping/shipping-quote.service.js';
import { ShippingToolsService } from '../../src/modules/shipping/shipping-tools.service.js';
import { ZonesService } from '../../src/modules/shipping/zones.service.js';
import { FakeCarrier } from './fake-carrier.js';
import { createTestDb, type TestDb } from './pglite.js';
import { seedWorld, type World } from './world.js';

export const SR_CREDS = {
  email: 'api@shop.test',
  password: 'sr-pass-GOOD-123456',
  pickupLocation: 'Primary',
};
export const DL_CREDS = {
  apiToken: 'dl-token-GOOD-7890123',
  pickupLocation: 'Main Warehouse',
};

export const ORIGIN = {
  name: 'Alpha Shop',
  phone: '9000000000',
  line1: '1 Main Street',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
};

const address = (over: Record<string, string> = {}) => ({
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
  ...over,
});

/** A place-order request. `to` overrides the delivery address. */
export const orderTo = (
  slug: string,
  quantity: number,
  method: 'razorpay' | 'cod',
  shippingMethodId?: string,
  to: Record<string, string> = {},
  email = 'asha@example.test',
): PlaceOrderDto => ({
  lines: [{ productSlug: slug, quantity }],
  customer: { fullName: 'Asha Rao', email, phone: '9876543210' },
  shippingAddress: address(to) as PlaceOrderDto['shippingAddress'],
  paymentMethod: method,
  ...(shippingMethodId ? { shippingMethodId } : {}),
});

/**
 * Two organizations on a real, migrated database with every shipping service wired like production and the carriers replaced by
 * a scriptable fake. Shiprocket and Delhivery answer for any PIN code except those starting with 9 ("not serviceable").
 */
export async function createShippingWorld() {
  process.env.CREDENTIALS_ENCRYPTION_KEY_V1 =
    randomBytes(32).toString('base64');
  process.env.CREDENTIALS_ENCRYPTION_KEY_CURRENT = '1';
  const t: TestDb = await createTestDb();
  const w: World = await seedWorld(t);

  const carrier = new FakeCarrier();
  const served = (pin: string | null) => !!pin && !pin.startsWith('9');
  carrier.on('POST', '/v1/external/auth/login', (req) =>
    (req.json as { password?: string })?.password === SR_CREDS.password
      ? { body: { token: 'sr-token-1234' } }
      : { status: 403, body: { message: 'bad' } },
  );
  carrier.on('GET', '/v1/external/settings/company/pickup', {
    body: { data: { shipping_address: [{ pickup_location: 'Primary' }] } },
  });
  carrier.on('GET', '/v1/external/courier/serviceability/', (req) => {
    const pin = req.url.searchParams.get('delivery_postcode');
    if (!served(pin))
      return { status: 404, body: { message: 'not serviceable' } };
    return {
      body: {
        data: {
          available_courier_companies: [
            {
              courier_company_id: 10,
              courier_name: 'Xpressbees Surface',
              rate: 62.5,
              cod: 1,
              cod_charges: 30,
              estimated_delivery_days: '4',
            },
            {
              courier_company_id: 11,
              courier_name: 'Bluedart Air',
              rate: 120,
              cod: 0,
              cod_charges: 0,
              estimated_delivery_days: '2',
            },
          ],
        },
      },
    };
  });
  carrier.on('GET', '/c/api/pin-codes/json/', (req) => {
    if (req.headers.get('authorization') !== `Token ${DL_CREDS.apiToken}`)
      return { status: 401 };
    const pin = req.url.searchParams.get('filter_codes');
    return {
      body: {
        delivery_codes: served(pin)
          ? [
              {
                postal_code: {
                  pin: Number(pin),
                  cod: 'Y',
                  pre_paid: 'Y',
                  pickup: 'Y',
                },
              },
            ]
          : [],
      },
    };
  });
  carrier.on('GET', '/api/kinko/v1/invoice/charges/.json', (req) => ({
    body: [
      { total_amount: req.url.searchParams.get('md') === 'E' ? 118.4 : 74.62 },
    ],
  }));

  const http = new CarrierHttp(carrier.fetch, {
    timeoutMs: 1000,
    retryDelayMs: 0,
  });
  const registry = new ShippingProviderRegistry([
    new ShiprocketProvider(http),
    new DelhiveryProvider(http),
    new BlueDartProvider(http),
  ]);
  const carriers = new CarriersService(t.service, registry);
  const selection = new CarrierSelectionService(t.service, registry);
  const quotes = new ShippingQuoteService(t.service, selection);
  const config = { get: () => ({ reservationMinutes: 30 }) } as never;
  const adjuster = new ShippingAdjuster(t.service, quotes);

  const world = {
    t,
    w,
    carrier,
    registry,
    carriers,
    selection,
    quotes,
    adjuster,
    zones: new ZonesService(t.service),
    methods: new MethodsService(t.service, registry),
    tools: new ShippingToolsService(t.service, quotes, selection),
    cod: new CodService(t.service),
    checkout: new CheckoutService(
      t.service,
      config,
      new PaymentMethodsPolicy(),
      adjuster,
    ),
    /** Checkout with GST worked out, as in the application. */
    checkoutWithTax: new CheckoutService(
      t.service,
      config,
      new PaymentMethodsPolicy(),
      adjuster,
      new CheckoutTaxService(),
    ),
    taxService: new TaxService(t.service),
    checkoutWithoutShipping: new CheckoutService(
      t.service,
      config,
      new PaymentMethodsPolicy(),
      new NoAdjustments(),
    ),
    owner: () =>
      ({ userId: w.alice, tenantId: w.tenantA, role: 'owner' }) as never,
    ownerB: () =>
      ({ userId: w.bob, tenantId: w.tenantB, role: 'owner' }) as never,
    member: (id: string) =>
      ({ userId: id, tenantId: w.tenantA, role: 'admin' }) as never,
    key: (() => {
      let n = 0;
      return () => `ship-key-${String(++n).padStart(6, '0')}`;
    })(),

    /** A product with a price, stock and a weight. */
    product: (
      tenant: string,
      slug: string,
      quantity: number,
      price: number,
      weightGrams = 0,
    ) =>
      t.asOwner(async (pg) => {
        const r = await pg.query<{ id: string }>(
          `insert into products (tenant_id, name, slug, price_minor, quantity, status, weight_grams) values ($1, $2, $2, $3, $4, 'active', $5) returning id`,
          [tenant, slug, price, quantity, weightGrams],
        );
        return r.rows[0].id;
      }),
    one: <T>(query: string, params: unknown[] = []) =>
      t.asOwner(
        async (pg) => (await pg.query<{ v: T }>(query, params)).rows[0]?.v,
      ),
    orderRow: (tenant: string, orderNumber: number) =>
      t.asOwner(
        async (pg) =>
          (
            await pg.query<Record<string, unknown>>(
              'select * from orders where tenant_id = $1 and order_number = $2',
              [tenant, orderNumber],
            )
          ).rows[0],
      ),
  };

  /** Connects a carrier for organization A, checks it and turns it on. */
  async function connect(
    code: 'shiprocket' | 'delhivery',
    makeDefault = false,
  ) {
    await carriers.save(
      world.owner(),
      code,
      code === 'shiprocket' ? SR_CREDS : DL_CREDS,
    );
    await carriers.verify(world.owner(), code);
    await carriers.setEnabled(world.owner(), code, { enabled: true });
    if (makeDefault)
      await carriers.setDefault(world.owner(), code, { isDefault: true });
  }
  /** A zone for A. */
  const zone = (
    name: string,
    areas: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => world.zones.create(world.owner(), { name, areas, ...extra } as never);
  /** A method for A. */
  const method = (
    zoneId: string,
    name: string,
    fields: Record<string, unknown>,
  ) =>
    world.methods.create(world.owner(), { zoneId, name, ...fields } as never);

  return { ...world, connect, zone, method };
}

export type ShippingWorld = Awaited<ReturnType<typeof createShippingWorld>>;
