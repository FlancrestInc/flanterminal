import { describe, expect, it, vi } from 'vitest';

import type { CleanupTerminationResult } from './session-manager.js';
import {
  CleanupDisabledError,
  StaleSessionCleaner,
  type CleanupScheduler,
} from './stale-session-cleaner.js';

const TAB_A = '550e8400-e29b-41d4-a716-446655440000';
const TAB_B = '123e4567-e89b-42d3-a456-426614174000';
const START = Date.parse('2026-07-13T12:00:00.000Z');

describe('StaleSessionCleaner', () => {
  it('keeps checking while disabled without eligibility or lifecycle work', async () => {
    const harness = cleanerHarness({ thresholdHours: 0 });
    expect(harness.scheduler.delays).toEqual([900_000]);

    harness.scheduler.runNext();
    const result = await harness.cleaner.waitForIdle();

    expect(result).toEqual({
      disabled: true,
      examined: 0,
      terminated: 0,
      skipped: 0,
      failed: 0,
      startedAt: '2026-07-13T12:00:00.000Z',
      finishedAt: '2026-07-13T12:00:00.000Z',
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(harness.read).not.toHaveBeenCalled();
    expect(harness.terminate).not.toHaveBeenCalled();
    expect(harness.scheduler.pendingCount).toBe(1);
    await expect(harness.cleaner.runNow()).rejects.toBeInstanceOf(
      CleanupDisabledError,
    );
  });

  it('reads settings each run, honors exact cadence, and reports narrow status', async () => {
    const harness = cleanerHarness({ thresholdHours: 0 });
    expect(harness.cleaner.status()).toEqual({
      enabled: false,
      running: false,
      lastRunAt: null,
    });
    harness.settings.staleSessionCleanupHours = 1;
    harness.clock.value += 900_000;
    harness.scheduler.runNext();
    await harness.cleaner.waitForIdle();

    expect(harness.read).toHaveBeenCalledWith({
      id: TAB_A,
      thresholdMs: 3_600_000,
      cutoffMs: START - 2_700_000,
    });
    expect(harness.scheduler.delays).toEqual([900_000, 900_000]);
    expect(harness.cleaner.status()).toEqual({
      enabled: true,
      running: false,
      lastRunAt: '2026-07-13T12:15:00.000Z',
    });
    expect(Object.isFrozen(harness.cleaner.status())).toBe(true);
  });

  it('shares concurrent runs, bounds examination, and counts all outcomes exactly', async () => {
    const gate = deferred<CleanupTerminationResult>();
    const terminate = vi
      .fn<() => Promise<CleanupTerminationResult>>()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce('skipped:connected');
    const harness = cleanerHarness({
      ids: [TAB_A, TAB_B, TAB_A],
      maxSessions: 2,
      terminate,
    });

    const first = harness.cleaner.runNow();
    const second = harness.cleaner.runNow();
    expect(second).toBe(first);
    expect(harness.cleaner.status().running).toBe(true);
    gate.resolve('terminated');

    await expect(first).resolves.toMatchObject({
      disabled: false,
      examined: 2,
      terminated: 1,
      skipped: 1,
      failed: 0,
    });
    expect(harness.read).toHaveBeenCalledTimes(2);
    expect(harness.terminate).toHaveBeenCalledTimes(2);
  });

  it('keeps an in-flight threshold stable when settings change for the next run', async () => {
    const gate = deferred<CleanupTerminationResult>();
    const harness = cleanerHarness({ terminate: vi.fn(() => gate.promise) });
    const first = harness.cleaner.runNow();
    harness.settings.staleSessionCleanupHours = 0;

    const concurrent = harness.cleaner.runNow();

    expect(concurrent).toBe(first);
    gate.resolve('terminated');
    await concurrent;
    await expect(harness.cleaner.runNow()).rejects.toBeInstanceOf(
      CleanupDisabledError,
    );
  });

  it('continues independent sessions after read and lifecycle failures', async () => {
    const harness = cleanerHarness({ ids: [TAB_A, TAB_B] });
    harness.read
      .mockRejectedValueOnce(new Error('contained'))
      .mockResolvedValueOnce(eligibleSnapshot(TAB_B));
    harness.terminate.mockRejectedValueOnce(new Error('contained'));

    await expect(harness.cleaner.runNow()).resolves.toMatchObject({
      examined: 2,
      terminated: 0,
      skipped: 0,
      failed: 2,
    });
  });

  it('cancels one timer and waits for in-flight cleanup without rescheduling', async () => {
    const gate = deferred<CleanupTerminationResult>();
    const harness = cleanerHarness({ terminate: vi.fn(() => gate.promise) });
    const run = harness.cleaner.runNow();
    const shutdown = harness.cleaner.shutdown();
    expect(harness.scheduler.pendingCount).toBe(0);
    expect(harness.scheduler.cancelledCount).toBe(1);

    gate.resolve('terminated');
    await Promise.all([run, shutdown, harness.cleaner.shutdown()]);
    expect(harness.scheduler.pendingCount).toBe(0);
  });
});

function cleanerHarness({
  thresholdHours = 1,
  ids = [TAB_A],
  maxSessions = 20,
  terminate = vi.fn(
    async (): Promise<CleanupTerminationResult> => 'terminated',
  ),
}: {
  thresholdHours?: number;
  ids?: string[];
  maxSessions?: number;
  terminate?: ReturnType<typeof vi.fn<() => Promise<CleanupTerminationResult>>>;
} = {}) {
  const scheduler = new FakeScheduler();
  const clock = { value: START };
  const settings = { staleSessionCleanupHours: thresholdHours };
  const read = vi.fn(async ({ id }: { id: string }) => eligibleSnapshot(id));
  const cleaner = new StaleSessionCleaner({
    settings: { snapshot: () => ({ ...settings }) },
    tabs: {
      snapshot: () => ({ structureRevision: 1, tabs: ids.map(tabRecord) }),
    },
    eligibility: { read },
    sessions: { terminateIfStale: terminate },
    maxSessions,
    intervalMs: 900_000,
    scheduler,
    now: () => clock.value,
  });
  return { cleaner, scheduler, clock, settings, read, terminate };
}

function eligibleSnapshot(id: string) {
  return Object.freeze({
    id,
    thresholdMs: 3_600_000,
    cutoffMs: START - 3_600_000,
    eligible: true as const,
    reason: null,
    generation: Object.freeze({ structure: 1, activity: 0, sockets: 0 }),
  });
}

function tabRecord(id: string, position: number) {
  return {
    id,
    displayName: `Terminal ${position + 1}`,
    position,
    createdAt: '2026-07-11T00:00:00.000Z',
    lastActivityAt: '2026-07-11T00:00:00.000Z',
    desiredState: 'active' as const,
  };
}

class FakeScheduler implements CleanupScheduler {
  readonly delays: number[] = [];
  cancelledCount = 0;
  private pending: Array<{ handle: object; callback: () => void }> = [];
  get pendingCount() {
    return this.pending.length;
  }
  setTimeout(callback: () => void, delayMs: number) {
    const handle = {};
    this.delays.push(delayMs);
    this.pending.push({ handle, callback });
    return handle;
  }
  clearTimeout(handle: object) {
    const index = this.pending.findIndex((timer) => timer.handle === handle);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.cancelledCount += 1;
  }
  runNext() {
    const timer = this.pending.shift();
    if (!timer) throw new Error('No pending timer');
    timer.callback();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
