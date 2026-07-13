const DEFAULT_INTERVAL_MS = 5_000;
const SHUTDOWN_ERROR_MESSAGE =
  'Failed to persist terminal activity during shutdown';

export interface ActivityStore {
  flushActivity(ids: ReadonlySet<string>, now: string): Promise<void>;
}

export interface ActivityScheduler {
  setTimeout(callback: () => void, delayMs: number): object;
  clearTimeout(handle: object): void;
}

export type ActivityTrackerOptions = Readonly<{
  store: ActivityStore;
  scheduler?: ActivityScheduler;
  now?: () => string;
  intervalMs?: number;
}>;

export type ActivityCleanupSnapshot = Readonly<{
  generation: number;
  pending: boolean;
}>;

const defaultScheduler: ActivityScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class ActivityTracker {
  private readonly dirtyIds = new Set<string>();
  private readonly flushingIds = new Set<string>();
  private readonly scheduler: ActivityScheduler;
  private readonly now: () => string;
  private readonly intervalMs: number;
  private timer: object | undefined;
  private inFlight: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private accepting = true;
  private cleanupGeneration = 0;

  constructor(private readonly options: ActivityTrackerOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? (() => new Date().toISOString());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  mark(tabId: string): void {
    if (!this.accepting) return;
    this.dirtyIds.add(tabId);
    this.advanceCleanupGeneration();
    this.schedule();
  }

  cleanupSnapshot(tabId: string): ActivityCleanupSnapshot {
    return Object.freeze({
      generation: this.cleanupGeneration,
      pending: this.dirtyIds.has(tabId) || this.flushingIds.has(tabId),
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.accepting = false;
    this.cancelTimer();
    let resolveShutdown!: () => void;
    let rejectShutdown!: (reason?: unknown) => void;
    const shutdownPromise = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
    });
    this.shutdownPromise = shutdownPromise;
    void this.finishShutdown().then(resolveShutdown, rejectShutdown);
    return shutdownPromise;
  }

  private schedule(): void {
    if (
      !this.accepting ||
      this.timer !== undefined ||
      this.inFlight !== undefined ||
      this.dirtyIds.size === 0
    ) {
      return;
    }

    this.timer = this.scheduler.setTimeout(() => {
      this.timer = undefined;
      this.startFlush();
    }, this.intervalMs);
  }

  private startFlush(): void {
    if (this.inFlight || this.dirtyIds.size === 0) return;

    const ids = this.takeDirtySnapshot();
    for (const id of ids) this.flushingIds.add(id);
    this.advanceCleanupGeneration();
    const operation: Promise<void> = Promise.resolve()
      .then(() => this.options.store.flushActivity(ids, this.now()))
      .catch(() => {
        for (const id of ids) this.dirtyIds.add(id);
      })
      .finally(() => {
        for (const id of ids) this.flushingIds.delete(id);
        this.advanceCleanupGeneration();
        if (this.inFlight !== operation) return;
        this.inFlight = undefined;
        this.schedule();
      });
    this.inFlight = operation;
  }

  private async finishShutdown(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (this.dirtyIds.size === 0) return;

    const ids = this.takeDirtySnapshot();
    for (const id of ids) this.flushingIds.add(id);
    this.advanceCleanupGeneration();
    try {
      await this.options.store.flushActivity(ids, this.now());
    } catch {
      throw new Error(SHUTDOWN_ERROR_MESSAGE);
    } finally {
      for (const id of ids) this.flushingIds.delete(id);
      this.advanceCleanupGeneration();
    }
  }

  private takeDirtySnapshot(): ReadonlySet<string> {
    const ids: ReadonlySet<string> = new Set(this.dirtyIds);
    this.dirtyIds.clear();
    return ids;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private advanceCleanupGeneration(): void {
    this.cleanupGeneration += 1;
  }
}
