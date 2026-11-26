import { Injectable } from '@nestjs/common';
import { AppException, conflict } from '../../common/app.exception.js';
import { DatabaseService } from '../../database/database.service.js';
import {
  loadCarrierConnections,
  toCredentials,
} from '../shipping/carrier-credentials.js';
import { ShippingProviderRegistry } from '../shipping/providers/provider-registry.js';
import {
  CarrierError,
  type CarrierCredentials,
  type ShippingProvider,
} from '../shipping/providers/shipping-provider.js';

export interface CarrierSession {
  provider: ShippingProvider;
  credentials: CarrierCredentials;
}

/**
 * Where shipments get the tenant's own carrier account. This is a reviewed user of the carrier credential reader (see
 * `carrier-credentials.ts`): the decrypted values live in the returned object for the length of one operation and are never
 * logged, stored or returned to anyone. Always called OUTSIDE a business transaction: it opens its own short one to read the
 * connection, so no carrier call ever happens while an order or stock row is locked.
 */
@Injectable()
export class ShipmentCarrier {
  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ShippingProviderRegistry,
  ) {}

  /**
   * `forBooking` demands a carrier that is switched on and was checked (what a NEW parcel needs). Tracking and cancelling a parcel
   * already with the carrier only need the connection to exist, so turning a carrier off never strands parcels already booked.
   */
  async open(
    tenantId: string,
    providerCode: string,
    forBooking: boolean,
  ): Promise<CarrierSession> {
    if (!this.registry.has(providerCode))
      throw conflict(
        'That shipping carrier is not supported.',
        undefined,
        'CARRIER_NOT_AVAILABLE',
      );
    const provider = this.registry.get(providerCode);
    const stored = (
      await this.db.withCheckout(tenantId, (tx) =>
        loadCarrierConnections(tx, tenantId, providerCode),
      )
    )[0];
    if (!stored)
      throw conflict(
        `${provider.name} is not connected. Connect it in your shipping carriers first.`,
        undefined,
        'CARRIER_NOT_AVAILABLE',
      );
    if (forBooking && !stored.enabled)
      throw conflict(
        `${provider.name} is switched off. Switch it on in your shipping carriers to book with it.`,
        undefined,
        'CARRIER_NOT_AVAILABLE',
      );
    if (forBooking && !stored.verified)
      throw conflict(
        `${provider.name} has not been checked yet. Check its credentials in your shipping carriers first.`,
        undefined,
        'CARRIER_NOT_AVAILABLE',
      );
    return { provider, credentials: toCredentials(stored) };
  }
}

/** What a carrier failure means for the person using the dashboard. The messages are the adapters' own, which are safe to show. */
export function carrierProblem(error: unknown): AppException {
  if (!(error instanceof CarrierError)) throw error;
  switch (error.kind) {
    case 'unavailable':
    case 'invalid_response':
      return new AppException(
        'UNAVAILABLE',
        'The carrier did not answer properly. Nothing is lost: try again in a moment.',
        { code: 'CARRIER_UNAVAILABLE' },
      );
    case 'auth':
      return conflict(
        'The carrier did not accept your saved credentials. Check them in your shipping carriers.',
        undefined,
        'CARRIER_AUTH_FAILED',
      );
    case 'unsupported':
      return conflict(error.message, undefined, 'CARRIER_UNSUPPORTED');
    default:
      return conflict(error.message, undefined, 'CARRIER_REJECTED');
  }
}

/** True when the carrier definitely did not do what was asked (as opposed to "we do not know what happened"). */
export const isDefinitiveRefusal = (error: CarrierError): boolean =>
  error.kind === 'rejected' ||
  error.kind === 'auth' ||
  error.kind === 'invalid_input' ||
  error.kind === 'unsupported';
