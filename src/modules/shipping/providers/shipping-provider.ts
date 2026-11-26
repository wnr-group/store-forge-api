/**
 * The contract every shipping carrier implements, and the vocabulary the rest of the application uses to talk about shipping.
 * Nothing outside `modules/shipping/providers` knows how any carrier's API looks: the order and shipping services speak only
 * these types and reach a carrier only through `ShippingProviderRegistry`. A new carrier is one new class plus one line in the
 * module; no existing code changes.
 *
 * Money is integer paise (`...Minor`). Weights are grams. Dimensions are centimetres. Dates are `Date`.
 */

// --- Credentials -------------------------------------------------------------------------------------------------------

/** What a tenant must provide to connect a carrier. The adapter validates the shape; the dashboard renders the form from it. */
export interface CredentialField {
  key: string;
  label: string;
  required: boolean;
  /** Secret fields are encrypted at rest and never returned to the dashboard. */
  secret: boolean;
  help?: string;
  /** For a fixed set of choices (for example the environment). */
  options?: readonly string[];
}

/** The tenant's own carrier credentials and settings, keyed by `CredentialField.key`. Never logged. */
export type CarrierCredentials = Readonly<Record<string, string>>;

// --- Capabilities ------------------------------------------------------------------------------------------------------

/**
 * Carriers do not offer the same things. Each adapter says what it can do so callers can ask first instead of failing, and
 * `integrationStatus` says honestly how far the adapter has been checked against the carrier's real service.
 */
export interface ProviderCapabilities {
  serviceability: boolean;
  /** The carrier can quote a price for a lane and weight through its API. */
  rateQuotes: boolean;
  /** Quoted prices are approximations (the carrier says actual charges may differ). */
  ratesAreEstimates: boolean;
  createShipment: boolean;
  cancelShipment: boolean;
  labels: boolean;
  tracking: boolean;
  /** The carrier can push tracking updates to a webhook of ours. */
  trackingWebhooks: boolean;
  cashOnDelivery: boolean;
}

export type IntegrationStatus =
  /** Endpoints, fields and behaviour were checked against the carrier's published documentation. */
  | 'documented'
  /** Endpoints match the published documentation; some request/response fields come from integration experience. */
  | 'partially_documented'
  /** Built from the carrier's known API shape; its documentation could not be read. Needs a sandbox run before real use. */
  | 'unverified';

// --- Shared value types ------------------------------------------------------------------------------------------------

export interface CarrierAddress {
  name: string;
  phone: string;
  email?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: 'IN';
}

export interface Parcel {
  weightGrams: number;
  lengthCm?: number;
  breadthCm?: number;
  heightCm?: number;
}

export type PaymentMode = 'prepaid' | 'cod';

export interface ServiceabilityQuery {
  originPostalCode: string;
  destinationPostalCode: string;
  paymentMode: PaymentMode;
  parcel?: Parcel;
  declaredValueMinor?: number;
}

export interface CarrierService {
  /** The carrier's own code (a courier id, a mode letter, a product code). */
  code: string;
  name: string;
}

export interface ServiceabilityResult {
  /** The carrier can deliver to the destination for this payment mode. Only ever true on an explicit positive answer. */
  serviceable: boolean;
  /** Whether the destination accepts cash on delivery, when the carrier says. */
  codAvailable: boolean | null;
  prepaidAvailable: boolean | null;
  services: CarrierService[];
  reason?: string;
}

export interface RateQuote {
  serviceCode: string;
  serviceName: string;
  amountMinor: number;
  currency: 'INR';
  estimatedDeliveryDays: number | null;
  /** The part of `amountMinor` that is the carrier's COD handling charge, when it is shown separately. */
  codChargeMinor: number | null;
  /** True when the carrier calls the amount approximate. */
  estimate: boolean;
}

export interface ShipmentItem {
  name: string;
  sku?: string;
  quantity: number;
  unitPriceMinor: number;
  hsnCode?: string;
}

export interface ShipmentInput {
  /** Our own unique reference for the order (becomes the carrier's order id). */
  orderReference: string;
  orderNumber: number;
  orderDate: Date;
  paymentMode: PaymentMode;
  /** What the courier collects at the door. Required (and > 0) for COD, ignored for prepaid. */
  codAmountMinor?: number;
  declaredValueMinor: number;
  consignee: CarrierAddress;
  /** Where the carrier collects the parcel. The carrier's registered pickup location is named in the credentials. */
  pickup: CarrierAddress;
  items: ShipmentItem[];
  parcel: Parcel;
  /** A service the order must use (a code from `getAvailableServices` or `calculateShippingRates`). */
  serviceCode?: string;
  /** Present when an earlier attempt created the carrier-side order but failed afterwards: resume instead of duplicating. */
  resume?: { providerOrderId?: string; providerShipmentId?: string };
}

