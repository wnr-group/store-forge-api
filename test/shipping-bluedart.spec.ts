import { describe, expect, it } from 'vitest';
import {
  BlueDartProvider,
  buildWaybillRequest,
} from '../src/modules/shipping/providers/bluedart.provider.js';
import { CarrierHttp } from '../src/modules/shipping/providers/carrier-http.js';
import {
  CarrierError,
  type ShipmentInput,
} from '../src/modules/shipping/providers/shipping-provider.js';
import { FakeCarrier } from './support/fake-carrier.js';

const CREDS = {
  clientId: 'bd-client-id-secret',
  clientSecret: 'bd-client-secret-value',
  loginId: 'DEL12345',
  licenceKey: 'bd-licence-key-secret',
  customerCode: '123456',
  originArea: 'BLR',
};
const TOKEN = '/in/transportation/token/v1/login';
const WAYBILL = '/in/transportation/waybill/v1/GenerateWayBill';
const CANCEL = '/in/transportation/waybill/v1/CancelWaybill';
const TRACK = '/in/transportation/tracking/v1/shipment';

const make = () => {
  const carrier = new FakeCarrier();
  carrier.on('GET', TOKEN, { body: { JWTToken: 'jwt-secret-token-xyz' } });
  const provider = new BlueDartProvider(
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
const shipment = (over: Partial<ShipmentInput> = {}): ShipmentInput => ({
  orderReference: 'SF-3003',
  orderNumber: 3003,
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
  items: [{ name: 'Ceramic mug', quantity: 2, unitPriceMinor: 75000 }],
  parcel: { weightGrams: 750 },
  ...over,
});

describe('Blue Dart adapter', () => {
  it('says plainly that it is unverified and what it cannot do', () => {
    const { provider } = make();
    expect(provider).toMatchObject({
      code: 'bluedart',
      integrationStatus: 'unverified',
    });
    expect(provider.integrationNotes).toMatch(/sandbox/i);
    expect(provider.capabilities).toMatchObject({
      serviceability: false,
      rateQuotes: false,
      labels: false,
      createShipment: true,
      cancelShipment: true,
      tracking: true,
    });
  });

  it('leaves what it cannot do unsupported instead of guessing', async () => {
    const { carrier, provider } = make();
    const q = {
      originPostalCode: '560001',
      destinationPostalCode: '400001',
      paymentMode: 'prepaid' as const,
    };
    for (const work of [
      provider.getServiceability(),
      provider.calculateShippingRates(CREDS, q),
      provider.getAvailableServices(),
      provider.generateShippingLabel(),
    ])
      expect((await fail(work)).kind).toBe('unsupported');
    expect(carrier.requests).toHaveLength(0);
  });

  describe('credentials and token', () => {
    it('logs in with the API key and secret and accepts them', async () => {
      const { carrier, provider } = make();
      expect((await provider.validateCredentials(CREDS)).valid).toBe(true);
      const req = carrier.to(TOKEN)[0];
      expect(req.url.origin).toBe('https://apigateway.bluedart.com');
      expect(req.headers.get('clientid')).toBe(CREDS.clientId);
      expect(req.headers.get('clientsecret')).toBe(CREDS.clientSecret);
    });

    it('uses the sandbox when asked and says "not valid" for refused keys, but errors on an outage', async () => {
      const sandbox = make();
      await sandbox.provider.validateCredentials({
        ...CREDS,
        environment: 'sandbox',
      });
      expect(sandbox.carrier.requests[0].url.origin).toBe(
        'https://apigateway-sandbox.bluedart.com',
      );

      const refused = new FakeCarrier().on('GET', TOKEN, { status: 401 });
      expect(
        (
          await new BlueDartProvider(
            new CarrierHttp(refused.fetch),
          ).validateCredentials(CREDS)
        ).valid,
      ).toBe(false);
      const bad = new FakeCarrier().on('GET', TOKEN, {
        status: 400,
        body: { message: 'Invalid client' },
      });
      expect(
        (
          await new BlueDartProvider(
            new CarrierHttp(bad.fetch),
          ).validateCredentials(CREDS)
        ).valid,
      ).toBe(false);
      const down = new FakeCarrier().on('GET', TOKEN, { status: 503 });
      expect(
        (
          await fail(
            new BlueDartProvider(
              new CarrierHttp(down.fetch, { timeoutMs: 500, retryDelayMs: 0 }),
            ).validateCredentials(CREDS),
          )
        ).kind,
      ).toBe('unavailable');
      const empty = new FakeCarrier().on('GET', TOKEN, { body: {} });
      expect(
        (
          await fail(
            new BlueDartProvider(
              new CarrierHttp(empty.fetch),
            ).validateCredentials(CREDS),
          )
        ).kind,
      ).toBe('invalid_response');
    });

    it('reuses the token and replaces one that is refused', async () => {
      const carrier = new FakeCarrier();
      carrier.on('GET', TOKEN, [
        { body: { JWTToken: 'first-token-1' } },
        { body: { JWTToken: 'second-token-2' } },
      ]);
      carrier.on('POST', CANCEL, [
        { status: 401 },
        {
          body: {
            CancelWaybillResult: {
              IsError: false,
              Status: [{ StatusInformation: 'Cancelled' }],
            },
          },
        },
      ]);
      const provider = new BlueDartProvider(
        new CarrierHttp(carrier.fetch, { timeoutMs: 1000, retryDelayMs: 0 }),
      );
      expect(
        (await provider.cancelShipment(CREDS, { awb: '70000000001' }))
          .cancelled,
      ).toBe(true);
      expect(carrier.to(TOKEN)).toHaveLength(2);
      expect(carrier.to(CANCEL)[1].headers.get('jwttoken')).toBe(
        'second-token-2',
      );
      await provider.cancelShipment(CREDS, { awb: '70000000002' });
      expect(carrier.to(TOKEN)).toHaveLength(2); // the new token is reused
    });
  });

  describe('creating a shipment', () => {
    const ok = (extra: object = {}) => ({
      GenerateWayBillResult: {
        AWBNo: '70000000123',
        IsError: false,
        Status: [{ StatusCode: 'Success', StatusInformation: 'Generated' }],
        ...extra,
      },
    });

    it('books a waybill and returns the label that comes with it (base64)', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', WAYBILL, {
        body: ok({ AWBPrintContent: 'JVBERi0xLjQK' }),
      });
      const result = await provider.createShipment(CREDS, shipment());
      expect(result).toMatchObject({
        awb: '70000000123',
        providerOrderId: 'SF-3003',
        courierName: 'Blue Dart',
        serviceCode: 'A',
        label: { pdfBase64: 'JVBERi0xLjQK' },
      });
      const req = carrier.to(WAYBILL)[0];
      expect(req.headers.get('jwttoken')).toBe('jwt-secret-token-xyz');
      expect(req.json).toMatchObject({
        Profile: {
          LoginID: 'DEL12345',
          LicenceKey: 'bd-licence-key-secret',
          Api_type: 'S',
        },
        Request: {
          Consignee: {
            ConsigneeName: 'Asha Rao',
            ConsigneePincode: '400001',
            ConsigneeMobile: '9876543210',
          },
          Shipper: {
            CustomerCode: '123456',
            OriginArea: 'BLR',
            CustomerPincode: '560001',
          },
          Services: {
            CreditReferenceNo: 'SF-3003',
            DeclaredValue: 1500,
            ActualWeight: '0.75',
            PieceCount: '2',
            ProductCode: 'A',
            SubProductCode: 'P',
            CollectableAmount: 0,
          },
        },
      });
    });

    it('accepts the label as a list of byte values too, and works without one', async () => {
      const bytes = Array.from(Buffer.from('%PDF-1.4'));
      const { carrier, provider } = make();
      carrier.on('POST', WAYBILL, [
        { body: ok({ AWBPrintContent: bytes }) },
        { body: ok() },
      ]);
      expect((await provider.createShipment(CREDS, shipment())).label).toEqual({
        pdfBase64: Buffer.from('%PDF-1.4').toString('base64'),
      });
      expect(
        await provider.createShipment(CREDS, shipment()),
      ).not.toHaveProperty('label');
    });

    it('books cash on delivery with the amount to collect and the chosen product', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', WAYBILL, { body: ok() });
      await provider.createShipment(
        { ...CREDS, productCode: 'D' },
        shipment({ paymentMode: 'cod', codAmountMinor: 154000 }),
      );
      expect(carrier.to(WAYBILL)[0].json).toMatchObject({
        Request: {
          Services: {
            SubProductCode: 'C',
            CollectableAmount: 1540,
            ProductCode: 'D',
          },
        },
      });
      await provider.createShipment(CREDS, shipment({ serviceCode: 'E' }));
      expect(carrier.to(WAYBILL)[1].json).toMatchObject({
        Request: { Services: { ProductCode: 'E' } },
      });
    });

    it('passes on Blue Dart’s reason when it reports an error inside a normal answer', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', WAYBILL, {
        body: {
          GenerateWayBillResult: {
            IsError: true,
            Status: [
              { StatusInformation: 'Pincode not serviceable' },
              { StatusInformation: 'Invalid area' },
            ],
          },
        },
      });
      expect(
        await fail(provider.createShipment(CREDS, shipment())),
      ).toMatchObject({
        kind: 'rejected',
        message: 'Pincode not serviceable; Invalid area',
      });
    });

    it('does not accept an answer without an AWB, or in a shape it does not know; never retries', async () => {
      const noAwb = make();
      noAwb.carrier.on('POST', WAYBILL, { body: ok({ AWBNo: '' }) });
      expect(
        (await fail(noAwb.provider.createShipment(CREDS, shipment()))).kind,
      ).toBe('invalid_response');
      const odd = make();
      odd.carrier.on('POST', WAYBILL, { body: { something: 1 } });
      expect(
        (await fail(odd.provider.createShipment(CREDS, shipment()))).kind,
      ).toBe('invalid_response');
      const down = make();
      down.carrier.on('POST', WAYBILL, { status: 503 });
      expect(
        (await fail(down.provider.createShipment(CREDS, shipment()))).kind,
      ).toBe('unavailable');
      expect(down.carrier.to(WAYBILL)).toHaveLength(1);
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
        (await fail(provider.createShipment({ clientId: 'only' }, shipment())))
          .kind,
      ).toBe('invalid_input');
      const badPin = shipment();
      badPin.pickup.postalCode = '5600';
      expect((await fail(provider.createShipment(CREDS, badPin))).kind).toBe(
        'invalid_input',
      );
      expect(carrier.requests).toHaveLength(0);
    });

    it('builds the waybill request as a plain function so a sandbox correction is local', () => {
      const body = buildWaybillRequest({ ...CREDS }, shipment());
      expect(Object.keys(body)).toEqual(['Request', 'Profile']);
      expect(Object.keys(body.Request)).toEqual([
        'Consignee',
        'Services',
        'Shipper',
      ]);
      expect(body.Request.Services.PickupDate).toBe(
        '/Date(1795408200000)/'.replace(
          '1795408200000',
          String(new Date('2026-11-23T04:30:00Z').getTime()),
        ),
      );
    });
  });

  describe('cancelling and tracking', () => {
    it('counts a cancellation only when Blue Dart says there was no error', async () => {
      const { carrier, provider } = make();
      carrier.on('POST', CANCEL, [
        {
          body: {
            CancelWaybillResult: {
              IsError: false,
              Status: [{ StatusInformation: 'Waybill cancelled' }],
            },
          },
        },
        {
          body: {
            CancelWaybillResult: {
              IsError: true,
              Status: [{ StatusInformation: 'Already picked up' }],
            },
          },
        },
        { body: { CancelWaybillResult: { Status: [] } } },
        { body: {} },
      ]);
      expect(
        await provider.cancelShipment(CREDS, { awb: '70000000123' }),
      ).toEqual({ cancelled: true, message: 'Waybill cancelled' });
      expect(carrier.to(CANCEL)[0].json).toEqual({
        Request: { AWBNo: '70000000123' },
        Profile: {
          LoginID: 'DEL12345',
          LicenceKey: 'bd-licence-key-secret',
          Api_type: 'S',
          Version: '1.10',
        },
      });
      expect(
        await fail(provider.cancelShipment(CREDS, { awb: '70000000123' })),
      ).toMatchObject({ kind: 'rejected', message: 'Already picked up' });
      expect(
        (await fail(provider.cancelShipment(CREDS, { awb: '70000000123' })))
          .kind,
      ).toBe('invalid_response');
      expect(
        (await fail(provider.cancelShipment(CREDS, { awb: '70000000123' })))
          .kind,
      ).toBe('invalid_response');
    });

    it('reads tracking, newest first', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', TRACK, {
        body: {
          ShipmentData: {
            Shipment: [
              {
                Status: 'Shipment Out For Delivery',
                ExpectedDeliveryDate: '2026-11-26T18:00:00',
                Scans: [
                  {
                    ScanDetail: {
                      Scan: 'Shipment Picked Up',
                      ScanDate: '2026-11-24',
                      ScanTime: '09:00',
                      ScannedLocation: 'Bengaluru',
                    },
                  },
                  {
                    ScanDetail: {
                      Scan: 'Shipment Out For Delivery',
                      ScanDate: '2026-11-26',
                      ScanTime: '08:10',
                      ScannedLocation: 'Mumbai',
                    },
                  },
                  {
                    ScanDetail: {
                      Scan: 'Shipment In Transit',
                      ScanDate: '2026-11-25',
                      ScanTime: '20:00',
                      ScannedLocation: 'Pune',
                    },
                  },
                ],
              },
            ],
          },
        },
      });
      const t = await provider.trackShipment(CREDS, { awb: '70000000123' });
      expect(t).toMatchObject({
        status: 'out_for_delivery',
        statusText: 'Shipment Out For Delivery',
      });
      expect(t.events.map((e) => e.location)).toEqual([
        'Mumbai',
        'Pune',
        'Bengaluru',
      ]);
      const q = carrier.to(TRACK)[0].url.searchParams;
      expect(q.get('numbers')).toBe('70000000123');
      expect(q.get('format')).toBe('json');
    });

    it('says so when there is no tracking, refuses odd AWBs, and an odd answer is not "no tracking"', async () => {
      const { carrier, provider } = make();
      carrier.on('GET', TRACK, [
        { body: { ShipmentData: {} } },
        { body: 'nonsense' },
      ]);
      expect(
        (await fail(provider.trackShipment(CREDS, { awb: '70000000123' })))
          .kind,
      ).toBe('rejected');
      expect(
        (await fail(provider.trackShipment(CREDS, { awb: '70000000123' })))
          .kind,
      ).toBe('rejected');
      expect(
        (await fail(provider.trackShipment(CREDS, { awb: 'a b' }))).kind,
      ).toBe('invalid_input');
    });
  });

  it('never puts a key, secret, licence key or token into an error', async () => {
    const { carrier, provider } = make();
    carrier.on('POST', WAYBILL, {
      status: 400,
      body: {
        message: `bad ${CREDS.clientSecret} ${CREDS.licenceKey} jwt-secret-token-xyz`,
      },
    });
    const error = await fail(provider.createShipment(CREDS, shipment()));
    for (const secret of [
      CREDS.clientId,
      CREDS.clientSecret,
      CREDS.licenceKey,
      'jwt-secret-token-xyz',
    ])
      expect(error.message).not.toContain(secret);
  });
});
