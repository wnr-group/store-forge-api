import { describe, expect, it } from 'vitest';
import { CarrierHttp } from '../src/modules/shipping/providers/carrier-http.js';
import { DelhiveryProvider } from '../src/modules/shipping/providers/delhivery.provider.js';
import {
  CarrierError,
  type ShipmentInput,
} from '../src/modules/shipping/providers/shipping-provider.js';
import { FakeCarrier } from './support/fake-carrier.js';

const CREDS = {
  apiToken: 'dlv-token-secret-9876',
  pickupLocation: 'Main Warehouse',
  sellerGstin: '29ABCDE1234F1Z5',
};
const LANE = {
  originPostalCode: '560001',
  destinationPostalCode: '400001',
  paymentMode: 'prepaid' as const,
  parcel: { weightGrams: 1200 },
};

const make = () => {
  const carrier = new FakeCarrier();
  const provider = new DelhiveryProvider(
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
const pin = (cod: 'Y' | 'N', prepaid: 'Y' | 'N') => ({
  delivery_codes: [
    { postal_code: { pin: 400001, cod, pre_paid: prepaid, pickup: 'Y' } },
  ],
});

const shipment = (over: Partial<ShipmentInput> = {}): ShipmentInput => ({
  orderReference: 'SF-2002',
  orderNumber: 2002,
  orderDate: new Date('2026-11-23T04:30:00Z'),
  paymentMode: 'prepaid',
  declaredValueMinor: 150000,
  consignee: {
    name: 'Asha Rao',
    phone: '+91 98765 43210',
    email: 'asha@example.test',
    line1: '12 MG Road',
    line2: 'Flat 4',
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
      quantity: 2,
      unitPriceMinor: 75000,
      hsnCode: '6911',
    },
    { name: 'Coaster', quantity: 1, unitPriceMinor: 0 },
  ],
  parcel: { weightGrams: 750, lengthCm: 20, breadthCm: 15, heightCm: 10 },
  ...over,
});
const CREATE = '/api/cmu/create.json';

describe('Delhivery adapter', () => {
  it('describes itself honestly', () => {
    const { provider } = make();
    expect(provider).toMatchObject({
      code: 'delhivery',
      integrationStatus: 'partially_documented',
    });
    expect(provider.capabilities).toMatchObject({
      rateQuotes: true,
      ratesAreEstimates: true,
    });
    expect(
      provider.credentialFields.filter((f) => f.secret).map((f) => f.key),
    ).toEqual(['apiToken']);
  });

  describe('credentials', () => {
    it('proves the token with a harmless PIN code lookup, on the chosen environment', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', '/c/api/pin-codes/json/', { body: pin('Y', 'Y') });
      expect(await provider.validateCredentials(CREDS)).toEqual({
        valid: true,
        message: 'Connected to Delhivery.',
      });
      const req = carrier.requests[0];
      expect(req.url.origin).toBe('https://track.delhivery.com');
      expect(req.headers.get('authorization')).toBe(
        'Token dlv-token-secret-9876',
      );

      await provider.validateCredentials({ ...CREDS, environment: 'staging' });
      expect(carrier.requests[1].url.origin).toBe(
        'https://staging-express.delhivery.com',
      );
    });

    it('says "not valid" for a refused token or an answer that is not Delhivery’s, and errors on an outage', async () => {
      const refused = make();
      refused.carrier.on('GET', '/c/api/pin-codes/json/', { status: 401 });
      expect((await refused.provider.validateCredentials(CREDS)).valid).toBe(
        false,
      );
      const odd = make();
      odd.carrier.on('GET', '/c/api/pin-codes/json/', {
        body: { hello: 'world' },
      });
      expect((await odd.provider.validateCredentials(CREDS)).valid).toBe(false);
      const down = make();
      down.carrier.on('GET', '/c/api/pin-codes/json/', { status: 502 });
      expect((await fail(down.provider.validateCredentials(CREDS))).kind).toBe(
        'unavailable',
      );
      expect(down.carrier.requests).toHaveLength(3); // a read is retried
    });

    it('rejects a bad environment value and missing settings before sending', async () => {
      const { carrier, provider } = make();
      expect(
        (
          await fail(
            provider.validateCredentials({ ...CREDS, environment: 'moon' }),
          )
        ).kind,
      ).toBe('invalid_input');
      expect(
        (await fail(provider.validateCredentials({ apiToken: 'x1234' })))
          .message,
      ).toContain('pickupLocation');
      expect(carrier.requests).toHaveLength(0);
    });
  });

  describe('serviceability and rates', () => {
    it('answers for the payment mode asked and says whether COD works there', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', '/c/api/pin-codes/json/', [
        { body: pin('N', 'Y') },
        { body: pin('N', 'Y') },
        { body: pin('Y', 'N') },
      ]);
      expect(await provider.getServiceability(CREDS, LANE)).toMatchObject({
        serviceable: true,
        codAvailable: false,
        prepaidAvailable: true,
      });
      expect(carrier.requests[0].url.searchParams.get('filter_codes')).toBe(
        '400001',
      );
      const cod = await provider.getServiceability(CREDS, {
        ...LANE,
        paymentMode: 'cod',
      });
      expect(cod).toMatchObject({
        serviceable: false,
        codAvailable: false,
        services: [],
      });
      expect(cod.reason).toContain('cash on delivery');
      expect(
        await provider.getServiceability(CREDS, {
          ...LANE,
          paymentMode: 'cod',
        }),
      ).toMatchObject({ serviceable: true, codAvailable: true });
    });

    it('says "not serviceable" for a PIN code Delhivery does not list, and refuses a shape it does not know', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', '/c/api/pin-codes/json/', [
        { body: { delivery_codes: [] } },
        { body: { oops: 1 } },
      ]);
      expect((await provider.getServiceability(CREDS, LANE)).serviceable).toBe(
        false,
      );
      expect((await fail(provider.getServiceability(CREDS, LANE))).kind).toBe(
        'invalid_response',
      );
    });

    it('prices both modes, marks the prices as estimates and passes the COD value', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', '/api/kinko/v1/invoice/charges/.json', (req) => ({
        body: [
          {
            total_amount:
              req.url.searchParams.get('md') === 'E' ? 118.4 : 74.62,
            gross_amount: 60,
          },
        ],
      }));
      const quotes = await provider.calculateShippingRates(CREDS, {
        ...LANE,
        paymentMode: 'cod',
        declaredValueMinor: 250000,
      });
      expect(quotes).toEqual([
        {
          serviceCode: 'S',
          serviceName: 'Surface',
          amountMinor: 7462,
          currency: 'INR',
          estimatedDeliveryDays: null,
          codChargeMinor: null,
          estimate: true,
        },
        {
          serviceCode: 'E',
          serviceName: 'Express',
          amountMinor: 11840,
          currency: 'INR',
          estimatedDeliveryDays: null,
          codChargeMinor: null,
          estimate: true,
        },
      ]);
      const q = Object.fromEntries(carrier.requests[0].url.searchParams);
      expect(q).toEqual({
        md: 'S',
        ss: 'Delivered',
        d_pin: '400001',
        o_pin: '560001',
        cgm: '1200',
        pt: 'COD',
        cod: '2500',
      });
    });

    it('offers the modes it could price, and reports trouble only if none could be priced', async () => {
      const partial = make();
      partial.carrier.on('GET', '/api/kinko/v1/invoice/charges/.json', (req) =>
        req.url.searchParams.get('md') === 'E'
          ? {
              status: 400,
              body: { message: 'Express not available on this lane' },
            }
          : { body: [{ total_amount: 80 }] },
      );
      expect(
        (await partial.provider.calculateShippingRates(CREDS, LANE)).map(
          (q) => q.serviceCode,
        ),
      ).toEqual(['S']);
      const none = make();
      none.carrier.on('GET', '/api/kinko/v1/invoice/charges/.json', {
        status: 400,
        body: { message: 'Not available on this lane' },
      });
      expect(
        (await fail(none.provider.calculateShippingRates(CREDS, LANE))).kind,
      ).toBe('rejected');
      const wrong = make();
      wrong.carrier.on('GET', '/api/kinko/v1/invoice/charges/.json', {
        body: [{ total_amount: 'free' }],
      });
      expect(
        (await fail(wrong.provider.calculateShippingRates(CREDS, LANE))).kind,
      ).toBe('invalid_response');
    });

    it('lists its two modes without calling Delhivery', async () => {
      const { carrier, provider } = make();
      expect(
        (await provider.getAvailableServices()).map((s) => s.code),
      ).toEqual(['S', 'E']);
      expect(carrier.requests).toHaveLength(0);
    });
  });

  describe('creating a shipment', () => {
    it('books the package in the documented form and returns the waybill', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', CREATE, {
        body: {
          success: true,
          packages: [
            {
              status: 'Success',
              waybill: '5540110000123',
              refnum: 'SF-2002',
              remarks: [],
            },
          ],
          rmk: '',
        },
      });
      const result = await provider.createShipment(
        CREDS,
        shipment({
          serviceCode: 'E',
          paymentMode: 'cod',
          codAmountMinor: 154000,
        }),
      );
      expect(result).toMatchObject({
        awb: '5540110000123',
        providerOrderId: 'SF-2002',
        courierName: 'Delhivery',
        serviceCode: 'E',
        trackingUrl: 'https://www.delhivery.com/track/package/5540110000123',
      });

      const req = carrier.to(CREATE)[0];
      expect(req.headers.get('content-type')).toContain(
        'x-www-form-urlencoded',
      );
      expect(req.headers.get('authorization')).toBe(
        'Token dlv-token-secret-9876',
      );
      expect(req.form!.get('format')).toBe('json');
      const data = JSON.parse(req.form!.get('data')!);
      expect(data.pickup_location).toEqual({ name: 'Main Warehouse' });
      expect(data.shipments[0]).toMatchObject({
        name: 'Asha Rao',
        add: '12 MG Road, Flat 4',
        pin: '400001',
        phone: '9876543210',
        order: 'SF-2002',
        payment_mode: 'COD',
        cod_amount: 1540,
        total_amount: 1500,
        weight: 750,
        quantity: 3,
        shipment_length: 20,
        shipping_mode: 'Express',
        hsn_code: '6911',
        seller_gst_tin: '29ABCDE1234F1Z5',
        waybill: '',
      });
    });

    it('books prepaid with no COD amount and defaults to surface', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', CREATE, {
        body: {
          success: true,
          packages: [{ status: 'Success', waybill: '99887766' }],
        },
      });
      await provider.createShipment({ ...CREDS, sellerGstin: '' }, shipment());
      const data = JSON.parse(carrier.to(CREATE)[0].form!.get('data')!);
      expect(data.shipments[0]).toMatchObject({
        payment_mode: 'Prepaid',
        cod_amount: 0,
        shipping_mode: 'Surface',
      });
      expect(data.shipments[0]).not.toHaveProperty('seller_gst_tin');
    });

    it('turns a "duplicate order" answer into the shipment that already exists, instead of failing or booking twice', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', CREATE, {
        body: {
          success: false,
          packages: [{ status: 'Fail', remarks: ['Duplicate order id'] }],
        },
      });
      carrier.on('GET', '/api/v1/packages/json/', {
        body: { ShipmentData: [{ Shipment: { AWB: '5540110000555' } }] },
      });
      const result = await provider.createShipment(CREDS, shipment());
      expect(result.awb).toBe('5540110000555');
      expect(
        carrier.to('/api/v1/packages/json/')[0].url.searchParams.get('ref_ids'),
      ).toBe('SF-2002');
      expect(carrier.to(CREATE)).toHaveLength(1);
    });

    it('passes on Delhivery’s reason for a refusal', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', CREATE, {
        body: {
          success: false,
          packages: [
            {
              status: 'Fail',
              remarks: ['Pincode not serviceable', 'Invalid phone'],
            },
          ],
          rmk: '',
        },
      });
      expect(
        await fail(provider.createShipment(CREDS, shipment())),
      ).toMatchObject({
        kind: 'rejected',
        message: 'Pincode not serviceable; Invalid phone',
      });
    });

    it('does not accept a success it cannot read, and never retries a booking', async () => {
      const odd = make();
      odd.carrier.on('POST', CREATE, { body: { hello: 'world' } });
      expect(
        (await fail(odd.provider.createShipment(CREDS, shipment()))).kind,
      ).toBe('invalid_response');
      const down = make();
      down.carrier.on('POST', CREATE, { status: 503 });
      expect(
        (await fail(down.provider.createShipment(CREDS, shipment()))).kind,
      ).toBe('unavailable');
      expect(down.carrier.to(CREATE)).toHaveLength(1);
    });

    it('refuses bad input before sending', async () => {
      const { carrier, provider } = make();
      expect(
        (
          await fail(
            provider.createShipment(CREDS, shipment({ paymentMode: 'cod' })),
          )
        ).kind,
      ).toBe('invalid_input');
      expect(
        (await fail(provider.createShipment(CREDS, shipment({ items: [] }))))
          .kind,
      ).toBe('invalid_input');
      const badPin = shipment();
      badPin.consignee.postalCode = '4000';
      expect((await fail(provider.createShipment(CREDS, badPin))).kind).toBe(
        'invalid_input',
      );
      expect(carrier.requests).toHaveLength(0);
    });
  });

  describe('cancelling, labels and tracking', () => {
    it('cancels with the documented body and only believes an explicit yes', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', '/api/p/edit', [
        { body: { status: true, remark: 'Waybill cancelled' } },
        { body: { status: false, error: 'Cannot cancel a delivered package' } },
        { body: { something: 'else' } },
      ]);
      expect(
        await provider.cancelShipment(CREDS, { awb: '5540110000123' }),
      ).toEqual({ cancelled: true, message: 'Waybill cancelled' });
      expect(carrier.to('/api/p/edit')[0].json).toEqual({
        waybill: '5540110000123',
        cancellation: 'true',
      });
      expect(
        await fail(provider.cancelShipment(CREDS, { awb: '5540110000123' })),
      ).toMatchObject({
        kind: 'rejected',
        message: 'Cannot cancel a delivered package',
      });
      expect(
        (await fail(provider.cancelShipment(CREDS, { awb: '5540110000123' })))
          .kind,
      ).toBe('invalid_response');
    });

    it('finds the label link, and fails clearly when there is none', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', '/api/p/packing_slip', [
        {
          body: {
            packages_found: 1,
            packages: [
              {
                pdf_download_link:
                  'https://delhivery-labels.s3.amazonaws.com/x.pdf',
              },
            ],
          },
        },
        { body: { packages: [{ barcode: 'abc' }] } },
      ]);
      expect(
        await provider.generateShippingLabel(CREDS, { awb: '5540110000123' }),
      ).toEqual({ url: 'https://delhivery-labels.s3.amazonaws.com/x.pdf' });
      expect(
        carrier.to('/api/p/packing_slip')[0].url.searchParams.get('wbns'),
      ).toBe('5540110000123');
      expect(
        (
          await fail(
            provider.generateShippingLabel(CREDS, { awb: '5540110000123' }),
          )
        ).kind,
      ).toBe('invalid_response');
    });

    it('reads tracking, newest first, and lets Delhivery’s own status type decide delivered/returned', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', '/api/v1/packages/json/', {
        body: {
          ShipmentData: [
            {
              Shipment: {
                AWB: '5540110000123',
                Status: {
                  Status: 'Delivered',
                  StatusType: 'DL',
                  StatusDateTime: '2026-11-26T14:00:00',
                },
                ExpectedDeliveryDate: '2026-11-26T23:59:00',
                Scans: [
                  {
                    ScanDetail: {
                      Scan: 'Manifested',
                      ScanDateTime: '2026-11-23T10:00:00',
                      ScannedLocation: 'Bengaluru',
                      Instructions: 'Manifest uploaded',
                    },
                  },
                  {
                    ScanDetail: {
                      Scan: 'In Transit',
                      ScanDateTime: '2026-11-24T08:00:00',
                      ScannedLocation: 'Pune Hub',
                      Instructions: 'Shipment received at facility',
                    },
                  },
                  {
                    ScanDetail: {
                      Scan: 'Delivered',
                      ScanDateTime: '2026-11-26T14:00:00',
                      ScannedLocation: 'Mumbai',
                      Instructions: 'Delivered to consignee',
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const t = await provider.trackShipment(CREDS, { awb: '5540110000123' });
      expect(t).toMatchObject({ status: 'delivered', statusText: 'Delivered' });
      expect(t.events.map((e) => e.status)).toEqual([
        'delivered',
        'in_transit',
        'pending',
      ]);
      expect(t.events[0]).toMatchObject({
        location: 'Mumbai',
        description: 'Delivered - Delivered to consignee',
      });
      expect(carrier.requests[0].url.searchParams.get('waybill')).toBe(
        '5540110000123',
      );
    });

    it('maps a returned shipment and an unknown AWB', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', '/api/v1/packages/json/', [
        {
          body: {
            ShipmentData: [
              {
                Shipment: {
                  Status: { Status: 'RTO In Transit', StatusType: 'RT' },
                  Scans: [],
                },
              },
            ],
          },
        },
        {
          body: {
            ShipmentData: [
              {
                Shipment: {
                  Status: { Status: 'Delivered', StatusType: 'RT' },
                  Scans: [],
                },
              },
            ],
          },
        },
        { body: { Error: 'Waybill not found' } },
        { body: { nonsense: true } },
      ]);
      expect(
        (await provider.trackShipment(CREDS, { awb: '5540110000123' })).status,
      ).toBe('returning');
      expect(
        (await provider.trackShipment(CREDS, { awb: '5540110000123' })).status,
      ).toBe('returned');
      expect(
        (await fail(provider.trackShipment(CREDS, { awb: '5540110000123' })))
          .kind,
      ).toBe('rejected');
      expect(
        (await fail(provider.trackShipment(CREDS, { awb: '5540110000123' })))
          .kind,
      ).toBe('invalid_response');
    });
  });

  it('never puts the token into an error', async () => {
    const { carrier, provider } = make();
    carrier.on('POST', CREATE, {
      status: 400,
      body: { rmk: `Bad token ${CREDS.apiToken} sent` },
    });
    const error = await fail(provider.createShipment(CREDS, shipment()));
    expect(error.message).not.toContain(CREDS.apiToken);
  });
});
