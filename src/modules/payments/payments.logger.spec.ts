import { randomUUID } from 'node:crypto';
import { Logger, type LoggerService } from '@nestjs/common';
import { PaymentsEventLogger, type LogSink } from './payments.logger.js';

const actorUserId = randomUUID();
const tenantId = randomUUID();
const NOW = new Date('2026-11-19T09:30:00.000Z');

function sink() {
  const log = vi.fn<(message: unknown) => void>();
  const warn = vi.fn<(message: unknown) => void>();
  return { sink: { log, warn } satisfies LogSink, log, warn };
}

describe('PaymentsEventLogger: save, replace and remove events (AC-LOG-01, AC-LOG-02)', () => {
  it.each(['save', 'replace', 'remove'] as const)(
    'emits exactly one event for %s with exactly four fields',
    (action) => {
      const { sink: s, log } = sink();
      const logger = new PaymentsEventLogger(s, () => NOW);
      const returned = logger.record({ actorUserId, tenantId, action });

      expect(log).toHaveBeenCalledTimes(1);
      const event = log.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(event).sort()).toEqual(
        ['action', 'actorUserId', 'tenantId', 'timestamp'].sort(),
      );
      expect(event).toEqual({
        actorUserId,
        tenantId,
        action,
        timestamp: '2026-11-19T09:30:00.000Z',
      });
      expect(returned).toEqual(event);
    },
  );

  it('uses a real ISO-8601 UTC timestamp from the clock', () => {
    const { sink: s, log } = sink();
    new PaymentsEventLogger(s).record({
      actorUserId,
      tenantId,
      action: 'save',
    });
    const event = log.mock.calls[0]?.[0] as { timestamp: string };
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  it('copies only the four fields, so credential material passed by mistake never reaches the log', () => {
    const { sink: s, log } = sink();
    const careless = {
      actorUserId,
      tenantId,
      action: 'save',
      keyId: 'rzp_test_abcdefgh',
      keySecret: 'SYNTH-SECRET-VALUE',
      ciphertext: 'AAAA',
      iv: 'BBBB',
      authTag: 'CCCC',
    } as unknown as Parameters<PaymentsEventLogger['record']>[0];
    new PaymentsEventLogger(s, () => NOW).record(careless);
    const text = JSON.stringify(log.mock.calls);
    for (const leaked of [
      'SYNTH-SECRET-VALUE',
      'rzp_test_',
      'ciphertext',
      'AAAA',
      'authTag',
    ])
      expect(text).not.toContain(leaked);
  });

  it('refuses an unknown action or a malformed id, and emits nothing', () => {
    const { sink: s, log } = sink();
    const logger = new PaymentsEventLogger(s, () => NOW);
    const bad = [
      { actorUserId, tenantId, action: 'update' },
      { actorUserId: 'not-a-uuid', tenantId, action: 'save' },
      { actorUserId, tenantId: '', action: 'save' },
      { actorUserId: 'rzp_test_abcdefgh', tenantId, action: 'save' },
    ] as unknown as Parameters<PaymentsEventLogger['record']>[0][];
    for (const input of bad)
      expect(() => logger.record(input)).toThrow(TypeError);
    expect(log).not.toHaveBeenCalled();
  });

  it('emits the event through the Nest logger under its own context when no sink is given', () => {
    const calls: { level: string; message: unknown; context?: unknown }[] = [];
    const capture: LoggerService = {
      log: (message, context) => calls.push({ level: 'log', message, context }),
      warn: (message, context) =>
        calls.push({ level: 'warn', message, context }),
      error: () => undefined,
    };
    Logger.overrideLogger(capture);
    try {
      new PaymentsEventLogger(undefined, () => NOW).record({
        actorUserId,
        tenantId,
        action: 'remove',
      });
    } finally {
      Logger.overrideLogger(false);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ level: 'log', context: 'PaymentsEvents' });
    expect(calls[0]?.message).toEqual({
      actorUserId,
      tenantId,
      action: 'remove',
      timestamp: '2026-11-19T09:30:00.000Z',
    });
  });
});

describe('PaymentsEventLogger: encryption-key failures (AC-KEY-08)', () => {
  it.each(['key_missing', 'key_invalid'] as const)(
    'logs only the category %s',
    (category) => {
      const { sink: s, log, warn } = sink();
      new PaymentsEventLogger(s, () => NOW).keyFailure(category);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      expect(warn.mock.calls[0]?.[0]).toEqual({ category });
    },
  );

  it('ignores anything that is not a known category rather than logging it', () => {
    const { sink: s, warn } = sink();
    const logger = new PaymentsEventLogger(s, () => NOW);
    expect(() =>
      logger.keyFailure('CREDENTIALS_ENCRYPTION_KEY_V1=abc' as never),
    ).toThrow(TypeError);
    expect(warn).not.toHaveBeenCalled();
  });
});
