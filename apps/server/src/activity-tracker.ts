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

const defaultScheduler: ActivityScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class ActivityTracker {
  private readonly dirtyIds = new Set<string>();
  private readonly scheduler: ActivityScheduler;
  private readonly now: () => string;
  private readonly intervalMs: number;
  private timer: object | undefined;
  private inFlight: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private accepting = true;

  constructor(private readonly options: ActivityTrackerOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? (() => new Date().toISOString());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  mark(tabId: string): void {
    if (!this.accepting) return;
    this.dirtyIds.add(tabId);
    this.schedule();
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.accepting = false;
    this.cancelTimer();
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
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
    this.inFlight = this.flushAndRetainOnFailure(ids);
  }

  private async flushAndRetainOnFailure(
    ids: ReadonlySet<string>,
  ): Promise<void> {
    try {
      await this.options.store.flushActivity(ids, this.now());
    } catch {
      for (const id of ids) this.dirtyIds.add(id);
    } finally {
      this.inFlight = undefined;
      this.schedule();
    }
  }

  private async finishShutdown(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (this.dirtyIds.size === 0) return;

    const ids = this.takeDirtySnapshot();
    try {
      await this.options.store.flushActivity(ids, this.now());
    } catch {
      throw new Error(SHUTDOWN_ERROR_MESSAGE);
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
}
