import { Injectable } from '@nestjs/common';
import {
  assertPincode,
  CarrierHttp,
  minorToRupees,
  normalizeStatus,
  parseDate,
  phone10,
  readCreds,
  rupeesToMinor,
  safeUrl,
} from './carrier-http.js';
import {
  CarrierError,
  type CancelResult,
  type CarrierCredentials,
  type CarrierService,
  type CredentialCheck,
  type CredentialField,
  type LabelResult,
  type ProviderCapabilities,
  type RateQuote,
  type ServiceabilityQuery,
  type ServiceabilityResult,
  type ShipmentInput,
  type ShipmentRef,
  type ShipmentResult,
  type ShippingProvider,
  type TrackingEvent,
  type TrackingResult,
  type TrackingStatus,
} from './shipping-provider.js';

const NAME = 'Delhivery';
const HOSTS = {
  production: 'https://track.delhivery.com',
  staging: 'https://staging-express.delhivery.com',
} as const;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim()
    ? v.trim()
    : typeof v === 'number'
      ? String(v)
      : null;
const yes = (v: unknown) => typeof v === 'string' && v.toUpperCase() === 'Y';

const MODES: readonly CarrierService[] = [
  { code: 'S', name: 'Surface' },
  { code: 'E', name: 'Express' },
];
const MODE_NAME: Record<string, string> = { S: 'Surface', E: 'Express' };

