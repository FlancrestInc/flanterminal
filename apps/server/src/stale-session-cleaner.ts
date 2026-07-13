import { type CleanupResult, type TabCollection } from '@flanterminal/shared';

import type {
  EligibilityRequest,
  EligibilitySnapshot,
} from './cleanup-eligibility.js';
import type { CleanupTerminationResult } from './session-manager.js';

const HOUR_MS = 60 * 60 * 1_000;
const MAX_THRESHOLD_HOURS = 8_760;
const MAX_SESSIONS = 20;

export interface CleanupScheduler {
  setTimeout(callback: () => void, delayMs: number): object;
  clearTimeout(handle: object): void;
}

export interface CleanupSettingsSource {
  snapshot(): Readonly<{ staleSessionCleanupHours: number }>;
}

export interface CleanupTabListSource {
  snapshot(): TabCollection;
}

export interface CleanupEligibilityPort {
  read(request: EligibilityRequest): Promise<EligibilitySnapshot>;
}

export interface CleanupSessionPort {
  terminateIfStale(
    id: string,
    snapshot: EligibilitySnapshot,
  ): Promise<CleanupTerminationResult>;
}

export type StaleSessionCleanerOptions = Readonly<{
  settings: CleanupSettingsSource;
  tabs: CleanupTabListSource;
  eligibility: CleanupEligibilityPort;
  sessions: CleanupSessionPort;
  maxSessions: number;
  intervalMs: number;
  scheduler?: CleanupScheduler;
  now?: () => number;
}>;

export type CleanupStatus = Readonly<{
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
}>;

export class CleanupDisabledError extends Error {
  constructor() {
    super('Stale session cleanup is disabled');
    this.name = new.target.name;
  }
}

const defaultScheduler: CleanupScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class StaleSessionCleaner {
  private readonly scheduler: CleanupScheduler;
  private readonly now: () => number;
  private timer: object | undefined;
  private inFlight: Promise<CleanupResult> | undefined;
  private inFlightThresholdHours: number | undefined;
  private lastResult: CleanupResult | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private shuttingDown = false;

  constructor(private readonly options: StaleSessionCleanerOptions) {
    if (
      !Number.isInteger(options.maxSessions) ||
      options.maxSessions < 1 ||
      options.maxSessions > MAX_SESSIONS ||
      !Number.isSafeInteger(options.intervalMs) ||
      options.intervalMs < 1
    ) {
      throw new Error('Invalid stale session cleanup configuration');
    }
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? Date.now;
    this.schedule();
  }

  runNow(): Promise<CleanupResult> {
    if (this.shuttingDown)
      return Promise.reject(new Error('Cleanup unavailable'));
    if (this.inFlight !== undefined) {
      return this.inFlightThresholdHours === 0
        ? Promise.reject(new CleanupDisabledError())
        : this.inFlight;
    }
    const thresholdHours = this.thresholdHours();
    if (thresholdHours === 0) return Promise.reject(new CleanupDisabledError());
    return this.startRun(thresholdHours);
  }

  waitForIdle(): Promise<CleanupResult> {
    const current = this.inFlight;
    if (current !== undefined) return current;
    if (this.lastResult !== undefined) return Promise.resolve(this.lastResult);
    return Promise.reject(new Error('Cleanup has not run'));
  }

  status(): CleanupStatus {
    return Object.freeze({
      enabled: this.thresholdHours() > 0,
      running: this.inFlight !== undefined,
      lastRunAt: this.lastResult?.startedAt ?? null,
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.shuttingDown = true;
    const current = this.inFlight;
    this.shutdownPromise =
      current?.then(
        () => undefined,
        () => undefined,
      ) ?? Promise.resolve();
    this.cancelTimer();
    return this.shutdownPromise;
  }

  private startRun(thresholdHours: number): Promise<CleanupResult> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.cancelTimer();
    const operation = this.execute(thresholdHours);
    this.inFlight = operation;
    this.inFlightThresholdHours = thresholdHours;
    void operation.then(
      (result) => this.finishRun(operation, result),
      () => this.finishRun(operation),
    );
    return operation;
  }

  private async execute(thresholdHours: number): Promise<CleanupResult> {
    const startedMs = this.validNow();
    const startedAt = new Date(startedMs).toISOString();
    if (thresholdHours === 0) return this.result(true, 0, 0, 0, 0, startedAt);

    const thresholdMs = thresholdHours * HOUR_MS;
    const cutoffMs = startedMs - thresholdMs;
    let tabs: TabCollection['tabs'];
    try {
      tabs = this.options.tabs
        .snapshot()
        .tabs.slice(0, this.options.maxSessions);
    } catch {
      return this.result(false, 0, 0, 0, 0, startedAt);
    }

    let examined = 0;
    let terminated = 0;
    let skipped = 0;
    let failed = 0;
    for (const tab of tabs) {
      examined += 1;
      try {
        const snapshot = await this.options.eligibility.read({
          id: tab.id,
          thresholdMs,
          cutoffMs,
        });
        if (!snapshot.eligible) {
          skipped += 1;
          continue;
        }
        const outcome = await this.options.sessions.terminateIfStale(
          tab.id,
          snapshot,
        );
        if (outcome === 'terminated') terminated += 1;
        else if (outcome.startsWith('skipped:')) skipped += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return this.result(false, examined, terminated, skipped, failed, startedAt);
  }

  private result(
    disabled: boolean,
    examined: number,
    terminated: number,
    skipped: number,
    failed: number,
    startedAt: string,
  ): CleanupResult {
    return Object.freeze({
      disabled,
      examined,
      terminated,
      skipped,
      failed,
      startedAt,
      finishedAt: new Date(this.validNow()).toISOString(),
    });
  }

  private finishRun(
    operation: Promise<CleanupResult>,
    result?: CleanupResult,
  ): void {
    if (this.inFlight !== operation) return;
    if (result !== undefined) this.lastResult = result;
    this.inFlight = undefined;
    this.inFlightThresholdHours = undefined;
    this.schedule();
  }

  private schedule(): void {
    if (this.shuttingDown || this.timer !== undefined) return;
    try {
      this.timer = this.scheduler.setTimeout(() => {
        this.timer = undefined;
        if (this.shuttingDown) return;
        void this.startRun(this.thresholdHours());
      }, this.options.intervalMs);
    } catch {
      this.timer = undefined;
    }
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    const timer = this.timer;
    this.timer = undefined;
    try {
      this.scheduler.clearTimeout(timer);
    } catch {
      // Local ownership is cleared even when the scheduler cannot cancel it.
    }
  }

  private thresholdHours(): number {
    try {
      const value = this.options.settings.snapshot().staleSessionCleanupHours;
      return Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_THRESHOLD_HOURS
        ? value
        : 0;
    } catch {
      return 0;
    }
  }

  private validNow(): number {
    const value = this.now();
    return Number.isSafeInteger(value) ? value : 0;
  }
}
