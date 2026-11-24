import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportServerError, setErrorSink } from '../../common/error-sink.js';
import { MonitoringRecorder } from './monitoring.recorder.js';

const dbThat = (withPublic: () => Promise<unknown>) =>
  ({ withPublic }) as never;
const report = {
  method: 'GET',
  route: '/x',
  status: 500,
  error: new Error('x'),
  requestId: null,
};

afterEach(() => {
  vi.useRealTimers();
  setErrorSink(undefined);
});

describe('MonitoringRecorder', () => {
  it('never throws when the database cannot be written', async () => {
    const recorder = new MonitoringRecorder(
      dbThat(() => Promise.reject(new Error('db down'))),
    );
    await expect(recorder.recordError(report)).resolves.toBeUndefined();
  });

  it('gives up after a short time instead of holding up the request or job', async () => {
    vi.useFakeTimers();
    const recorder = new MonitoringRecorder(
      dbThat(() => new Promise(() => undefined)),
    );
    const pending = recorder.recordError(report);
    await vi.advanceTimersByTimeAsync(1600);
    await expect(pending).resolves.toBeUndefined();
  });

  it('returns a job result unchanged even when recording it fails', async () => {
    const recorder = new MonitoringRecorder(
      dbThat(() => Promise.reject(new Error('db down'))),
    );
    await expect(
      recorder.runJob('billing', async () => ({ issued: 3 })),
    ).resolves.toEqual({ issued: 3 });
  });

  it('rethrows the job error itself, not a recording error', async () => {
    const recorder = new MonitoringRecorder(
      dbThat(() => Promise.reject(new Error('db down'))),
    );
    const failure = new Error('the real failure');
    await expect(
      recorder.runJob('billing', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  it('registers itself as the error sink on start and removes itself on shutdown', () => {
    const recorder = new MonitoringRecorder(dbThat(() => Promise.resolve()));
    expect(reportServerError(report)).toBeUndefined();
    recorder.onModuleInit();
    expect(reportServerError(report)).toBeInstanceOf(Promise);
    recorder.onModuleDestroy();
    expect(reportServerError(report)).toBeUndefined();
  });
});