/** Finds a value under `key` anywhere in a (small) JSON answer. */
function deepFind(value: unknown, key: string, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object')
    return undefined;
  if (!Array.isArray(value) && key in (value as Json))
    return (value as Json)[key];
  for (const v of Array.isArray(value) ? value : Object.values(value as Json)) {
    const found = deepFind(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Delhivery (a courier with its own network).
 *
 * Verified against Delhivery's published API reference: the production and staging addresses and the paths for PIN code
 * serviceability, package creation, packing slip, cancellation, tracking (including lookup by our own reference) and the
 * shipping-charge estimate; the documented fields `wbns`, `waybill`, `cancellation`, `ref_ids`, `md`, `cgm`, `o_pin`, `d_pin`,
 * `ss`, and the tracking structure ShipmentData > Shipment > Status/Scans. NOT verified (the pages did not state them): the
 * `Authorization: Token` header, the exact create-response fields, the cancel answer and the packing-slip PDF link. Needs a run
 * against a real Delhivery account (staging works) before it carries real orders.
 */
@Injectable()
export class DelhiveryProvider implements ShippingProvider {
  readonly code = 'delhivery';
  readonly name = NAME;
  readonly integrationStatus = 'partially_documented' as const;
  readonly integrationNotes =
    'Endpoints and paths match the published Delhivery API reference. The token header, the create and cancel answers and the label link follow common practice and still need a check against a real (staging) account. Rates are Delhivery’s own approximation and have no delivery-time estimate.';
  readonly capabilities: ProviderCapabilities = {
    serviceability: true,
    rateQuotes: true,
    ratesAreEstimates: true,
    createShipment: true,
    cancelShipment: true,
    labels: true,
    tracking: true,
    trackingWebhooks: true,
    cashOnDelivery: true,
  };
  readonly credentialFields: readonly CredentialField[] = [
    {
      key: 'apiToken',
      label: 'API token',
      required: true,
      secret: true,
      help: 'From the Delhivery One developer portal.',
    },
    {
      key: 'pickupLocation',
      label: 'Pickup location name',
      required: true,
      secret: false,
      help: 'The exact (case-sensitive) name of a warehouse registered with Delhivery.',
    },
    {
      key: 'environment',
      label: 'Environment',
      required: false,
      secret: false,
      options: ['production', 'staging'],
      help: 'Use staging to test with Delhivery’s test servers. Defaults to production.',
    },
    {
      key: 'sellerGstin',
      label: 'GSTIN',
      required: false,
      secret: false,
      help: 'Sent with each shipment. Delhivery requires it on e-way bill shipments.',
    },
  ];

  constructor(private readonly http: CarrierHttp) {}

  async validateCredentials(
    creds: CarrierCredentials,
  ): Promise<CredentialCheck> {
    const c = this.creds(creds);
    try {
      // Delhivery has no "who am I" call, so a harmless lookup of one known PIN code is the proof that the token works.
      const res = await this.get(
        c,
        '/c/api/pin-codes/json/?filter_codes=110001',
      );
      if (!obj(res) || !Array.isArray(obj(res)?.delivery_codes))
        return {
          valid: false,
          message:
            'Delhivery answered, but not in the expected way. Check the environment setting.',
        };
    } catch (error) {
      if (
        error instanceof CarrierError &&
        (error.kind === 'auth' || error.kind === 'rejected')
      )
        return {
          valid: false,
          message:
            'Delhivery did not accept this API token for the chosen environment.',
        };
      throw error;
    }
    return { valid: true, message: 'Connected to Delhivery.' };
  }

  async getServiceability(
    creds: CarrierCredentials,
    q: ServiceabilityQuery,
  ): Promise<ServiceabilityResult> {
    const c = this.creds(creds);
    assertPincode('The delivery PIN code', q.destinationPostalCode);
    const res = obj(
      await this.get(
        c,
        `/c/api/pin-codes/json/?filter_codes=${q.destinationPostalCode}`,
      ),
    );
    if (!res || !Array.isArray(res.delivery_codes))
      throw new CarrierError(
        'invalid_response',
        'Delhivery sent serviceability in an unexpected shape.',
      );
    const pin = obj(obj(res.delivery_codes[0])?.postal_code);
    if (!pin)
      return {
        serviceable: false,
        codAvailable: null,
        prepaidAvailable: null,
        services: [],
        reason: 'Delhivery does not deliver to that PIN code.',
      };
    const cod = yes(pin.cod);
    const prepaid = yes(pin.pre_paid);
    const ok = q.paymentMode === 'cod' ? cod : prepaid;
    return {
      serviceable: ok,
      codAvailable: cod,
      prepaidAvailable: prepaid,
      services: ok ? [...MODES] : [],
      ...(ok
        ? {}
        : {
            reason:
              q.paymentMode === 'cod'
                ? 'Delhivery does not collect cash on delivery at that PIN code.'
                : 'Delhivery does not accept prepaid parcels for that PIN code.',
          }),
    };
  }

  async calculateShippingRates(
    creds: CarrierCredentials,
    q: ServiceabilityQuery,
  ): Promise<RateQuote[]> {
    const c = this.creds(creds);
    assertPincode('The pickup PIN code', q.originPostalCode);
    assertPincode('The delivery PIN code', q.destinationPostalCode);
    const quotes: RateQuote[] = [];
    let failure: CarrierError | undefined;
    for (const mode of MODES) {
      const params = new URLSearchParams({
        md: mode.code,
        ss: 'Delivered',
        d_pin: q.destinationPostalCode,
        o_pin: q.originPostalCode,
        cgm: String(Math.max(1, Math.round(q.parcel?.weightGrams ?? 500))),
        pt: q.paymentMode === 'cod' ? 'COD' : 'Pre-paid',
        ...(q.paymentMode === 'cod' && q.declaredValueMinor
          ? { cod: String(minorToRupees(q.declaredValueMinor)) }
          : {}),
      });
      try {
        const res = await this.get(
          c,
          `/api/kinko/v1/invoice/charges/.json?${params.toString()}`,
        );
        const row = obj(arr(res)[0]) ?? obj(res);
        const amountMinor = rupeesToMinor(row?.total_amount);
        if (amountMinor === null)
          throw new CarrierError(
            'invalid_response',
            'Delhivery sent a charge in an unexpected shape.',
          );
        quotes.push({
          serviceCode: mode.code,
          serviceName: mode.name,
          amountMinor,
          currency: 'INR',
          estimatedDeliveryDays: null,
          codChargeMinor: null,
          estimate: true,
        });
      } catch (error) {
        // A mode that cannot be priced (or refused) is simply not offered; trouble with every mode is reported.
        if (!(error instanceof CarrierError) || error.kind === 'auth')
          throw error;
        failure = error;
      }
    }
    if (quotes.length === 0 && failure) throw failure;
    return quotes;
  }

  async getAvailableServices(): Promise<CarrierService[]> {
    return [...MODES];
  }

  async createShipment(
    creds: CarrierCredentials,
    input: ShipmentInput,
  ): Promise<ShipmentResult> {
    const c = this.creds(creds);
    assertPincode('The delivery PIN code', input.consignee.postalCode);
    if (input.items.length === 0)
      throw new CarrierError(
        'invalid_input',
        'A shipment needs at least one item.',
      );
    if (input.paymentMode === 'cod' && !((input.codAmountMinor ?? 0) > 0))
      throw new CarrierError(
        'invalid_input',
        'A cash on delivery shipment needs the amount to collect.',
      );
    const mode =
      input.serviceCode && MODE_NAME[input.serviceCode]
        ? input.serviceCode
        : 'S';
    const hsn = input.items.find((i) => i.hsnCode)?.hsnCode;
    const data = {
      shipments: [
        {
          name: input.consignee.name,
          add: [input.consignee.line1, input.consignee.line2]
            .filter(Boolean)
            .join(', '),
          pin: input.consignee.postalCode,
          city: input.consignee.city,
          state: input.consignee.state,
          country: 'India',
          phone: phone10(input.consignee.phone),
          order: input.orderReference,
          payment_mode: input.paymentMode === 'cod' ? 'COD' : 'Prepaid',
          cod_amount:
            input.paymentMode === 'cod'
              ? minorToRupees(input.codAmountMinor!)
              : 0,
          total_amount: minorToRupees(input.declaredValueMinor),
          order_date: input.orderDate.toISOString(),
          products_desc: input.items
            .map((i) => i.name)
            .join(', ')
            .slice(0, 250),
          quantity: input.items.reduce((n, i) => n + i.quantity, 0),
          weight: Math.max(1, Math.round(input.parcel.weightGrams)),
          shipment_length: input.parcel.lengthCm ?? 10,
          shipment_width: input.parcel.breadthCm ?? 10,
          shipment_height: input.parcel.heightCm ?? 10,
          shipping_mode: MODE_NAME[mode],
          waybill: '',
          ...(hsn ? { hsn_code: hsn } : {}),
          ...(c.sellerGstin ? { seller_gst_tin: c.sellerGstin } : {}),
        },
      ],
      pickup_location: { name: c.pickupLocation },
    };
    // Never retried: a repeat after an unseen success would book twice.
    const res = obj(
      (
        await this.http.request({
          carrier: NAME,
          method: 'POST',
          url: `${this.host(c)}/api/cmu/create.json`,
          headers: this.auth(c),
          form: { format: 'json', data: JSON.stringify(data) },
          secrets: [c.apiToken],
        })
      ).body,
    );
    const pkg = obj(arr(res?.packages)[0]);
    const awb = text(pkg?.waybill);
    if (pkg && String(pkg.status).toLowerCase() === 'success' && awb)
      return this.shipment(awb, mode, input.orderReference);

    const reason =
      [...arr(pkg?.remarks).map(text), text(res?.rmk)]
        .filter(Boolean)
        .join('; ') || 'Delhivery rejected the shipment.';
    if (/duplicate|already/i.test(reason)) {
      // Our reference was booked before (for example an earlier call that timed out): return that shipment instead of failing.
      const existing = await this.find(c, input.orderReference);
      if (existing) return this.shipment(existing, mode, input.orderReference);
    }
    if (!res || (!pkg && !text(res.rmk)))
      throw new CarrierError(
        'invalid_response',
        'Delhivery sent the shipment answer in an unexpected shape.',
      );
    throw new CarrierError('rejected', reason.slice(0, 200));
  }

  async cancelShipment(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<CancelResult> {
    const c = this.creds(creds);
    const res = obj(
      (
        await this.http.request({
          carrier: NAME,
          method: 'POST',
          url: `${this.host(c)}/api/p/edit`,
          headers: this.auth(c),
          json: { waybill: ref.awb, cancellation: 'true' },
          secrets: [c.apiToken],
        })
      ).body,
    );
    const message =
      text(res?.remark) ??
      text(res?.message) ??
      text(res?.error) ??
      text(res?.rmk);
    // Only an explicit yes counts: a cancellation we are not sure about must never be recorded as done.
    if (res?.status === true || res?.success === true)
      return { cancelled: true, message };
    if (res?.status === false || res?.success === false || res?.error)
      throw new CarrierError(
        'rejected',
        (message ?? 'Delhivery could not cancel this shipment.').slice(0, 200),
      );
    throw new CarrierError(
      'invalid_response',
      'Delhivery did not say whether the cancellation worked.',
    );
  }

  async generateShippingLabel(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<LabelResult> {
    const c = this.creds(creds);
    const res = await this.get(
      c,
      `/api/p/packing_slip?wbns=${encodeURIComponent(ref.awb)}&pdf=true&pdf_size=A4`,
    );
    const url = safeUrl(
      deepFind(res, 'pdf_download_link') ?? deepFind(res, 'pdf_url'),
    );
    if (!url)
      throw new CarrierError(
        'invalid_response',
        'Delhivery did not return a label PDF for this shipment.',
      );
    return { url };
  }

  async trackShipment(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<TrackingResult> {
    const c = this.creds(creds);
    if (!/^[A-Za-z0-9-]{6,40}$/.test(ref.awb))
      throw new CarrierError('invalid_input', 'That AWB number is not valid.');
    const res = obj(
      await this.get(
        c,
        `/api/v1/packages/json/?waybill=${encodeURIComponent(ref.awb)}`,
      ),
    );
    const shipment = obj(obj(arr(res?.ShipmentData)[0])?.Shipment);
    if (!shipment) {
      // "No such shipment" only when Delhivery says so; anything else is an answer we do not understand.
      if (
        res &&
        (res.Error ||
          (Array.isArray(res.ShipmentData) && res.ShipmentData.length === 0))
      )
        throw new CarrierError(
          'rejected',
          'Delhivery has no shipment with that AWB number.',
        );
      throw new CarrierError(
        'invalid_response',
        'Delhivery sent tracking in an unexpected shape.',
      );
    }
    const status = obj(shipment.Status);
    const events: TrackingEvent[] = arr(shipment.Scans)
      .map((s) => obj(obj(s)?.ScanDetail))
      .filter((d): d is Json => d !== null)
      .map((d) => ({
        at: parseDate(d.ScanDateTime) ?? parseDate(d.StatusDateTime),
        status: normalizeStatus(
          `${text(d.Scan) ?? ''} ${text(d.Instructions) ?? ''}`,
        ),
        description: [text(d.Scan), text(d.Instructions)]
          .filter(Boolean)
          .join(' - '),
        location: text(d.ScannedLocation),
      }))
      .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    const statusText =
      text(status?.Status) ?? events[0]?.description ?? 'No updates yet';
    return {
      awb: ref.awb,
      status: this.statusOf(text(status?.StatusType), statusText),
      statusText,
      trackingUrl: `https://www.delhivery.com/track/package/${encodeURIComponent(ref.awb)}`,
      estimatedDelivery:
        parseDate(shipment.ExpectedDeliveryDate) ??
        parseDate(shipment.PromisedDeliveryDate),
      events,
    };
  }

  // --- internals -------------------------------------------------------------------------------------------------------

  private creds(creds: CarrierCredentials) {
    return readCreds(NAME, creds, this.credentialFields);
  }

  private host(c: Record<string, string>): string {
    return (
      HOSTS[(c.environment as keyof typeof HOSTS) ?? 'production'] ??
      HOSTS.production
    );
  }

  private auth(c: Record<string, string>) {
    return { Authorization: `Token ${c.apiToken}` };
  }

  private async get(c: Record<string, string>, path: string): Promise<unknown> {
    return (
      await this.http.request({
        carrier: NAME,
        method: 'GET',
        url: `${this.host(c)}${path}`,
        headers: this.auth(c),
        retry: true,
        secrets: [c.apiToken],
      })
    ).body;
  }

  private shipment(
    awb: string,
    mode: string,
    reference: string,
  ): ShipmentResult {
    return {
      awb,
      providerOrderId: reference,
      courierName: NAME,
      serviceCode: mode,
      trackingUrl: `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}`,
    };
  }

  /** The AWB Delhivery already holds for one of our references (documented `ref_ids` lookup). */
  private async find(
    c: Record<string, string>,
    reference: string,
  ): Promise<string | null> {
    try {
      const res = obj(
        await this.get(
          c,
          `/api/v1/packages/json/?ref_ids=${encodeURIComponent(reference)}`,
        ),
      );
      return text(obj(obj(arr(res?.ShipmentData)[0])?.Shipment)?.AWB);
    } catch (error) {
      if (error instanceof CarrierError && error.kind !== 'auth') return null;
      throw error;
    }
  }

  private statusOf(type: string | null, statusText: string): TrackingStatus {
    const byText = normalizeStatus(statusText);
    if (type === 'DL') return 'delivered';
    if (type === 'CN') return 'cancelled';
    if (type === 'RT') return byText === 'delivered' ? 'returned' : 'returning';
    return byText;
  }
}
