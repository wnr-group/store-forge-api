import { describe, expect, it } from 'vitest';
import { CarrierHttp } from '../src/modules/shipping/providers/carrier-http.js';
import { ShiprocketProvider } from '../src/modules/shipping/providers/shiprocket.provider.js';
import {
  CarrierError,
  type ShipmentInput,
} from '../src/modules/shipping/providers/shipping-provider.js';
import { FakeCarrier } from './support/fake-carrier.js';

const BASE = '/v1/external';
const CREDS = {
  email: 'api@shop.test',
  password: 'p4ssw0rd-secret-value',
  pickupLocation: 'Primary',
};
const LANE = {
  originPostalCode: '560001',
  destinationPostalCode: '400001',
  paymentMode: 'prepaid' as const,
  parcel: { weightGrams: 750 },
};

const setup = (carrier = new FakeCarrier()) => {
  carrier.on('POST', `${BASE}/auth/login`, {
    body: { token: 'tok-secret-abc123' },
  });
  const provider = new ShiprocketProvider(
    new CarrierHttp(carrier.fetch, { timeoutMs: 1000, retryDelayMs: 0 }),
  );
  return { carrier, provider };
};
const fail = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    if (error instanceof CarrierError) return error;
    throw error;
  }
  throw new Error('expected a CarrierError');
};

const couriers = {
  status: 200,
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
        rate: '120.00',
        cod: 0,
        cod_charges: 0,
        estimated_delivery_days: '2',
      },
      {
        courier_company_id: 12,
        courier_name: 'Broken Entry',
        rate: 'n/a',
        cod: 1,
      },
    ],
  },
};

const shipment = (over: Partial<ShipmentInput> = {}): ShipmentInput => ({
  orderReference: 'SF-1001',
  orderNumber: 1001,
  orderDate: new Date('2026-11-23T04:30:00Z'),
  paymentMode: 'prepaid',
  declaredValueMinor: 150000,
  consignee: {
    name: 'Asha Rao',
    phone: '+91 98765 43210',
    email: 'asha@example.test',
    line1: '12 MG Road',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400001',
    country: 'IN',
  },
  pickup: {
    name: 'Shop',
    phone: '9000000000',
    line1: '1 Main St',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560001',
    country: 'IN',
  },
  items: [
    {
      name: 'Ceramic mug',
      sku: 'MUG-1',
      quantity: 2,
      unitPriceMinor: 75000,
      hsnCode: '6911',
    },
  ],
  parcel: { weightGrams: 750, lengthCm: 20, breadthCm: 15, heightCm: 10 },
  ...over,
});

