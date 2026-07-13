const DEFAULT_INTERVAL_MS = 5_000;
const MAX_CLEANUP_GENERATIONS = 64;
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
  private cleanupClock = 0;
  private cleanupEvictionGeneration = 0;
  private readonly cleanupGenerations = new Map<string, number>();

  constructor(private readonly options: ActivityTrackerOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? (() => new Date().toISOString());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  mark(tabId: string): void {
    if (!this.accepting) return;
    this.dirtyIds.add(tabId);
    this.advanceCleanupGeneration(tabId);
    this.schedule();
  }

  cleanupSnapshot(tabId: string): ActivityCleanupSnapshot {
    return Object.freeze({
      generation:
        this.cleanupGenerations.get(tabId) ?? this.cleanupEvictionGeneration,
      pending: this.dirtyIds.has(tabId) || this.flushingIds.has(tabId),
    });
  }

  cleanupTrackingCount(): number {
    return this.cleanupGenerations.size;
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
    this.advanceCleanupGenerations(ids);
    const operation: Promise<void> = Promise.resolve()
      .then(() => this.options.store.flushActivity(ids, this.now()))
      .catch(() => {
        for (const id of ids) this.dirtyIds.add(id);
      })
      .finally(() => {
        for (const id of ids) this.flushingIds.delete(id);
        this.advanceCleanupGenerations(ids);
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
    this.advanceCleanupGenerations(ids);
    try {
      await this.options.store.flushActivity(ids, this.now());
    } catch {
      for (const id of ids) this.dirtyIds.add(id);
      throw new Error(SHUTDOWN_ERROR_MESSAGE);
    } finally {
      for (const id of ids) this.flushingIds.delete(id);
      this.advanceCleanupGenerations(ids);
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

  private advanceCleanupGenerations(ids: ReadonlySet<string>): void {
    for (const id of ids) this.advanceCleanupGeneration(id);
  }

  private advanceCleanupGeneration(id: string): void {
    this.cleanupClock += 1;
    this.cleanupGenerations.delete(id);
    this.cleanupGenerations.set(id, this.cleanupClock);
    if (this.cleanupGenerations.size <= MAX_CLEANUP_GENERATIONS) return;
    const oldest = this.cleanupGenerations.keys().next().value as
      string | undefined;
    if (oldest !== undefined) this.cleanupGenerations.delete(oldest);
    this.cleanupEvictionGeneration = this.cleanupClock;
  }
}
