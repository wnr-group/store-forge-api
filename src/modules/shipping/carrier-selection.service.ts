import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppException } from '../../common/app.exception.js';
import { DatabaseService, rowsOf } from '../../database/database.service.js';
import {
  loadCarrierConnections,
  toCredentials,
} from './carrier-credentials.js';
import {
  chooseCarrier,
  type CarrierCandidate,
  type CarrierChoice,
  type SelectionMode,
  type SelectionStrategy,
  type SkippedCarrier,
} from './carrier-selection.js';
import { ShippingProviderRegistry } from './providers/provider-registry.js';
import {
  CarrierError,
  type PaymentMode,
} from './providers/shipping-provider.js';

export interface CarrierLane {
  originPostalCode: string;
  destinationPostalCode: string;
  paymentMode: PaymentMode;
  weightGrams: number;
  declaredValueMinor: number;
}

export interface CarrierOptions {
  candidates: CarrierCandidate[];
  skipped: SkippedCarrier[];
  strategy: SelectionStrategy;
  mode: SelectionMode;
  defaultCarrier: string | null;
}

/**
 * Asks the tenant's connected carriers (only those turned on and checked) what they can do for one parcel, and ranks the answers by
 * the tenant's own preferences. It runs outside any checkout transaction because it talks to carriers.
 *
 * A carrier becomes a candidate only when it positively confirms the destination (serviceability) AND quotes a price. One that is
 * down, cannot confirm delivery, or does not quote is reported in `skipped` with a reason and never chosen automatically.
 */
@Injectable()
export class CarrierSelectionService {
  private readonly logger = new Logger(CarrierSelectionService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly registry: ShippingProviderRegistry,
  ) {}

  async options(
    tenantId: string,
    lane: CarrierLane,
    onlyCarrier?: string | null,
  ): Promise<CarrierOptions> {
    const { connections, mode, strategy } = await this.db
      .withCheckout(tenantId, async (tx) => ({
        connections: await loadCarrierConnections(tx, tenantId),
        ...(await this.preferences(tx)),
      }))
      .catch((error: unknown) => {
        this.logger.error({
          event: 'selection.credentials_unreadable',
          tenantId,
          name: (error as Error).name,
        });
        throw new AppException(
          'UNAVAILABLE',
          'Shipping settings are temporarily unavailable. Please contact support.',
          {
            code: 'SHIPPING_UNAVAILABLE',
          },
        );
      });

    const active = connections.filter(
      (c) =>
        c.enabled &&
        c.verified &&
        (!onlyCarrier || c.providerCode === onlyCarrier),
    );
    const results = await Promise.all(
      active.map(async (conn) => {
        const provider = this.registry.has(conn.providerCode)
          ? this.registry.get(conn.providerCode)
          : null;
        if (!provider)
          return {
            skipped: {
              providerCode: conn.providerCode,
              providerName: conn.providerCode,
              reason: 'This carrier is no longer supported.',
            },
          };
        const skip = (reason: string) => ({
          skipped: {
            providerCode: provider.code,
            providerName: provider.name,
            reason,
          },
        });
        if (!provider.capabilities.serviceability)
          return skip(
            `${provider.name} cannot confirm delivery to a PIN code, so it is only used when you choose it yourself.`,
          );
        if (!provider.capabilities.rateQuotes)
          return skip(
            `${provider.name} does not quote prices, so it is only used when you choose it yourself.`,
          );
        const creds = toCredentials(conn);
        const query = {
          originPostalCode: lane.originPostalCode,
          destinationPostalCode: lane.destinationPostalCode,
          paymentMode: lane.paymentMode,
          parcel: { weightGrams: lane.weightGrams },
          declaredValueMinor: lane.declaredValueMinor,
        };
        try {
          const served = await provider.getServiceability(creds, query);
          if (!served.serviceable)
            return skip(
              served.reason ?? `${provider.name} does not deliver there.`,
            );
          const allowed = new Set(served.services.map((s) => s.code));
          const quotes = (
            await provider.calculateShippingRates(creds, query)
          ).filter((q) => allowed.size === 0 || allowed.has(q.serviceCode));
          if (quotes.length === 0)
            return skip(`${provider.name} has no price for this parcel.`);
          return {
            candidates: quotes.map((q): CarrierCandidate => ({
              providerCode: provider.code,
              providerName: provider.name,
              serviceCode: q.serviceCode,
              serviceName: q.serviceName,
              amountMinor: q.amountMinor,
              currency: q.currency,
              estimatedDeliveryDays: q.estimatedDeliveryDays,
              codChargeMinor: q.codChargeMinor,
              estimate: q.estimate,
            })),
          };
        } catch (error) {
          const kind = error instanceof CarrierError ? error.kind : 'other';
          this.logger.warn({
            event: 'selection.carrier_failed',
            tenantId,
            provider: provider.code,
            kind,
          });
          return skip(
            kind === 'unavailable'
              ? `${provider.name} could not be reached.`
              : kind === 'auth'
                ? `${provider.name} no longer accepts the saved credentials.`
                : `${provider.name} could not price this parcel.`,
          );
        }
      }),
    );
    return {
      candidates: results.flatMap((r) =>
        'candidates' in r && r.candidates ? r.candidates : [],
      ),
      // Carriers that are connected but switched off are not "skipped": the Owner turned them off.
      skipped: results.flatMap((r) =>
        'skipped' in r && r.skipped ? [r.skipped] : [],
      ),
      strategy,
      mode,
      defaultCarrier:
        connections.find((c) => c.enabled && c.isDefault)?.providerCode ?? null,
    };
  }

  /** Options plus the choice the tenant's preferences make. */
  async choose(
    tenantId: string,
    lane: CarrierLane,
    onlyCarrier?: string | null,
  ): Promise<CarrierOptions & { choice: CarrierChoice }> {
    const options = await this.options(tenantId, lane, onlyCarrier);
    return {
      ...options,
      choice: chooseCarrier(
        options.candidates,
        options.strategy,
        options.mode,
        options.defaultCarrier,
      ),
    };
  }

  private async preferences(
    tx: Parameters<Parameters<DatabaseService['withCheckout']>[1]>[0],
  ) {
    const p = rowsOf<{
      selection_mode: SelectionMode;
      strategy: SelectionStrategy;
    }>(
      await tx.execute(
        sql`select selection_mode, strategy from public.tenant_shipping_preferences`,
      ),
    )[0];
    return {
      mode: p?.selection_mode ?? 'manual',
      strategy: p?.strategy ?? 'lowest_cost',
    };
  }
}
