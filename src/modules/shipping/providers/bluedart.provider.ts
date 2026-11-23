import { Injectable } from '@nestjs/common';
import {
  assertPincode,
  CarrierHttp,
  gramsToKg,
  minorToRupees,
  normalizeStatus,
  parseDate,
  phone10,
  readCreds,
  TokenCache,
} from './carrier-http.js';
import {
  CarrierError,
  unsupported,
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
} from './shipping-provider.js';

const NAME = 'Blue Dart';
const HOSTS = {
  production: 'https://apigateway.bluedart.com',
  sandbox: 'https://apigateway-sandbox.bluedart.com',
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

/**
 * The Blue Dart request profile that goes with every call.
 */
function profile(c: Record<string, string>) {
  return {
    LoginID: c.loginId,
    LicenceKey: c.licenceKey,
    Api_type: 'S',
    Version: '1.10',
  };
}

/** A WCF-style date, which is what Blue Dart's JSON services take: `/Date(1690000000000)/`. */
const wcfDate = (d: Date) => `/Date(${d.getTime()})/`;

/** The ways Blue Dart reports a failure inside an HTTP 200 answer. */
function failureOf(result: Json | null): string | null {
  if (!result) return 'Blue Dart sent an answer in an unexpected shape.';
  const statuses = arr(result.Status)
    .map((s) => text(obj(s)?.StatusInformation))
    .filter((s): s is string => s !== null);
  if (result.IsError === true || result.IsError === 'true')
    return (statuses.join('; ') || 'Blue Dart rejected the request.').slice(
      0,
      200,
    );
  return null;
}

/**
 * The waybill request. Kept in one function, away from the call, because the field-level shape is the part of this adapter that
 * could not be checked against Blue Dart's documentation (its pages are not publicly readable): a sandbox run will show
 * exactly what to adjust, and only this function and `parseWaybill` would change.
 */
export function buildWaybillRequest(
  c: Record<string, string>,
  input: ShipmentInput,
) {
  const cod = input.paymentMode === 'cod';
  const total = input.items.reduce((n, i) => n + i.quantity, 0);
  return {
    Request: {
      Consignee: {
        ConsigneeName: input.consignee.name.slice(0, 100),
        ConsigneeAddress1: input.consignee.line1.slice(0, 30),
        ConsigneeAddress2: (
          input.consignee.line2 ?? input.consignee.city
        ).slice(0, 30),
        ConsigneeAddress3: input.consignee.city.slice(0, 30),
        ConsigneePincode: input.consignee.postalCode,
        ConsigneeMobile: phone10(input.consignee.phone),
        ConsigneeEmailID: input.consignee.email ?? '',
      },
      Services: {
        AWBNo: '',
        ActualWeight: String(gramsToKg(input.parcel.weightGrams)),
        CollectableAmount: cod ? minorToRupees(input.codAmountMinor ?? 0) : 0,
        Commodity: {
          CommodityDetail1: input.items
            .map((i) => i.name)
            .join(', ')
            .slice(0, 30),
        },
        CreditReferenceNo: input.orderReference,
        DeclaredValue: minorToRupees(input.declaredValueMinor),
        Dimensions: [
          {
            Length: input.parcel.lengthCm ?? 10,
            Breadth: input.parcel.breadthCm ?? 10,
            Height: input.parcel.heightCm ?? 10,
            Count: 1,
          },
        ],
        PickupDate: wcfDate(input.orderDate),
        PickupTime: '1600',
        PieceCount: String(total),
        ProductCode: input.serviceCode ?? c.productCode ?? 'A',
        ProductType: 1,
        SubProductCode: cod ? 'C' : 'P',
      },
      Shipper: {
        CustomerCode: c.customerCode,
        OriginArea: c.originArea,
        CustomerName: input.pickup.name.slice(0, 100),
        CustomerAddress1: input.pickup.line1.slice(0, 30),
        CustomerAddress2: (input.pickup.line2 ?? input.pickup.city).slice(
          0,
          30,
        ),
        CustomerAddress3: input.pickup.city.slice(0, 30),
        CustomerPincode: input.pickup.postalCode,
        CustomerMobile: phone10(input.pickup.phone),
        CustomerEmailID: input.pickup.email ?? '',
        IsToPayCustomer: false,
      },
    },
    Profile: profile(c),
  };
}

/** AWBPrintContent arrives either as base64 text or as a list of byte values. */
function pdfBase64(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number')
  )
    return Buffer.from(value as number[]).toString('base64');
  return undefined;
}

/**
 * Blue Dart.
 *
 * UNVERIFIED. Blue Dart's developer documentation is not publicly readable, so only these facts were confirmed from public
 * sources: the production waybill address (`.../in/transportation/waybill/v1/GenerateWayBill`), that every call carries a JWT
 * obtained from an authenticator call with the customer's API key and secret, and that a waybill answer contains `AWBNo` and
 * `AWBPrintContent`. Everything else (the token address, request bodies, the cancel and tracking calls) is written from the
 * known shape of this API and must be run against Blue Dart's sandbox before real use.
 *
 * Blue Dart gives no public price quote, so rates come from the tenant's own contract (shipping methods) and
 * `calculateShippingRates` is unsupported. Serviceability, service lookup and re-fetching a label are left unsupported rather
 * than guessed: the label comes back once, with the shipment.
 */
