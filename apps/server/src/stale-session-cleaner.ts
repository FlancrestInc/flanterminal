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
  dependencyFailure: CleanupDependencyFailure | null;
}>;

export type CleanupDependencyFailure =
  'settings_unavailable' | 'tabs_unavailable';

type CleanupThreshold =
  Readonly<{ available: true; hours: number }> | Readonly<{ available: false }>;

type TimerRegistration = {
  handle?: object;
  cancelling: boolean;
};

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
  private timer: TimerRegistration | undefined;
  private inFlight: Promise<CleanupResult> | undefined;
  private inFlightThresholdHours: number | undefined;
  private inFlightDependencyFailure: CleanupDependencyFailure | null = null;
  private lastResult: CleanupResult | undefined;
  private lastDependencyFailure: CleanupDependencyFailure | null = null;
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
      return this.inFlightThresholdHours === 0 &&
        this.inFlightDependencyFailure === null
        ? Promise.reject(new CleanupDisabledError())
        : this.inFlight;
    }
    const threshold = this.thresholdSnapshot();
    if (threshold.available && threshold.hours === 0)
      return Promise.reject(new CleanupDisabledError());
    return this.startRun(threshold);
  }

  waitForIdle(): Promise<CleanupResult> {
    const current = this.inFlight;
    if (current !== undefined) return current;
    if (this.lastResult !== undefined) return Promise.resolve(this.lastResult);
    return Promise.reject(new Error('Cleanup has not run'));
  }

  status(): CleanupStatus {
    const threshold = this.thresholdSnapshot();
    return Object.freeze({
      enabled: threshold.available && threshold.hours > 0,
      running: this.inFlight !== undefined,
      lastRunAt: this.lastResult?.startedAt ?? null,
      dependencyFailure: threshold.available
        ? this.inFlight !== undefined
          ? this.inFlightDependencyFailure
          : this.lastDependencyFailure
        : 'settings_unavailable',
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

  private startRun(threshold: CleanupThreshold): Promise<CleanupResult> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.cancelTimer();
    this.inFlightThresholdHours = threshold.available
      ? threshold.hours
      : undefined;
    this.inFlightDependencyFailure = threshold.available
      ? null
      : 'settings_unavailable';
    const operation = this.execute(threshold);
    this.inFlight = operation;
    void operation.then(
      (result) => this.finishRun(operation, result),
      () => this.finishRun(operation),
    );
    return operation;
  }

  private async execute(threshold: CleanupThreshold): Promise<CleanupResult> {
    const startedMs = this.validNow();
    const startedAt = new Date(startedMs).toISOString();
    if (!threshold.available) return this.result(false, 0, 0, 0, 1, startedAt);

    const thresholdHours = threshold.hours;
    if (thresholdHours === 0) return this.result(true, 0, 0, 0, 0, startedAt);

    const thresholdMs = thresholdHours * HOUR_MS;
    const cutoffMs = startedMs - thresholdMs;
    let tabs: TabCollection['tabs'];
    try {
      tabs = this.options.tabs
        .snapshot()
        .tabs.slice(0, this.options.maxSessions);
    } catch {
      this.inFlightDependencyFailure = 'tabs_unavailable';
      return this.result(false, 0, 0, 0, 1, startedAt);
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
    if (result !== undefined) {
      this.lastResult = result;
      this.lastDependencyFailure = this.inFlightDependencyFailure;
    }
    this.inFlight = undefined;
    this.inFlightThresholdHours = undefined;
    this.inFlightDependencyFailure = null;
    this.schedule();
  }

  private schedule(): void {
    if (this.shuttingDown || this.timer !== undefined) return;
    const registration: TimerRegistration = { cancelling: false };
    this.timer = registration;
    try {
      registration.handle = this.scheduler.setTimeout(
        () => this.fireTimer(registration),
        this.options.intervalMs,
      );
    } catch {
      if (this.timer === registration) this.timer = undefined;
    }
  }

  private cancelTimer(): void {
    const registration = this.timer;
    if (registration?.handle === undefined) return;
    registration.cancelling = true;
    try {
      this.scheduler.clearTimeout(registration.handle);
    } catch {
      registration.cancelling = false;
      return;
    }
    if (this.timer === registration) this.timer = undefined;
  }

  private fireTimer(registration: TimerRegistration): void {
    if (this.timer !== registration) return;
    this.timer = undefined;
    if (registration.cancelling || this.shuttingDown) return;
    void this.startRun(this.thresholdSnapshot());
  }

  private thresholdSnapshot(): CleanupThreshold {
    try {
      const value = this.options.settings.snapshot().staleSessionCleanupHours;
      return Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_THRESHOLD_HOURS
        ? Object.freeze({ available: true, hours: value })
        : Object.freeze({ available: false });
    } catch {
      return Object.freeze({ available: false });
    }
  }

  private validNow(): number {
    const value = this.now();
    return Number.isSafeInteger(value) ? value : 0;
  }
}
