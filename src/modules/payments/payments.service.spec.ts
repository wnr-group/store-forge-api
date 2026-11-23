import { randomBytes, randomUUID } from 'node:crypto';
import { AppException } from '../../common/app.exception.js';
import type { OrgContext } from '../../common/interfaces/request-context.js';
import type { DatabaseService, DbTx } from '../../database/database.service.js';
import { PaymentsService } from './payments.service.js';
import type { PaymentsEventLogger } from './payments.logger.js';

/**
 * The save is two statements (insert that does nothing on conflict, then update). A concurrent remove can commit between
 * them. The fake transaction hands out scripted results in statement order to reproduce that interleaving.
 */
const org = {
  userId: randomUUID(),
  tenantId: randomUUID(),
} as OrgContext;
const dto = {
  keyId: 'rzp_test_abcdefgh',
  keySecret: 'SYNTH-secret-value-1234',
};

function setup(results: unknown[][]) {
  const queue = [...results];
  const execute = vi.fn(() => Promise.resolve(queue.shift() ?? []));
  const db = {
    withUser: (_userId: string, fn: (tx: DbTx) => Promise<unknown>) =>
      fn({ execute } as unknown as DbTx),
  } as unknown as DatabaseService;
  const events = { record: vi.fn(), keyFailure: vi.fn() };
  const service = new PaymentsService(
    db,
    events as unknown as PaymentsEventLogger,
  );
  return { service, execute, events };
}

beforeEach(() => {
  vi.stubEnv(
    'CREDENTIALS_ENCRYPTION_KEY_V1',
    randomBytes(32).toString('base64'),
  );
  vi.stubEnv('CREDENTIALS_ENCRYPTION_KEY_CURRENT', '1');
});
afterEach(() => vi.unstubAllEnvs());

describe('PaymentsService.save', () => {
  it('records a save when this statement inserted the row', async () => {
    const { service, events } = setup([[{ tenant_id: org.tenantId }], []]);
    await service.save(org, dto);
    expect(events.record).toHaveBeenCalledOnce();
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'save' }),
    );
  });

  it('records a replace when the row already existed and the update changed it', async () => {
    const { service, events } = setup([[], [{ tenant_id: org.tenantId }], []]);
    await service.save(org, dto);
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'replace' }),
    );
  });

  it('retries the insert when a concurrent remove deleted the row before the update, so the pair is still stored', async () => {
    // insert: conflict; update: 0 rows (row just removed); insert again: succeeds
    const { service, execute, events } = setup([
      [],
      [],
      [{ tenant_id: org.tenantId }],
      [],
    ]);
    await service.save(org, dto);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(events.record).toHaveBeenCalledOnce();
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'save' }),
    );
  });

  it('never reports success or records an event when nothing could be stored', async () => {
    const { service, events } = setup([]);
    const error = await service.save(org, dto).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).kind).toBe('CONFLICT');
    expect(events.record).not.toHaveBeenCalled();
  });
});
