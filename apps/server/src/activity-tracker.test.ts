import { describe, expect, it, vi } from 'vitest';

import {
  ActivityTracker,
  type ActivityScheduler,
  type ActivityStore,
} from './activity-tracker.js';

const NOW = '2026-07-11T12:00:00.000Z';
const LATER = '2026-07-11T12:00:05.000Z';

describe('ActivityTracker', () => {
  it('exposes immutable generations while activity is pending and in flight', async () => {
    const scheduler = new FakeScheduler();
    const write = deferred<void>();
    const tracker = makeTracker({
      scheduler,
      flushActivity: () => write.promise,
    });

    const initial = tracker.cleanupSnapshot('first');
    tracker.mark('first');
    const pending = tracker.cleanupSnapshot('first');
    scheduler.runNext();
    await settle();
    const inFlight = tracker.cleanupSnapshot('first');

    expect(initial).toEqual({ generation: 0, pending: false });
    expect(pending).toEqual({ generation: 1, pending: true });
    expect(inFlight).toEqual({ generation: 2, pending: true });
    expect(Object.isFrozen(inFlight)).toBe(true);

    write.resolve();
    await settle();
    expect(tracker.cleanupSnapshot('first')).toEqual({
      generation: 3,
      pending: false,
    });
  });

  it('advances cleanup visibility and remains pending after a failed flush', async () => {
    const scheduler = new FakeScheduler();
    const tracker = makeTracker({
      scheduler,
      flushActivity: async () => {
        throw new Error('contained');
      },
    });

    tracker.mark('first');
    scheduler.runNext();
    await settle();

    expect(tracker.cleanupSnapshot('first')).toEqual({
      generation: 3,
      pending: true,
    });
    expect(scheduler.pendingCount).toBe(1);
  });

  it('keeps cleanup generations isolated per tab through flush transitions', async () => {
    const scheduler = new FakeScheduler();
    const tracker = makeTracker({ scheduler });
    const firstBefore = tracker.cleanupSnapshot('first');

    tracker.mark('second');
    const secondMarked = tracker.cleanupSnapshot('second');
    expect(tracker.cleanupSnapshot('first')).toEqual(firstBefore);
    scheduler.runNext();
    await settle();

    expect(tracker.cleanupSnapshot('first')).toEqual(firstBefore);
    expect(tracker.cleanupSnapshot('second').generation).toBeGreaterThan(
      secondMarked.generation,
    );
  });

  it('bounds retained cleanup generations across unknown tab churn', async () => {
    const scheduler = new FakeScheduler();
    const tracker = makeTracker({ scheduler });

    for (let index = 0; index < 500; index += 1) {
      tracker.mark(`unknown-${index}`);
    }
    scheduler.runNext();
    await settle();

    expect(tracker.cleanupTrackingCount()).toBeLessThanOrEqual(64);
  });

  it('deduplicates IDs into one immutable snapshot on the default interval', async () => {
    const scheduler = new FakeScheduler();
    const calls: Array<{ ids: ReadonlySet<string>; now: string }> = [];
    const tracker = makeTracker({
      scheduler,
      flushActivity: async (ids, now) => {
        calls.push({ ids, now });
      },
    });

    tracker.mark('first');
    tracker.mark('first');
    tracker.mark('second');

    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.delays).toEqual([5_000]);
    scheduler.runNext();
    await settle();

    expect(calls).toHaveLength(1);
    expect([...calls[0]!.ids]).toEqual(['first', 'second']);
    expect(calls[0]!.now).toBe(NOW);

    tracker.mark('third');
    expect([...calls[0]!.ids]).toEqual(['first', 'second']);
  });

  it('keeps at most one timer and does not create work per mark', () => {
    const scheduler = new FakeScheduler();
    const tracker = makeTracker({ scheduler });

    const results = Array.from({ length: 100 }, (_, index) =>
      tracker.mark(`tab-${index}`),
    );

    expect(results.every((result) => result === undefined)).toBe(true);
    expect(scheduler.createdCount).toBe(1);
    expect(scheduler.pendingCount).toBe(1);
  });

  it('retains events marked during a write for one later interval', async () => {
    const scheduler = new FakeScheduler();
    const first = deferred<void>();
    const calls: string[][] = [];
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const tracker = makeTracker({
      scheduler,
      flushActivity: async (ids) => {
        calls.push([...ids]);
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        if (calls.length === 1) await first.promise;
        activeWrites -= 1;
      },
    });

    tracker.mark('first');
    scheduler.runNext();
    await settle();
    tracker.mark('second');
    tracker.mark('third');

    expect(calls).toEqual([['first']]);
    expect(scheduler.pendingCount).toBe(0);
    first.resolve();
    await settle();
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();
    await settle();

    expect(calls).toEqual([['first'], ['second', 'third']]);
    expect(maximumActiveWrites).toBe(1);
  });

  it('retries a failed timer flush once on a later scheduled interval', async () => {
    const scheduler = new FakeScheduler();
    const calls: string[][] = [];
    let attempts = 0;
    const tracker = makeTracker({
      scheduler,
      flushActivity: async (ids) => {
        calls.push([...ids]);
        attempts += 1;
        if (attempts === 1) throw new Error('sensitive store failure');
      },
    });

    tracker.mark('first');
    scheduler.runNext();
    await settle();

    expect(calls).toEqual([['first']]);
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runNext();
    await settle();

    expect(calls).toEqual([['first'], ['first']]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('retries when the store throws before returning a promise', async () => {
    const scheduler = new FakeScheduler();
    let attempts = 0;
    const flushActivity = vi.fn<ActivityStore['flushActivity']>(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('synchronous failure');
      return Promise.resolve();
    });
    const tracker = makeTracker({ scheduler, flushActivity });

    tracker.mark('first');
    scheduler.runNext();
    await settle();
    expect(scheduler.pendingCount).toBe(1);

    scheduler.runNext();
    await settle();

    expect(flushActivity).toHaveBeenCalledTimes(2);
    expect([...flushActivity.mock.calls[1]![0]]).toEqual(['first']);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('passes deleted or unknown IDs through for the store to handle', async () => {
    const scheduler = new FakeScheduler();
    const flushActivity = vi.fn<ActivityStore['flushActivity']>();
    const tracker = makeTracker({ scheduler, flushActivity });

    tracker.mark('deleted-tab');
    scheduler.runNext();
    await settle();

    expect(flushActivity).toHaveBeenCalledOnce();
    expect([...flushActivity.mock.calls[0]![0]]).toEqual(['deleted-tab']);
  });

  it('cancels a pending timer and flushes dirty IDs during shutdown', async () => {
    const scheduler = new FakeScheduler();
    const calls: string[][] = [];
    const tracker = makeTracker({
      scheduler,
      flushActivity: async (ids) => {
        calls.push([...ids]);
      },
    });
    tracker.mark('first');

    await tracker.shutdown();

    expect(scheduler.pendingCount).toBe(0);
    expect(scheduler.cancelledCount).toBe(1);
    expect(calls).toEqual([['first']]);
  });

  it('keeps final shutdown activity pending until persistence completes', async () => {
    const write = deferred<void>();
    const tracker = makeTracker({ flushActivity: () => write.promise });
    tracker.mark('first');

    const shutdown = tracker.shutdown();
    expect(tracker.cleanupSnapshot('first')).toEqual({
      generation: 2,
      pending: true,
    });

    write.resolve();
    await shutdown;
    expect(tracker.cleanupSnapshot('first')).toEqual({
      generation: 3,
      pending: false,
    });
  });

  it('waits for an in-flight write, then finally flushes later dirties', async () => {
    const scheduler = new FakeScheduler();
    const first = deferred<void>();
    const calls: Array<{ ids: string[]; now: string }> = [];
    const tracker = makeTracker({
      scheduler,
      now: sequenceClock(NOW, LATER),
      flushActivity: async (ids, now) => {
        calls.push({ ids: [...ids], now });
        if (calls.length === 1) await first.promise;
      },
    });

    tracker.mark('first');
    scheduler.runNext();
    await settle();
    tracker.mark('during-first-write');
    const shutdown = tracker.shutdown();
    tracker.mark('after-stop');
    await settle();

    expect(calls).toEqual([{ ids: ['first'], now: NOW }]);
    first.resolve();
    await shutdown;

    expect(calls).toEqual([
      { ids: ['first'], now: NOW },
      { ids: ['during-first-write'], now: LATER },
    ]);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('makes concurrent and repeated shutdown calls share one completion', async () => {
    const scheduler = new FakeScheduler();
    const finalWrite = deferred<void>();
    const flushActivity = vi.fn<ActivityStore['flushActivity']>(
      () => finalWrite.promise,
    );
    const tracker = makeTracker({ scheduler, flushActivity });
    tracker.mark('first');

    const first = tracker.shutdown();
    const second = tracker.shutdown();

    expect(second).toBe(first);
    expect(flushActivity).toHaveBeenCalledOnce();
    finalWrite.resolve();
    await Promise.all([first, second]);
    await tracker.shutdown();
    expect(flushActivity).toHaveBeenCalledOnce();
  });

  it('shares the pending shutdown promise with a reentrant store call', async () => {
    const finalWrite = deferred<void>();
    let nestedShutdown: Promise<void> | undefined;
    const trackerRef: { current?: ActivityTracker } = {};
    const flushActivity = vi.fn<ActivityStore['flushActivity']>(() => {
      nestedShutdown = trackerRef.current!.shutdown();
      return finalWrite.promise;
    });
    const tracker = makeTracker({ flushActivity });
    trackerRef.current = tracker;
    tracker.mark('first');

    const outerShutdown = tracker.shutdown();
    let outerResolved = false;
    let nestedResolved = false;
    void outerShutdown.then(() => {
      outerResolved = true;
    });
    void nestedShutdown!.then(() => {
      nestedResolved = true;
    });
    await settle();

    expect(nestedShutdown).toBe(outerShutdown);
    expect(outerResolved).toBe(false);
    expect(nestedResolved).toBe(false);

    finalWrite.resolve();
    await Promise.all([outerShutdown, nestedShutdown]);
    expect(flushActivity).toHaveBeenCalledOnce();
  });

  it('does not call the store when shutdown has no dirty IDs', async () => {
    const flushActivity = vi.fn<ActivityStore['flushActivity']>();
    const tracker = makeTracker({ flushActivity });

    await tracker.shutdown();

    expect(flushActivity).not.toHaveBeenCalled();
    tracker.mark('ignored');
    await tracker.shutdown();
    expect(flushActivity).not.toHaveBeenCalled();
  });

  it('makes one bounded final attempt and rejects with a generic error', async () => {
    const scheduler = new FakeScheduler();
    const flushActivity = vi.fn<ActivityStore['flushActivity']>(async () => {
      throw new Error('secret failure mentioning private-tab-id');
    });
    const tracker = makeTracker({ scheduler, flushActivity });
    tracker.mark('private-tab-id');

    const first = tracker.shutdown();

    await expect(first).rejects.toThrow(
      'Failed to persist terminal activity during shutdown',
    );
    await expect(tracker.shutdown()).rejects.not.toThrow('private-tab-id');
    await expect(tracker.shutdown()).rejects.not.toThrow('secret failure');
    expect(flushActivity).toHaveBeenCalledOnce();
    expect(scheduler.pendingCount).toBe(0);
    expect(tracker.cleanupSnapshot('private-tab-id')).toEqual({
      generation: 3,
      pending: true,
    });
  });
});

function makeTracker({
  scheduler = new FakeScheduler(),
  flushActivity = async () => undefined,
  now = () => NOW,
}: {
  scheduler?: ActivityScheduler;
  flushActivity?: ActivityStore['flushActivity'];
  now?: () => string;
} = {}): ActivityTracker {
  return new ActivityTracker({
    store: { flushActivity },
    scheduler,
    now,
  });
}

class FakeScheduler implements ActivityScheduler {
  readonly delays: number[] = [];
  createdCount = 0;
  cancelledCount = 0;
  private readonly pending: Array<{
    handle: object;
    callback: () => void;
  }> = [];

  get pendingCount(): number {
    return this.pending.length;
  }

  setTimeout(callback: () => void, delayMs: number): object {
    const handle = {};
    this.createdCount += 1;
    this.delays.push(delayMs);
    this.pending.push({ handle, callback });
    return handle;
  }

  clearTimeout(handle: object): void {
    const index = this.pending.findIndex((timer) => timer.handle === handle);
    if (index === -1) return;
    this.pending.splice(index, 1);
    this.cancelledCount += 1;
  }

  runNext(): void {
    const timer = this.pending.shift();
    if (!timer) throw new Error('No pending timer');
    timer.callback();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function sequenceClock(...values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}