export interface ShipmentRef {
  awb: string;
  providerOrderId?: string;
  providerShipmentId?: string;
}

export interface ShipmentResult extends ShipmentRef {
  courierName: string | null;
  serviceCode: string | null;
  trackingUrl: string | null;
  /** A label the carrier returned together with the shipment, when it does. */
  label?: LabelResult;
}

export interface CancelResult {
  cancelled: boolean;
  message: string | null;
}

export interface LabelResult {
  /** A link to the label PDF. */
  url?: string;
  /** The label PDF itself, base64. */
  pdfBase64?: string;
}

export type TrackingStatus =
  | 'pending'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'undelivered'
  | 'returning'
  | 'returned'
  | 'cancelled'
  | 'unknown';

export interface TrackingEvent {
  at: Date | null;
  status: TrackingStatus;
  description: string;
  location: string | null;
}

export interface TrackingResult {
  awb: string;
  status: TrackingStatus;
  statusText: string;
  trackingUrl: string | null;
  estimatedDelivery: Date | null;
  /** Newest first. */
  events: TrackingEvent[];
}

// --- Errors ------------------------------------------------------------------------------------------------------------

export type CarrierErrorKind =
  /** The carrier refused the tenant's credentials. */
  | 'auth'
  /** The carrier understood and said no (bad address, not serviceable, already cancelled...). The message is safe to show. */
  | 'rejected'
  /** A network failure, timeout, 429 or 5xx: nothing is known about the outcome. */
  | 'unavailable'
  /** The carrier answered with something that is not the shape we rely on. */
  | 'invalid_response'
  /** This carrier does not offer the operation. */
  | 'unsupported'
  /** The input or the saved credentials are unusable (caught before any request). */
  | 'invalid_input';

/**
 * Every adapter failure is one of these. Messages are written for people and never contain credentials, tokens, URLs or raw
 * carrier payloads. `partial` is set when a multi-step shipment creation got part-way: pass it back as `resume`.
 */
export class CarrierError extends Error {
  constructor(
    readonly kind: CarrierErrorKind,
    message: string,
    readonly options: {
      status?: number;
      partial?: { providerOrderId?: string; providerShipmentId?: string };
    } = {},
  ) {
    super(message);
    this.name = 'CarrierError';
  }
}

export const unsupported = (carrier: string, what: string) =>
  new CarrierError(
    'unsupported',
    `${carrier} does not offer ${what} through its API.`,
  );

// --- The contract ------------------------------------------------------------------------------------------------------

export interface CredentialCheck {
  valid: boolean;
  /** A short, safe sentence for the dashboard. */
  message: string;
}

export interface ShippingProvider {
  /** Stable machine name, stored with each tenant's connection. */
  readonly code: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  readonly integrationStatus: IntegrationStatus;
  /** Plain-words notes on what was and was not verified, for the dashboard and the README of this integration. */
  readonly integrationNotes: string;
  readonly credentialFields: readonly CredentialField[];

  /** Proves the credentials work without creating anything. `valid: false` for a refusal; throws only for an outage. */
  validateCredentials(creds: CarrierCredentials): Promise<CredentialCheck>;
  getServiceability(
    creds: CarrierCredentials,
    query: ServiceabilityQuery,
  ): Promise<ServiceabilityResult>;
  /** Throws `unsupported` for carriers whose API does not quote prices (their rates come from the tenant's own rate card). */
  calculateShippingRates(
    creds: CarrierCredentials,
    query: ServiceabilityQuery,
  ): Promise<RateQuote[]>;
  getAvailableServices(
    creds: CarrierCredentials,
    query?: ServiceabilityQuery,
  ): Promise<CarrierService[]>;
  createShipment(
    creds: CarrierCredentials,
    input: ShipmentInput,
  ): Promise<ShipmentResult>;
  cancelShipment(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<CancelResult>;
  generateShippingLabel(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<LabelResult>;
  trackShipment(
    creds: CarrierCredentials,
    ref: ShipmentRef,
  ): Promise<TrackingResult>;
}

/** Injection token for the list of every registered provider. */
export const SHIPPING_PROVIDERS = Symbol('SHIPPING_PROVIDERS');