@Injectable()
export class BlueDartProvider implements ShippingProvider {
  readonly code = 'bluedart';
  readonly name = NAME;
  readonly integrationStatus = 'unverified' as const;
  readonly integrationNotes =
    'Built from the known shape of the Blue Dart API; its documentation could not be read. It must be run against the Blue Dart sandbox before real use. No rate quotes, serviceability lookup or label re-print through the API.';
  readonly capabilities: ProviderCapabilities = {
    serviceability: false,
    rateQuotes: false,
    ratesAreEstimates: false,
    createShipment: true,
    cancelShipment: true,
    labels: false,
    tracking: true,
    trackingWebhooks: false,
    cashOnDelivery: true,
  };
  readonly credentialFields: readonly CredentialField[] = [
    {
      key: 'clientId',
      label: 'API key (Client ID)',
      required: true,
      secret: true,
      help: 'From the Blue Dart developer portal, under My Apps.',
    },
    { key: 'clientSecret', label: 'API secret', required: true, secret: true },
    { key: 'loginId', label: 'Login ID', required: true, secret: false },
    { key: 'licenceKey', label: 'Licence key', required: true, secret: true },
    {
      key: 'customerCode',
      label: 'Customer code',
      required: true,
      secret: false,
    },
    {
      key: 'originArea',
      label: 'Origin area code',
      required: true,
      secret: false,
      help: 'The three-letter area code of your pickup city, for example DEL.',
    },
    {
      key: 'productCode',
      label: 'Product code',
      required: false,
      secret: false,
      help: 'Blue Dart product code to book with. Defaults to A.',
    },
    {
      key: 'environment',
      label: 'Environment',
      required: false,
      secret: false,
      options: ['production', 'sandbox'],
      help: 'Defaults to production.',
    },
  ];

  // The lifetime of a Blue Dart token is not published: keep it briefly and renew it on any refusal.
  private readonly tokens = new TokenCache(30 * 60_000);

  constructor(private readonly http: CarrierHttp) {}

  async validateCredentials(
    creds: CarrierCredentials,
  ): Promise<CredentialCheck> {
    const c = this.creds(creds);
    try {
      await this.token(c, true);
    } catch (error) {
      if (
        error instanceof CarrierError &&
        (error.kind === 'auth' || error.kind === 'rejected')
      )
        return {
          valid: false,
          message:
            'Blue Dart did not accept this API key and secret for the chosen environment.',
        };
      throw error;
    }
    return {
      valid: true,
      message:
        'Blue Dart accepted the API key and secret. The login ID and licence key are checked when the first shipment is booked.',
    };
  }

  getServiceability(): Promise<ServiceabilityResult> {
    return Promise.reject(unsupported(NAME, 'a PIN code serviceability check'));
  }

  calculateShippingRates(
    _creds: CarrierCredentials,
    _q: ServiceabilityQuery,
  ): Promise<RateQuote[]> {
    return Promise.reject(
      unsupported(
        NAME,
        'price quotes (rates follow your own Blue Dart contract)',
      ),
    );
  }

  getAvailableServices(): Promise<CarrierService[]> {
    return Promise.reject(unsupported(NAME, 'a service lookup'));
  }

  async createShipment(
    creds: CarrierCredentials,
    input: ShipmentInput,
  ): Promise<ShipmentResult> {
    const c = this.creds(creds);
    assertPincode('The delivery PIN code', input.consignee.postalCode);
    assertPincode('The pickup PIN code', input.pickup.postalCode);
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

    const res = obj(
      await this.call(
        c,
        'POST',
        '/in/transportation/waybill/v1/GenerateWayBill',
        buildWaybillRequest(c, input),
      ),
    );
    const result = obj(res?.GenerateWayBillResult);
    const failure = failureOf(result);
    if (failure)
      throw new CarrierError(result ? 'rejected' : 'invalid_response', failure);
    const awb = text(result?.AWBNo);
    if (!awb)
      throw new CarrierError(
        'invalid_response',
        'Blue Dart did not return an AWB number.',
      );
    const content = pdfBase64(result?.AWBPrintContent);
    return {
      awb,
      providerOrderId: input.orderReference,
      courierName: NAME,
      serviceCode: input.serviceCode ?? c.productCode ?? 'A',
      trackingUrl: `https://www.bluedart.com/tracking?trackFor=0&trackNo=${encodeURIComponent(awb)}`,
      ...(content ? { label: { pdfBase64: content } } : {}),
    };
  }

