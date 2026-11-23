/**
 * Choosing a carrier. Pure: it only ranks the candidates it is given.
 *
 * A candidate exists only if the carrier said it can deliver to the destination, so ranking can never pick a carrier that cannot.
 * A carrier that cannot confirm delivery, or cannot quote a price, is not a candidate for automatic choice at all (it stays
 * available for the Owner to pick by hand). The strategies:
 *  - lowest_cost: the cheapest quote; ties go to the faster one.
 *  - fastest: the shortest delivery time; carriers that give no estimate are ignored, and if none gives one the choice falls
 *    back to lowest cost and says so.
 *  - preferred: the Owner's default carrier (its cheapest service) when it can deliver; otherwise lowest cost, and says so.
 *  - manual mode: nothing is chosen; the caller shows the candidates.
 */
export type SelectionStrategy = 'lowest_cost' | 'fastest' | 'preferred';
export type SelectionMode = 'manual' | 'automatic';

export interface CarrierCandidate {
  providerCode: string;
  providerName: string;
  serviceCode: string;
  serviceName: string;
  amountMinor: number;
  currency: 'INR';
  estimatedDeliveryDays: number | null;
  codChargeMinor: number | null;
  /** The carrier calls this price approximate. */
  estimate: boolean;
}

export interface SkippedCarrier {
  providerCode: string;
  providerName: string;
  reason: string;
}

export interface CarrierChoice {
  candidate: CarrierCandidate | null;
  strategy: SelectionStrategy;
  /** The strategy asked for something the candidates could not give, so another rule was used. */
  fellBack: boolean;
  reason: string;
}

const byCostThenSpeed = (a: CarrierCandidate, b: CarrierCandidate) =>
  a.amountMinor - b.amountMinor ||
  (a.estimatedDeliveryDays ?? Infinity) -
    (b.estimatedDeliveryDays ?? Infinity) ||
  a.providerCode.localeCompare(b.providerCode) ||
  a.serviceCode.localeCompare(b.serviceCode);

const bySpeedThenCost = (a: CarrierCandidate, b: CarrierCandidate) =>
  (a.estimatedDeliveryDays ?? Infinity) -
    (b.estimatedDeliveryDays ?? Infinity) ||
  a.amountMinor - b.amountMinor ||
  a.providerCode.localeCompare(b.providerCode) ||
  a.serviceCode.localeCompare(b.serviceCode);

export function chooseCarrier(
  candidates: readonly CarrierCandidate[],
  strategy: SelectionStrategy,
  mode: SelectionMode,
  defaultCarrierCode: string | null,
): CarrierChoice {
  if (mode === 'manual')
    return {
      candidate: null,
      strategy,
      fellBack: false,
      reason: 'Carrier selection is manual: choose one of the options.',
    };
  if (candidates.length === 0)
    return {
      candidate: null,
      strategy,
      fellBack: false,
      reason: 'No connected carrier can deliver this parcel.',
    };

  const cheapest = () => [...candidates].sort(byCostThenSpeed)[0];

  if (strategy === 'lowest_cost')
    return {
      candidate: cheapest(),
      strategy,
      fellBack: false,
      reason: 'Lowest price.',
    };

  if (strategy === 'fastest') {
    const timed = candidates.filter((c) => c.estimatedDeliveryDays !== null);
    if (timed.length === 0)
      return {
        candidate: cheapest(),
        strategy,
        fellBack: true,
        reason:
          'No carrier gave a delivery time, so the lowest price was used.',
      };
    return {
      candidate: [...timed].sort(bySpeedThenCost)[0],
      strategy,
      fellBack: false,
      reason: 'Shortest delivery time.',
    };
  }

  const preferred = defaultCarrierCode
    ? candidates.filter((c) => c.providerCode === defaultCarrierCode)
    : [];
  if (preferred.length > 0)
    return {
      candidate: [...preferred].sort(byCostThenSpeed)[0],
      strategy,
      fellBack: false,
      reason: 'Your default carrier.',
    };
  return {
    candidate: cheapest(),
    strategy,
    fellBack: true,
    reason: defaultCarrierCode
      ? 'Your default carrier cannot deliver this parcel, so the lowest price was used.'
      : 'No default carrier is set, so the lowest price was used.',
  };
}