describe('Shiprocket adapter', () => {
  it('describes itself honestly', () => {
    const { provider } = setup();
    expect(provider).toMatchObject({
      code: 'shiprocket',
      integrationStatus: 'partially_documented',
    });
    expect(
      provider.credentialFields.filter((f) => f.secret).map((f) => f.key),
    ).toEqual(['password']);
  });

  describe('credentials', () => {
    it('logs in with the API user and checks the pickup location exists', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/settings/company/pickup`, {
        body: {
          data: {
            shipping_address: [
              { pickup_location: 'Primary' },
              { pickup_location: 'Second' },
            ],
          },
        },
      });
      expect(await provider.validateCredentials(CREDS)).toEqual({
        valid: true,
        message: 'Connected to Shiprocket.',
      });
      expect(carrier.to(`${BASE}/auth/login`)[0].json).toEqual({
        email: CREDS.email,
        password: CREDS.password,
      });
      expect(
        carrier
          .to(`${BASE}/settings/company/pickup`)[0]
          .headers.get('authorization'),
      ).toBe('Bearer tok-secret-abc123');
    });

    it('says "not valid" for refused credentials (401, 403 or 422) and for an unknown pickup location', async () => {
      for (const status of [401, 403, 422]) {
        const carrier = new FakeCarrier().on('POST', `${BASE}/auth/login`, {
          status,
          body: { message: 'Invalid email or password' },
        });
        const provider = new ShiprocketProvider(
          new CarrierHttp(carrier.fetch, { timeoutMs: 1000, retryDelayMs: 0 }),
        );
        expect((await provider.validateCredentials(CREDS)).valid).toBe(false);
      }
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/settings/company/pickup`, {
        body: { data: { shipping_address: [{ pickup_location: 'Other' }] } },
      });
      const result = await provider.validateCredentials(CREDS);
      expect(result.valid).toBe(false);
      expect(result.message).toContain('Primary');
    });

    it('reports an outage as an error, not as invalid credentials', async () => {
      const carrier = new FakeCarrier().on('POST', `${BASE}/auth/login`, {
        status: 503,
      });
      const provider = new ShiprocketProvider(
        new CarrierHttp(carrier.fetch, { timeoutMs: 1000, retryDelayMs: 0 }),
      );
      expect((await fail(provider.validateCredentials(CREDS))).kind).toBe(
        'unavailable',
      );
    });

    it('refuses saved settings that are incomplete before sending anything', async () => {
      const { carrier, provider } = setup();
      const error = await fail(
        provider.getServiceability({ email: 'a@b.co' }, LANE),
      );
      expect(error.kind).toBe('invalid_input');
      expect(error.message).toContain('password');
      expect(carrier.requests).toHaveLength(0);
    });
  });

  describe('token handling', () => {
    it('logs in once and reuses the token', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/courier/serviceability/`, { body: couriers });
      await provider.getServiceability(CREDS, LANE);
      await provider.getServiceability(CREDS, LANE);
      expect(carrier.to(`${BASE}/auth/login`)).toHaveLength(1);
    });

    it('replaces a token Shiprocket no longer accepts, once, and repeats the call', async () => {
      const carrier = new FakeCarrier();
      carrier.on('POST', `${BASE}/auth/login`, [
        { body: { token: 'old-token-1' } },
        { body: { token: 'new-token-2' } },
      ]);
      carrier.on('GET', `${BASE}/courier/serviceability/`, [
        { status: 401 },
        { body: couriers },
      ]);
      const provider = new ShiprocketProvider(
        new CarrierHttp(carrier.fetch, { timeoutMs: 1000, retryDelayMs: 0 }),
      );
      expect((await provider.getServiceability(CREDS, LANE)).serviceable).toBe(
        true,
      );
      expect(carrier.to(`${BASE}/auth/login`)).toHaveLength(2);
      expect(
        carrier
          .to(`${BASE}/courier/serviceability/`)[1]
          .headers.get('authorization'),
      ).toBe('Bearer new-token-2');
    });

    it('gives up if the new token is refused too', async () => {
      const carrier = new FakeCarrier();
      carrier.on('POST', `${BASE}/auth/login`, { body: { token: 't-1234' } });
      carrier.on('GET', `${BASE}/courier/serviceability/`, { status: 401 });
      const provider = new ShiprocketProvider(
        new CarrierHttp(carrier.fetch, { timeoutMs: 1000, retryDelayMs: 0 }),
      );
      expect((await fail(provider.getServiceability(CREDS, LANE))).kind).toBe(
        'auth',
      );
    });
  });

  describe('serviceability and rates', () => {
    it('sends the lane and reads the couriers that can take it', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/courier/serviceability/`, { body: couriers });
      const result = await provider.getServiceability(CREDS, {
        ...LANE,
        declaredValueMinor: 150000,
      });
      const q = carrier.to(`${BASE}/courier/serviceability/`)[0].url
        .searchParams;
      expect(Object.fromEntries(q)).toEqual({
        pickup_postcode: '560001',
        delivery_postcode: '400001',
        weight: '0.75',
        cod: '0',
        declared_value: '1500',
      });
      expect(result).toMatchObject({
        serviceable: true,
        codAvailable: true,
        prepaidAvailable: true,
      });
      expect(result.services.map((s) => s.code)).toEqual(['10', '11', '12']);
    });

    it('for cash on delivery offers only couriers that collect cash', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/courier/serviceability/`, { body: couriers });
      const result = await provider.getServiceability(CREDS, {
        ...LANE,
        paymentMode: 'cod',
      });
      expect(
        carrier
          .to(`${BASE}/courier/serviceability/`)[0]
          .url.searchParams.get('cod'),
      ).toBe('1');
      expect(result.services.map((s) => s.code)).toEqual(['10', '12']);
    });

    it('turns rupees into paise, drops entries it cannot price, and separates the COD charge', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/courier/serviceability/`, { body: couriers });
      const quotes = await provider.calculateShippingRates(CREDS, LANE);
      expect(quotes).toEqual([
        {
          serviceCode: '10',
          serviceName: 'Xpressbees Surface',
          amountMinor: 6250,
          currency: 'INR',
          estimatedDeliveryDays: 4,
          codChargeMinor: null,
          estimate: false,
        },
        {
          serviceCode: '11',
          serviceName: 'Bluedart Air',
          amountMinor: 12000,
          currency: 'INR',
          estimatedDeliveryDays: 2,
          codChargeMinor: null,
          estimate: false,
        },
      ]);
      const cod = await provider.calculateShippingRates(CREDS, {
        ...LANE,
        paymentMode: 'cod',
      });
      expect(cod).toHaveLength(1);
      expect(cod[0]).toMatchObject({ serviceCode: '10', codChargeMinor: 3000 });
    });

    it('treats "no courier serves this lane" (HTTP 404) as an answer, not a failure', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/courier/serviceability/`, {
        status: 404,
        body: { message: 'Delivery postcode not serviceable' },
      });
      const result = await provider.getServiceability(CREDS, LANE);
      expect(result.serviceable).toBe(false);
      expect(await provider.calculateShippingRates(CREDS, LANE)).toEqual([]);
    });

    it('never says "serviceable" for an answer it does not understand', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/courier/serviceability/`, {
        body: { data: { something: 'else' } },
      });
      expect((await fail(provider.getServiceability(CREDS, LANE))).kind).toBe(
        'invalid_response',
      );
    });

    it('rejects a bad PIN code before sending', async () => {
      const { carrier, provider } = setup();
      expect(
        (
          await fail(
            provider.getServiceability(CREDS, {
              ...LANE,
              destinationPostalCode: '0123',
            }),
          )
        ).kind,
      ).toBe('invalid_input');
      expect(carrier.requests).toHaveLength(0);
    });

    it('needs a lane to list services', async () => {
      const { provider } = setup();
      expect((await fail(provider.getAvailableServices(CREDS))).kind).toBe(
        'invalid_input',
      );
    });
  });

  describe('creating a shipment', () => {
    const created = { order_id: 7788, shipment_id: 9911, status: 'NEW' };
    const assigned = {
      awb_assign_status: 1,
      response: {
        data: {
          awb_code: '14343210',
          courier_name: 'Xpressbees',
          courier_company_id: 10,
        },
      },
    };

    it('creates the order, assigns the courier and returns the AWB', async () => {
      const { carrier, provider } = setup();
      carrier.on('POST', `${BASE}/orders/create/adhoc`, { body: created });
      carrier.on('POST', `${BASE}/courier/assign/awb`, { body: assigned });
      const result = await provider.createShipment(
        CREDS,
        shipment({ serviceCode: '10' }),
      );
      expect(result).toEqual({
        awb: '14343210',
        providerOrderId: '7788',
        providerShipmentId: '9911',
        courierName: 'Xpressbees',
        serviceCode: '10',
        trackingUrl: 'https://shiprocket.co/tracking/14343210',
      });
      expect(carrier.to(`${BASE}/orders/create/adhoc`)[0].json).toMatchObject({
        order_id: 'SF-1001',
        order_date: '2026-11-23 10:00',
        pickup_location: 'Primary',
        billing_customer_name: 'Asha',
        billing_last_name: 'Rao',
        billing_pincode: '400001',
        billing_phone: '9876543210',
        payment_method: 'Prepaid',
        sub_total: 1500,
        weight: 0.75,
        length: 20,
        order_items: [
          {
            name: 'Ceramic mug',
            sku: 'MUG-1',
            units: 2,
            selling_price: 750,
            hsn: '6911',
          },
        ],
      });
      expect(carrier.to(`${BASE}/courier/assign/awb`)[0].json).toEqual({
        shipment_id: 9911,
        courier_id: 10,
      });
    });

    it('books cash on delivery with the amount to collect', async () => {
      const { carrier, provider } = setup();
      carrier.on('POST', `${BASE}/orders/create/adhoc`, { body: created });
      carrier.on('POST', `${BASE}/courier/assign/awb`, { body: assigned });
      await provider.createShipment(
        CREDS,
        shipment({ paymentMode: 'cod', codAmountMinor: 154000 }),
      );
      expect(carrier.to(`${BASE}/orders/create/adhoc`)[0].json).toMatchObject({
        payment_method: 'COD',
        sub_total: 1540,
      });
      // No service chosen: Shiprocket picks the courier itself.
      expect(carrier.to(`${BASE}/courier/assign/awb`)[0].json).toEqual({
        shipment_id: 9911,
      });
    });

    it('reports how far it got when the courier cannot be assigned, so the caller resumes instead of duplicating', async () => {
      const { carrier, provider } = setup();
      carrier.on('POST', `${BASE}/orders/create/adhoc`, { body: created });
      carrier.on('POST', `${BASE}/courier/assign/awb`, [
        { body: { awb_assign_status: 0, message: 'Wallet balance is low' } },
        { body: assigned },
      ]);
      const error = await fail(provider.createShipment(CREDS, shipment()));
      expect(error.kind).toBe('rejected');
      expect(error.message).toBe('Wallet balance is low');
      expect(error.options.partial).toEqual({
        providerOrderId: '7788',
        providerShipmentId: '9911',
      });

      // The retry resumes: no second order is created.
      const resumed = await provider.createShipment(
        CREDS,
        shipment({ resume: error.options.partial }),
      );
      expect(resumed.awb).toBe('14343210');
      expect(carrier.to(`${BASE}/orders/create/adhoc`)).toHaveLength(1);
    });

    it('does not retry creation after a network failure (it could double-book)', async () => {
      const { carrier, provider } = setup();
      carrier.on('POST', `${BASE}/orders/create/adhoc`, { networkError: true });
      expect(
        (await fail(provider.createShipment(CREDS, shipment()))).kind,
      ).toBe('unavailable');
      expect(carrier.to(`${BASE}/orders/create/adhoc`)).toHaveLength(1);
    });

    it('refuses what Shiprocket cannot take, before sending anything', async () => {
      const { carrier, provider } = setup();
      expect(
        (
          await fail(
            provider.createShipment(CREDS, shipment({ paymentMode: 'cod' })),
          )
        ).kind,
      ).toBe('invalid_input');
      const noEmail = shipment();
      noEmail.consignee.email = undefined;
      expect(
        (await fail(provider.createShipment(CREDS, noEmail))).message,
      ).toContain('email');
      expect(
        (await fail(provider.createShipment(CREDS, shipment({ items: [] }))))
          .kind,
      ).toBe('invalid_input');
      expect(carrier.requests).toHaveLength(0);
    });

    it('does not accept an order answer without a shipment id', async () => {
      const { carrier, provider } = setup();
      carrier.on('POST', `${BASE}/orders/create/adhoc`, {
        body: { order_id: 1 },
      });
      expect(
        (await fail(provider.createShipment(CREDS, shipment()))).kind,
      ).toBe('invalid_response');
    });
  });

  describe('cancelling, labels and tracking', () => {
    it('cancels by AWB, or by order id when there is no AWB yet', async () => {
      const { carrier, provider } = setup();
      carrier.on('POST', `${BASE}/orders/cancel/shipment/awbs`, {
        body: { message: 'Bulk Shipment cancellation is processing' },
      });
      carrier.on('POST', `${BASE}/orders/cancel`, {
        body: { message: 'Order cancelled successfully' },
      });
      expect(await provider.cancelShipment(CREDS, { awb: '14343210' })).toEqual(
        {
          cancelled: true,
          message: 'Bulk Shipment cancellation is processing',
        },
      );
      expect(carrier.to(`${BASE}/orders/cancel/shipment/awbs`)[0].json).toEqual(
        { awbs: ['14343210'] },
      );
      await provider.cancelShipment(CREDS, {
        awb: '',
        providerOrderId: '7788',
      });
      expect(carrier.to(`${BASE}/orders/cancel`)[0].json).toEqual({
        ids: [7788],
      });
      expect(
        (await fail(provider.cancelShipment(CREDS, { awb: '' }))).kind,
      ).toBe('invalid_input');
    });

    it('passes on Shiprocket’s refusal to cancel', async () => {
      const { carrier, provider } = setup();
      carrier.on('POST', `${BASE}/orders/cancel/shipment/awbs`, {
        status: 400,
        body: { message: 'Cannot cancel a delivered shipment' },
      });
      const error = await fail(
        provider.cancelShipment(CREDS, { awb: '14343210' }),
      );
      expect(error).toMatchObject({
        kind: 'rejected',
        message: 'Cannot cancel a delivered shipment',
      });
    });

    it('makes a label and only accepts an https link', async () => {
      const { carrier, provider } = setup();
      carrier.on('POST', `${BASE}/courier/generate/label`, [
        {
          body: {
            label_created: 1,
            label_url: 'https://kr-shipmultichannel.s3.amazonaws.com/label.pdf',
          },
        },
        { body: { label_created: 1, label_url: 'javascript:alert(1)' } },
        { body: { label_created: 0, response: 'Shipment not found' } },
      ]);
      const ref = { awb: '14343210', providerShipmentId: '9911' };
      expect(await provider.generateShippingLabel(CREDS, ref)).toEqual({
        url: 'https://kr-shipmultichannel.s3.amazonaws.com/label.pdf',
      });
      expect(carrier.to(`${BASE}/courier/generate/label`)[0].json).toEqual({
        shipment_id: [9911],
      });
      expect(
        (await fail(provider.generateShippingLabel(CREDS, ref))).kind,
      ).toBe('rejected');
      expect(
        (await fail(provider.generateShippingLabel(CREDS, ref))).message,
      ).toBe('Shipment not found');
      expect(
        (await fail(provider.generateShippingLabel(CREDS, { awb: 'x' }))).kind,
      ).toBe('invalid_input');
    });

    it('reads tracking, newest event first', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/courier/track/awb/14343210`, {
        body: {
          tracking_data: {
            track_status: 1,
            etd: '2026-11-27 18:00:00',
            track_url: 'https://shiprocket.co/tracking/14343210',
            shipment_track: [{ current_status: 'Out For Delivery' }],
            shipment_track_activities: [
              {
                date: '2026-11-24 09:00:00',
                activity: 'Picked Up',
                location: 'Bengaluru',
              },
              {
                date: '2026-11-26 08:10:00',
                activity: 'Out For Delivery',
                location: 'Mumbai',
              },
              {
                date: '2026-11-25 20:00:00',
                activity: 'In Transit',
                location: 'Pune Hub',
              },
            ],
          },
        },
      });
      const t = await provider.trackShipment(CREDS, { awb: '14343210' });
      expect(t).toMatchObject({
        awb: '14343210',
        status: 'out_for_delivery',
        statusText: 'Out For Delivery',
        trackingUrl: 'https://shiprocket.co/tracking/14343210',
      });
      expect(t.events.map((e) => e.description)).toEqual([
        'Out For Delivery',
        'In Transit',
        'Picked Up',
      ]);
      expect(t.events.map((e) => e.status)).toEqual([
        'out_for_delivery',
        'in_transit',
        'picked_up',
      ]);
      expect(t.events[0].location).toBe('Mumbai');
      expect(t.estimatedDelivery).toBeInstanceOf(Date);
    });

    it('handles a shipment with no updates, rejects odd AWBs, and refuses an answer in a strange shape', async () => {
      const { carrier, provider } = setup();
      carrier.on('GET', `${BASE}/courier/track/awb/14343210`, {
        body: {
          tracking_data: {
            track_status: 0,
            error: 'Tracking not available yet',
          },
        },
      });
      expect(
        await provider.trackShipment(CREDS, { awb: '14343210' }),
      ).toMatchObject({
        status: 'pending',
        statusText: 'Tracking not available yet',
        events: [],
      });
      expect(
        (await fail(provider.trackShipment(CREDS, { awb: '../etc/passwd' })))
          .kind,
      ).toBe('invalid_input');
      carrier.on('GET', `${BASE}/courier/track/awb/55555555`, {
        body: { unexpected: true },
      });
      expect(
        (await fail(provider.trackShipment(CREDS, { awb: '55555555' }))).kind,
      ).toBe('invalid_response');
    });
  });

  it('never puts the password or a token into an error', async () => {
    const carrier = new FakeCarrier();
    carrier.on('POST', `${BASE}/auth/login`, {
      body: { token: 'tok-secret-abc123' },
    });
    carrier.on('GET', `${BASE}/courier/serviceability/`, {
      status: 400,
      body: {
        message: `Bad request for ${CREDS.password} and tok-secret-abc123`,
      },
    });
    const provider = new ShiprocketProvider(
      new CarrierHttp(carrier.fetch, { timeoutMs: 1000, retryDelayMs: 0 }),
    );
    const error = await fail(provider.getServiceability(CREDS, LANE));
    expect(error.message).not.toContain(CREDS.password);
    expect(error.message).not.toContain('tok-secret-abc123');
    expect(JSON.stringify(error)).not.toContain(CREDS.password);
  });
});