  async cancelShipment(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<CancelResult> {
    const c = this.creds(creds);
    const res = obj(
      await this.call(
        c,
        'POST',
        '/in/transportation/waybill/v1/CancelWaybill',
        { Request: { AWBNo: ref.awb }, Profile: profile(c) },
      ),
    );
    const result = obj(res?.CancelWaybillResult);
    const failure = failureOf(result);
    if (failure)
      throw new CarrierError(result ? 'rejected' : 'invalid_response', failure);
    // Only an explicit "no error" counts as cancelled.
    if (result?.IsError !== false && result?.IsError !== 'false')
      throw new CarrierError(
        'invalid_response',
        'Blue Dart did not say whether the cancellation worked.',
      );
    return {
      cancelled: true,
      message: text(obj(arr(result.Status)[0])?.StatusInformation),
    };
  }

  generateShippingLabel(): Promise<LabelResult> {
    return Promise.reject(
      unsupported(
        NAME,
        're-printing a label (the label is returned once, when the shipment is booked)',
      ),
    );
  }

  async trackShipment(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<TrackingResult> {
    const c = this.creds(creds);
    if (!/^[A-Za-z0-9-]{6,40}$/.test(ref.awb))
      throw new CarrierError('invalid_input', 'That AWB number is not valid.');
    const query = new URLSearchParams({
      handler: 'tnt',
      action: 'custawbquery',
      loginid: c.loginId,
      awb: 'awb',
      numbers: ref.awb,
      format: 'json',
      lickey: c.licenceKey,
      verno: '1',
      scan: '1',
    });
    const res = obj(
      await this.call(
        c,
        'GET',
        `/in/transportation/tracking/v1/shipment?${query.toString()}`,
        undefined,
        true,
      ),
    );
    const holder = obj(res?.ShipmentData);
    const shipment = obj(
      Array.isArray(holder?.Shipment)
        ? (holder.Shipment as unknown[])[0]
        : holder?.Shipment,
    );
    if (!shipment)
      throw new CarrierError(
        'rejected',
        'Blue Dart has no tracking for that AWB number yet.',
      );
    const scans = Array.isArray(shipment.Scans)
      ? shipment.Scans
      : arr(obj(shipment.Scans)?.ScanDetail).map((d) => ({ ScanDetail: d }));
    const events: TrackingEvent[] = scans
      .map((s) => obj(obj(s)?.ScanDetail))
      .filter((d): d is Json => d !== null)
      .map((d) => ({
        at: parseDate(
          `${text(d.ScanDate) ?? ''} ${text(d.ScanTime) ?? ''}`.trim(),
        ),
        status: normalizeStatus(text(d.Scan)),
        description: text(d.Scan) ?? '',
        location: text(d.ScannedLocation),
      }))
      .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    const statusText =
      text(shipment.Status) ?? events[0]?.description ?? 'No updates yet';
    return {
      awb: ref.awb,
      status: normalizeStatus(statusText),
      statusText,
      trackingUrl: `https://www.bluedart.com/tracking?trackFor=0&trackNo=${encodeURIComponent(ref.awb)}`,
      estimatedDelivery: parseDate(text(shipment.ExpectedDeliveryDate)),
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

  private secrets(c: Record<string, string>, token?: string) {
    return [
      c.clientId,
      c.clientSecret,
      c.licenceKey,
      ...(token ? [token] : []),
    ];
  }

  private async token(
    c: Record<string, string>,
    forceFresh = false,
  ): Promise<string> {
    const key = TokenCache.keyOf(
      'bluedart',
      c.environment ?? 'production',
      c.clientId,
      c.clientSecret,
    );
    if (!forceFresh) {
      const cached = this.tokens.get(key);
      if (cached) return cached;
    }
    let body: unknown;
    try {
      body = (
        await this.http.request({
          carrier: NAME,
          method: 'GET',
          url: `${this.host(c)}/in/transportation/token/v1/login`,
          headers: { ClientID: c.clientId, clientSecret: c.clientSecret },
          secrets: this.secrets(c),
        })
      ).body;
    } catch (error) {
      if (error instanceof CarrierError && error.kind === 'rejected')
        throw new CarrierError(
          'auth',
          `${NAME} did not accept the credentials.`,
        );
      throw error;
    }
    const token = text(obj(body)?.JWTToken);
    if (!token)
      throw new CarrierError(
        'invalid_response',
        'Blue Dart did not return a token.',
      );
    this.tokens.set(key, token);
    return token;
  }

  /** An authenticated call; a refused token is replaced once and the call repeated. */
  private async call(
    c: Record<string, string>,
    method: 'GET' | 'POST',
    path: string,
    json?: unknown,
    retry = false,
  ): Promise<unknown> {
    const key = TokenCache.keyOf(
      'bluedart',
      c.environment ?? 'production',
      c.clientId,
      c.clientSecret,
    );
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.token(c, attempt > 0);
      try {
        return (
          await this.http.request({
            carrier: NAME,
            method,
            url: `${this.host(c)}${path}`,
            headers: { JWTToken: token },
            json,
            retry,
            secrets: this.secrets(c, token),
          })
        ).body;
      } catch (error) {
        if (
          error instanceof CarrierError &&
          error.kind === 'auth' &&
          attempt === 0
        ) {
          this.tokens.delete(key);
          continue;
        }
        throw error;
      }
    }
  }
}
