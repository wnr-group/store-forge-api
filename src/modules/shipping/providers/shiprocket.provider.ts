import { Injectable } from '@nestjs/common';
import {
  assertPincode,
  CarrierHttp,
  gramsToKg,
  normalizeStatus,
  parseDate,
  phone10,
  readCreds,
  rupeesToMinor,
  safeUrl,
  TokenCache,
  minorToRupees,
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
} from './shipping-provider.js';

const BASE = 'https://apiv2.shiprocket.in/v1/external';
const NAME = 'Shiprocket';

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
const flag = (v: unknown): boolean => v === 1 || v === '1' || v === true;

const pad = (n: number) => String(n).padStart(2, '0');
/** Shiprocket wants `YYYY-MM-DD HH:mm` in Indian time. */
function ist(date: Date): string {
  const d = new Date(date.getTime() + 5.5 * 3_600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * Shiprocket (an aggregator: one account, many couriers).
 *
 * Verified against Shiprocket's published documentation: the base URL, login, courier serviceability, ad-hoc order creation,
 * AWB assignment, label generation and tracking endpoints. NOT verified from the documentation (it could not be read in full):
 * the exact request and response field names, and the cancellation endpoints; those follow Shiprocket's well-known API and
 * every response is parsed defensively (an unexpected shape is an error, never a success). Needs a run against a real
 * Shiprocket API user before it carries real orders.
 */
@Injectable()
export class ShiprocketProvider implements ShippingProvider {
  readonly code = 'shiprocket';
  readonly name = NAME;
  readonly integrationStatus = 'partially_documented' as const;
  readonly integrationNotes =
    'Endpoints match the published Shiprocket API. Field names and the cancel endpoints come from integration experience and still need a check against a real API user.';
  readonly capabilities: ProviderCapabilities = {
    serviceability: true,
    rateQuotes: true,
    ratesAreEstimates: false,
    createShipment: true,
    cancelShipment: true,
    labels: true,
    tracking: true,
    trackingWebhooks: true,
    cashOnDelivery: true,
  };
  readonly credentialFields: readonly CredentialField[] = [
    {
      key: 'email',
      label: 'API user email',
      required: true,
      secret: false,
      help: 'Create an API user in Shiprocket under Settings > API. Do not use your normal login.',
    },
    {
      key: 'password',
      label: 'API user password',
      required: true,
      secret: true,
    },
    {
      key: 'pickupLocation',
      label: 'Pickup location name',
      required: true,
      secret: false,
      help: 'The nickname of a pickup address saved in your Shiprocket account.',
    },
  ];

  // Shiprocket tokens last 10 days; refresh well before that.
  private readonly tokens = new TokenCache(8 * 24 * 3_600_000);

  constructor(private readonly http: CarrierHttp) {}

  // --- ShippingProvider ------------------------------------------------------------------------------------------------

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
            'Shiprocket did not accept this API user email and password.',
        };
      throw error;
    }
    // Best effort: the pickup location must exist in the account, or no order could ever be created.
    try {
      const res = await this.call(
        c,
        'GET',
        '/settings/company/pickup',
        undefined,
        true,
      );
      const names = arr(obj(obj(res)?.data)?.shipping_address).map((a) =>
        text(obj(a)?.pickup_location),
      );
      if (names.length > 0 && !names.includes(c.pickupLocation))
        return {
          valid: false,
          message: `Connected, but no pickup location named "${c.pickupLocation}" exists in this Shiprocket account.`,
        };
    } catch (error) {
      if (!(error instanceof CarrierError) || error.kind === 'unavailable')
        throw error;
    }
    return { valid: true, message: 'Connected to Shiprocket.' };
  }

  async getServiceability(
    creds: CarrierCredentials,
    q: ServiceabilityQuery,
  ): Promise<ServiceabilityResult> {
    const couriers = await this.couriers(this.creds(creds), q);
    if (couriers.length === 0)
      return {
        serviceable: false,
        codAvailable: null,
        prepaidAvailable: null,
        services: [],
        reason: 'No courier on this account delivers to that PIN code.',
      };
    const cod = couriers.some((x) => flag(x.cod));
    return {
      serviceable: true,
      codAvailable: cod,
      prepaidAvailable: true,
      services: couriers.map((x) => ({
        code: String(x.courier_company_id),
        name: text(x.courier_name) ?? 'Courier',
      })),
    };
  }

  async calculateShippingRates(
    creds: CarrierCredentials,
    q: ServiceabilityQuery,
  ): Promise<RateQuote[]> {
    const couriers = await this.couriers(this.creds(creds), q);
    const quotes: RateQuote[] = [];
    for (const x of couriers) {
      const amountMinor = rupeesToMinor(x.rate);
      const id = text(x.courier_company_id);
      if (amountMinor === null || !id) continue; // an entry we cannot price is not offered
      const days = Number(x.estimated_delivery_days);
      quotes.push({
        serviceCode: id,
        serviceName: text(x.courier_name) ?? 'Courier',
        amountMinor,
        currency: 'INR',
        estimatedDeliveryDays: Number.isFinite(days) && days > 0 ? days : null,
        codChargeMinor:
          q.paymentMode === 'cod' ? rupeesToMinor(x.cod_charges) : null,
        estimate: false,
      });
    }
    return quotes;
  }

  async getAvailableServices(
    creds: CarrierCredentials,
    q?: ServiceabilityQuery,
  ): Promise<CarrierService[]> {
    if (!q)
      throw new CarrierError(
        'invalid_input',
        'Shiprocket lists the couriers for a route: give the pickup and delivery PIN codes.',
      );
    return (await this.getServiceability(creds, q)).services;
  }

  async createShipment(
    creds: CarrierCredentials,
    input: ShipmentInput,
  ): Promise<ShipmentResult> {
    const c = this.creds(creds);
    this.checkShipment(input);
    let providerOrderId = input.resume?.providerOrderId;
    let providerShipmentId = input.resume?.providerShipmentId;

    if (!providerShipmentId) {
      const [first, ...rest] = input.consignee.name.trim().split(/\s+/);
      const items = input.items.map((i) => ({
        name: i.name.slice(0, 100),
        sku: (i.sku ?? i.name).slice(0, 50),
        units: i.quantity,
        selling_price: minorToRupees(i.unitPriceMinor),
        ...(i.hsnCode ? { hsn: i.hsnCode } : {}),
      }));
      const created = obj(
        await this.call(c, 'POST', '/orders/create/adhoc', {
          order_id: input.orderReference,
          order_date: ist(input.orderDate),
          pickup_location: c.pickupLocation,
          billing_customer_name: first,
          billing_last_name: rest.join(' '),
          billing_address: input.consignee.line1,
          billing_address_2: input.consignee.line2 ?? '',
          billing_city: input.consignee.city,
          billing_pincode: input.consignee.postalCode,
          billing_state: input.consignee.state,
          billing_country: 'India',
          billing_email: input.consignee.email,
          billing_phone: phone10(input.consignee.phone),
          shipping_is_billing: true,
          order_items: items,
          payment_method: input.paymentMode === 'cod' ? 'COD' : 'Prepaid',
          sub_total: minorToRupees(
            input.paymentMode === 'cod'
              ? (input.codAmountMinor ?? input.declaredValueMinor)
              : input.declaredValueMinor,
          ),
          length: input.parcel.lengthCm ?? 10,
          breadth: input.parcel.breadthCm ?? 10,
          height: input.parcel.heightCm ?? 10,
          weight: gramsToKg(input.parcel.weightGrams),
        }),
      );
      providerOrderId = text(created?.order_id) ?? undefined;
      providerShipmentId = text(created?.shipment_id) ?? undefined;
      if (!providerShipmentId)
        throw new CarrierError(
          'invalid_response',
          'Shiprocket did not return a shipment id for the new order.',
        );
    }

    // From here on the order exists at Shiprocket: a failure must say so, so the caller resumes instead of creating it twice.
    const partial = { providerOrderId, providerShipmentId };
    try {
      const assigned = obj(
        await this.call(c, 'POST', '/courier/assign/awb', {
          shipment_id: Number(providerShipmentId),
          ...(input.serviceCode
            ? { courier_id: Number(input.serviceCode) }
            : {}),
        }),
      );
      const data = obj(obj(assigned?.response)?.data);
      const awb = text(data?.awb_code);
      if (!flag(assigned?.awb_assign_status) || !awb)
        throw new CarrierError(
          'rejected',
          text(data?.message) ??
            text(assigned?.message) ??
            'Shiprocket could not assign a courier to this shipment.',
        );
      return {
        awb,
        providerOrderId,
        providerShipmentId,
        courierName: text(data?.courier_name),
        serviceCode:
          text(data?.courier_company_id) ?? input.serviceCode ?? null,
        trackingUrl: `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`,
      };
    } catch (error) {
      if (error instanceof CarrierError)
        throw new CarrierError(error.kind, error.message, {
          ...error.options,
          partial,
        });
      throw error;
    }
  }

  async cancelShipment(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<CancelResult> {
    const c = this.creds(creds);
    if (ref.awb) {
      const res = obj(
        await this.call(c, 'POST', '/orders/cancel/shipment/awbs', {
          awbs: [ref.awb],
        }),
      );
      return { cancelled: true, message: text(res?.message) };
    }
    if (ref.providerOrderId) {
      const res = obj(
        await this.call(c, 'POST', '/orders/cancel', {
          ids: [Number(ref.providerOrderId)],
        }),
      );
      return { cancelled: true, message: text(res?.message) };
    }
    throw new CarrierError(
      'invalid_input',
      'Nothing to cancel: the shipment has no AWB or Shiprocket order id.',
    );
  }

  async generateShippingLabel(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<LabelResult> {
    if (!ref.providerShipmentId)
      throw new CarrierError(
        'invalid_input',
        'Shiprocket needs the shipment id to make a label.',
      );
    const res = obj(
      await this.call(this.creds(creds), 'POST', '/courier/generate/label', {
        shipment_id: [Number(ref.providerShipmentId)],
      }),
    );
    const url = safeUrl(res?.label_url);
    if (!flag(res?.label_created) || !url)
      throw new CarrierError(
        'rejected',
        text(res?.response) ?? 'Shiprocket could not create the label yet.',
      );
    return { url };
  }

  async trackShipment(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<TrackingResult> {
    if (!/^[A-Za-z0-9-]{6,40}$/.test(ref.awb))
      throw new CarrierError('invalid_input', 'That AWB number is not valid.');
    const res = obj(
      await this.call(
        this.creds(creds),
        'GET',
        `/courier/track/awb/${encodeURIComponent(ref.awb)}`,
        undefined,
        true,
      ),
    );
    const data = obj(res?.tracking_data);
    if (!data)
      throw new CarrierError(
        'invalid_response',
        'Shiprocket sent tracking in an unexpected shape.',
      );
    const current = text(obj(arr(data.shipment_track)[0])?.current_status);
    const events: TrackingEvent[] = arr(data.shipment_track_activities)
      .map((a) => obj(a))
      .filter((a): a is Json => a !== null)
      .map((a) => ({
        at: parseDate(a.date),
        status: normalizeStatus(text(a.activity) ?? text(a.status)),
        description: text(a.activity) ?? text(a.status) ?? '',
        location: text(a.location),
      }))
      .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    const statusText =
      current ?? events[0]?.description ?? text(data.error) ?? 'No updates yet';
    return {
      awb: ref.awb,
      status: current
        ? normalizeStatus(current)
        : (events[0]?.status ?? 'pending'),
      statusText,
      trackingUrl: safeUrl(data.track_url),
      estimatedDelivery: parseDate(data.etd),
      events,
    };
  }

  // --- internals -------------------------------------------------------------------------------------------------------

  private creds(creds: CarrierCredentials) {
    return readCreds(NAME, creds, this.credentialFields);
  }

  private checkShipment(i: ShipmentInput) {
    assertPincode('The delivery PIN code', i.consignee.postalCode);
    if (!i.consignee.email)
      throw new CarrierError(
        'invalid_input',
        'Shiprocket needs the customer’s email address.',
      );
    if (i.items.length === 0)
      throw new CarrierError(
        'invalid_input',
        'A shipment needs at least one item.',
      );
    if (i.paymentMode === 'cod' && !((i.codAmountMinor ?? 0) > 0))
      throw new CarrierError(
        'invalid_input',
        'A cash on delivery shipment needs the amount to collect.',
      );
  }

  /** Every courier of the account that can take this lane (and, for COD, can collect cash). */
  private async couriers(
    c: Record<string, string>,
    q: ServiceabilityQuery,
  ): Promise<Json[]> {
    assertPincode('The pickup PIN code', q.originPostalCode);
    assertPincode('The delivery PIN code', q.destinationPostalCode);
    const params = new URLSearchParams({
      pickup_postcode: q.originPostalCode,
      delivery_postcode: q.destinationPostalCode,
      weight: String(gramsToKg(q.parcel?.weightGrams ?? 500)),
      cod: q.paymentMode === 'cod' ? '1' : '0',
      ...(q.declaredValueMinor
        ? { declared_value: String(minorToRupees(q.declaredValueMinor)) }
        : {}),
    });
    let res: unknown;
    try {
      res = await this.call(
        c,
        'GET',
        `/courier/serviceability/?${params.toString()}`,
        undefined,
        true,
      );
    } catch (error) {
      // Shiprocket answers 404 when no courier serves the lane: that is an answer, not a failure.
      if (
        error instanceof CarrierError &&
        error.kind === 'rejected' &&
        error.options.status === 404
      )
        return [];
      throw error;
    }
    const list = obj(obj(res)?.data)?.available_courier_companies;
    if (list === undefined && obj(res)?.status === 404) return [];
    if (!Array.isArray(list))
      throw new CarrierError(
        'invalid_response',
        'Shiprocket sent serviceability in an unexpected shape.',
      );
    const all = list
      .map((x) => obj(x))
      .filter(
        (x): x is Json => x !== null && text(x.courier_company_id) !== null,
      );
    return q.paymentMode === 'cod' ? all.filter((x) => flag(x.cod)) : all;
  }

  private async token(
    c: Record<string, string>,
    forceFresh = false,
  ): Promise<string> {
    const key = TokenCache.keyOf('shiprocket', c.email, c.password);
    if (!forceFresh) {
      const cached = this.tokens.get(key);
      if (cached) return cached;
    }
    let res: unknown;
    try {
      res = (
        await this.http.request({
          carrier: NAME,
          method: 'POST',
          url: `${BASE}/auth/login`,
          json: { email: c.email, password: c.password },
          secrets: [c.password],
        })
      ).body;
    } catch (error) {
      // A wrong password may come back as 422 or 403: both mean "these credentials do not work".
      if (error instanceof CarrierError && error.kind === 'rejected')
        throw new CarrierError(
          'auth',
          `${NAME} did not accept the credentials.`,
        );
      throw error;
    }
    const token = text(obj(res)?.token);
    if (!token)
      throw new CarrierError(
        'invalid_response',
        'Shiprocket did not return a token.',
      );
    this.tokens.set(key, token);
    return token;
  }

  /** An authenticated call. A token that was revoked or expired early is replaced once, then the call is repeated. */
  private async call(
    c: Record<string, string>,
    method: 'GET' | 'POST',
    path: string,
    json?: unknown,
    retry = false,
  ): Promise<unknown> {
    const key = TokenCache.keyOf('shiprocket', c.email, c.password);
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.token(c, attempt > 0);
      try {
        return (
          await this.http.request({
            carrier: NAME,
            method,
            url: `${BASE}${path}`,
            headers: { Authorization: `Bearer ${token}` },
            json,
            retry,
            secrets: [c.password, token],
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
