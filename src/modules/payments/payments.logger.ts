import { Logger } from '@nestjs/common';
import type { CredentialsKeyFailure } from './credentials-key.js';

/**
 * Structured events for the payment-credentials feature.
 *
 * - `record` writes one event per save, replace or remove with exactly four fields: the actor's user id, the tenant id,
 *   the action and a timestamp. The fields are copied one by one from the input, so nothing else passed in (a key id, a
 *   secret, ciphertext, an IV, a tag) can ever reach a log line. This is the only record of a removal, because the row
 *   itself is hard-deleted.
 * - `keyFailure` writes only the failure category when the encryption key is missing or unusable.
 */

export const PAYMENTS_ACTIONS = ['save', 'replace', 'remove'] as const;
export type PaymentsAction = (typeof PAYMENTS_ACTIONS)[number];

export interface PaymentsEvent {
  actorUserId: string;
  tenantId: string;
  action: PaymentsAction;
  /** ISO-8601, UTC. */
  timestamp: string;
}

/** The slice of the Nest `Logger` this class needs, so tests can capture what is written. */
export interface LogSink {
  log(message: unknown): void;
  warn(message: unknown): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_FAILURES: readonly CredentialsKeyFailure[] = [
  'key_missing',
  'key_invalid',
];

export class PaymentsEventLogger {
  constructor(
    private readonly sink: LogSink = new Logger('PaymentsEvents'),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Both ids come from the verified session and organization, so a malformed one is a bug and is refused loudly. */
  record(input: {
    actorUserId: string;
    tenantId: string;
    action: PaymentsAction;
  }): PaymentsEvent {
    const { actorUserId, tenantId, action } = input;
    if (!PAYMENTS_ACTIONS.includes(action))
      throw new TypeError('unknown payments action');
    if (typeof actorUserId !== 'string' || !UUID.test(actorUserId))
      throw new TypeError('actorUserId must be a uuid');
    if (typeof tenantId !== 'string' || !UUID.test(tenantId))
      throw new TypeError('tenantId must be a uuid');

    const event: PaymentsEvent = {
      actorUserId,
      tenantId,
      action,
      timestamp: this.now().toISOString(),
    };
    this.sink.log(event);
    return event;
  }

  /** Only the category is ever logged; never a variable name, a value or a stack. */
  keyFailure(category: CredentialsKeyFailure): void {
    if (!KEY_FAILURES.includes(category))
      throw new TypeError('unknown key failure category');
    this.sink.warn({ category });
  }
}
