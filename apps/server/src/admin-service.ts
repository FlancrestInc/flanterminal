import {
  isSessionId,
  parseAdminSnapshot,
  type AdminSnapshot,
  type SessionState,
  type TabCollection,
  type TabRecord,
} from '@flanterminal/shared';

import type { BridgeRuntimeSnapshot } from './bridge-registry.js';
import type {
  EligibilityRequest,
  EligibilitySnapshot,
} from './cleanup-eligibility.js';
import type { CleanupStatus } from './stale-session-cleaner.js';
import { tmuxSessionName } from './tmux.js';

const HARD_MAX_SESSIONS = 20;
const DEFAULT_PROBE_CONCURRENCY = 4;
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROBE_TIMEOUT_MS = 60_000;
const MAX_THRESHOLD_HOURS = 8_760;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_DATE_MS = 253_402_300_799_999;

export type AdminLifecycleError =
  | 'invalid_session_state'
  | 'operation_failed'
  | 'session_status_unavailable'
  | 'cleanup_status_unavailable';

const lifecycleErrors = new Set<AdminLifecycleError>([
  'invalid_session_state',
  'operation_failed',
  'session_status_unavailable',
  'cleanup_status_unavailable',
]);

export interface AdminTabSource {
  snapshot(): TabCollection;
}

export interface AdminRuntimeSource {
  exists(id: string): Promise<boolean>;
}

export interface AdminBridgeSource {
  snapshotFor(sessionIds: readonly string[]): readonly BridgeRuntimeSnapshot[];
  registeredCount(): number;
}

export interface AdminSocketSource {
  countForTab(id: string): number;
  connectedCount(): number;
}

export interface AdminEligibilitySource {
  read(request: EligibilityRequest): Promise<EligibilitySnapshot>;
}

export interface AdminCleanupSettingsSource {
  snapshot(): Readonly<{ staleSessionCleanupHours: number }>;
}

export interface AdminCleanupSource {
  status(): CleanupStatus;
}

export interface AdminProbeScheduler {
  setTimeout(callback: () => void, delayMs: number): object;
  clearTimeout(handle: object): void;
}

export type AdminServiceOptions = Readonly<{
  tabs: AdminTabSource;
  runtime: AdminRuntimeSource;
  bridges: AdminBridgeSource;
  sockets: AdminSocketSource;
  eligibility: AdminEligibilitySource;
  cleanupSettings: AdminCleanupSettingsSource;
  cleanup: AdminCleanupSource;
  maxSessions: number;
  probeConcurrency?: number;
  probeTimeoutMs?: number;
  probeScheduler?: AdminProbeScheduler;
  now?: () => number;
  uptime?: () => number;
  memoryUsage?: () => Readonly<{ rss: number; heapUsed: number }>;
}>;

type RowHealth = Readonly<{
  observedState: SessionState;
  cleanupEligible: boolean;
  dependencyError: AdminLifecycleError | null;
}>;

export class AdminService {
  private readonly maxSessions: number;
  private readonly probeConcurrency: number;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private readonly probeScheduler: AdminProbeScheduler;
  private readonly probeGate: ProbeGate;
  private readonly uptime: () => number;
  private readonly memoryUsage: () => Readonly<{
    rss: number;
    heapUsed: number;
  }>;
  private readonly errors = new Map<string, AdminLifecycleError>();
  private inFlightSnapshot: Promise<AdminSnapshot> | undefined;

  constructor(private readonly options: AdminServiceOptions) {
    if (
      !Number.isInteger(options.maxSessions) ||
      options.maxSessions < 1 ||
      options.maxSessions > HARD_MAX_SESSIONS
    ) {
      throw new Error('Invalid administration session capacity');
    }
    const concurrency = options.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
    const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > HARD_MAX_SESSIONS
    ) {
      throw new Error('Invalid administration probe concurrency');
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_PROBE_TIMEOUT_MS
    ) {
      throw new Error('Invalid administration probe timeout');
    }
    this.maxSessions = options.maxSessions;
    this.probeConcurrency = concurrency;
    this.probeTimeoutMs = timeoutMs;
    this.probeScheduler = options.probeScheduler ?? defaultProbeScheduler;
    this.probeGate = new ProbeGate(concurrency);
    this.now = options.now ?? Date.now;
    this.uptime = options.uptime ?? (() => process.uptime());
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  }

  snapshot(): Promise<AdminSnapshot> {
    if (this.inFlightSnapshot !== undefined) return this.inFlightSnapshot;
    const operation = this.buildSnapshot();
    this.inFlightSnapshot = operation;
    void operation.then(
      () => this.finishSnapshot(operation),
      () => this.finishSnapshot(operation),
    );
    return operation;
  }

  private async buildSnapshot(): Promise<AdminSnapshot> {
    const now = safeEpoch(this.readNumber(this.now));
    const tabs = this.orderedTabs();
    this.retainCurrentErrors(new Set(tabs.map((tab) => tab.id)));
    const tabIds = tabs.map((tab) => tab.id);
    const bridges = bridgeMap(this.readBridgeEntries(tabIds));
    const sockets = this.readSocketCounts(tabIds);
    const bridgeTotal = this.readBridgeTotal();
    const socketTotal = this.readSocketTotal();
    const cleanupStatus = this.readCleanupStatus();
    const thresholdHours = this.readCleanupThreshold();
    const thresholdMs = thresholdHours * HOUR_MS;
    const cutoffMs = now - thresholdMs;
    const health = await mapConcurrent(tabs, this.probeConcurrency, (tab) =>
      this.readHealth(tab, thresholdHours, thresholdMs, cutoffMs),
    );
    const rows = tabs.map((tab, index) => {
      const current = health[index] ?? {
        observedState: 'unknown' as const,
        cleanupEligible: false,
        dependencyError: 'session_status_unavailable' as const,
      };
      return {
        id: tab.id,
        displayName: tab.displayName,
        tmuxSessionName: tmuxSessionName(tab.id),
        desiredState: tab.desiredState,
        observedState: current.observedState,
        createdAt: tab.createdAt,
        lastActivityAt: tab.lastActivityAt,
        ageSeconds: ageSeconds(tab.createdAt, now),
        connectedWebSockets: sockets.get(tab.id) ?? 0,
        bridgePid: bridges.get(tab.id) ?? null,
        cleanupEligible: current.cleanupEligible,
        lifecycleError: this.errors.get(tab.id) ?? current.dependencyError,
      };
    });
    const memory = this.readMemory();
    return parseAdminSnapshot({
      generatedAt: new Date(now).toISOString(),
      uptimeSeconds: safeNonnegativeNumber(this.readNumber(this.uptime)),
      memory,
      totals: {
        tabs: rows.length,
        runningSessions: rows.filter((row) => row.observedState === 'running')
          .length,
        bridges: bridgeTotal,
        webSockets: socketTotal,
      },
      cleanup: cleanupStatus,
      sessions: rows,
    });
  }

  private finishSnapshot(operation: Promise<AdminSnapshot>): void {
    if (this.inFlightSnapshot === operation) this.inFlightSnapshot = undefined;
  }

  recordLifecycleError(id: string, error: AdminLifecycleError): void {
    if (!isSessionId(id) || !lifecycleErrors.has(error)) return;
    this.errors.delete(id);
    this.errors.set(id, error);
    while (this.errors.size > this.maxSessions) {
      const oldest = this.errors.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.errors.delete(oldest);
    }
  }

  clearLifecycleError(id: string): void {
    if (isSessionId(id)) this.errors.delete(id);
  }

  lifecycleErrorCount(): number {
    return this.errors.size;
  }

  private orderedTabs(): TabRecord[] {
    const snapshot = this.options.tabs.snapshot();
    return [...snapshot.tabs]
      .sort((left, right) => left.position - right.position)
      .slice(0, this.maxSessions);
  }

  private async readHealth(
    tab: TabRecord,
    thresholdHours: number,
    thresholdMs: number,
    cutoffMs: number,
  ): Promise<RowHealth> {
    let observedState: SessionState;
    let dependencyError: AdminLifecycleError | null = null;
    try {
      const exists = await this.probe(() =>
        this.options.runtime.exists(tab.id),
      );
      if (typeof exists !== 'boolean') throw new Error();
      observedState = exists ? 'running' : 'stopped';
    } catch {
      observedState = 'unknown';
      dependencyError = 'session_status_unavailable';
    }

    let cleanupEligible = false;
    if (
      thresholdHours > 0 &&
      tab.desiredState === 'active' &&
      observedState === 'running'
    ) {
      try {
        const eligibility = await this.probe(() =>
          this.options.eligibility.read({
            id: tab.id,
            thresholdMs,
            cutoffMs,
          }),
        );
        cleanupEligible =
          eligibility.id === tab.id &&
          eligibility.thresholdMs === thresholdMs &&
          eligibility.cutoffMs === cutoffMs &&
          eligibility.eligible === true;
      } catch {
        dependencyError ??= 'cleanup_status_unavailable';
      }
    }
    return Object.freeze({
      observedState,
      cleanupEligible,
      dependencyError,
    });
  }

  private probe<T>(operation: () => Promise<T>): Promise<T> {
    return boundedProbe(
      this.probeGate,
      this.probeScheduler,
      this.probeTimeoutMs,
      operation,
    );
  }

  private readBridgeEntries(
    sessionIds: readonly string[],
  ): readonly BridgeRuntimeSnapshot[] {
    try {
      const entries = this.options.bridges.snapshotFor(sessionIds);
      return Array.isArray(entries)
        ? entries.slice(0, this.maxSessions)
        : Object.freeze([]);
    } catch {
      return Object.freeze([]);
    }
  }

  private readSocketCounts(
    sessionIds: readonly string[],
  ): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const id of sessionIds.slice(0, this.maxSessions)) {
      try {
        counts.set(
          id,
          safeNonnegativeInteger(this.options.sockets.countForTab(id)),
        );
      } catch {
        counts.set(id, 0);
      }
    }
    return counts;
  }

  private readBridgeTotal(): number {
    try {
      return safeNonnegativeInteger(this.options.bridges.registeredCount());
    } catch {
      return 0;
    }
  }

  private readSocketTotal(): number {
    try {
      return safeNonnegativeInteger(this.options.sockets.connectedCount());
    } catch {
      return 0;
    }
  }

  private readCleanupThreshold(): number {
    try {
      const value =
        this.options.cleanupSettings.snapshot().staleSessionCleanupHours;
      return Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_THRESHOLD_HOURS
        ? value
        : 0;
    } catch {
      return 0;
    }
  }

  private readCleanupStatus(): AdminSnapshot['cleanup'] {
    try {
      const status = this.options.cleanup.status();
      return Object.freeze({
        enabled: status.enabled === true,
        running: status.running === true,
        lastRunAt: canonicalTimestamp(status.lastRunAt),
      });
    } catch {
      return Object.freeze({ enabled: false, running: false, lastRunAt: null });
    }
  }

  private readMemory(): AdminSnapshot['memory'] {
    try {
      const memory = this.memoryUsage();
      return Object.freeze({
        rss: safeNonnegativeInteger(memory.rss),
        heapUsed: safeNonnegativeInteger(memory.heapUsed),
      });
    } catch {
      return Object.freeze({ rss: 0, heapUsed: 0 });
    }
  }

  private readNumber(source: () => number): number {
    try {
      return source();
    } catch {
      return 0;
    }
  }

  private retainCurrentErrors(ids: ReadonlySet<string>): void {
    for (const id of this.errors.keys()) {
      if (!ids.has(id)) this.errors.delete(id);
    }
  }
}

function bridgeMap(
  entries: readonly BridgeRuntimeSnapshot[],
): ReadonlyMap<string, number | null> {
  const result = new Map<string, number | null>();
  for (const entry of entries) {
    if (!isSessionId(entry.sessionId) || entry.attached !== true) continue;
    result.set(entry.sessionId, safePid(entry.pid));
  }
  return result;
}

function safePid(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function safeEpoch(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS
    ? value
    : 0;
}

function safeNonnegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function safeNonnegativeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function ageSeconds(createdAt: string, now: number): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 0;
  return safeNonnegativeNumber((now - created) / 1_000);
}

function canonicalTimestamp(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Date(parsed).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (next < values.length) {
        const index = next;
        next += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await operation(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const defaultProbeScheduler: AdminProbeScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

class ProbeTimeoutError extends Error {}

type ProbeLease = Readonly<{
  granted: Promise<() => void>;
  cancel(): void;
}>;

type ProbeWaiter = {
  cancelled: boolean;
  granted: boolean;
  release: (() => void) | undefined;
  resolve(release: () => void): void;
};

class ProbeGate {
  private active = 0;
  private readonly waiters: ProbeWaiter[] = [];

  constructor(private readonly capacity: number) {}

  acquire(): ProbeLease {
    let resolveGrant!: (release: () => void) => void;
    const waiter: ProbeWaiter = {
      cancelled: false,
      granted: false,
      release: undefined,
      resolve: (release) => resolveGrant(release),
    };
    const granted = new Promise<() => void>((resolve) => {
      resolveGrant = resolve;
    });
    this.waiters.push(waiter);
    this.drain();
    return Object.freeze({
      granted,
      cancel: () => {
        if (waiter.cancelled) return;
        waiter.cancelled = true;
        if (waiter.granted) waiter.release?.();
        else {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
        }
      },
    });
  }

  private drain(): void {
    while (this.active < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined || waiter.cancelled) continue;
      this.active += 1;
      waiter.granted = true;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      };
      waiter.release = release;
      waiter.resolve(release);
    }
  }
}

function boundedProbe<T>(
  gate: ProbeGate,
  scheduler: AdminProbeScheduler,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: object | undefined;
    let cancelWaiting = (): void => undefined;
    let started = false;
    let returned = false;

    const finish = (outcome: () => void): void => {
      if (returned) return;
      returned = true;
      if (timer !== undefined) {
        try {
          scheduler.clearTimeout(timer);
        } catch {
          // The probe result remains authoritative if timer disposal fails.
        }
        timer = undefined;
      }
      outcome();
    };

    try {
      timer = scheduler.setTimeout(() => {
        timer = undefined;
        if (!started) cancelWaiting();
        finish(() => reject(new ProbeTimeoutError()));
      }, timeoutMs);
    } catch {
      reject(new ProbeTimeoutError());
      return;
    }

    const lease = gate.acquire();
    cancelWaiting = lease.cancel;
    void lease.granted.then((release) => {
      if (returned) {
        release();
        return;
      }
      started = true;
      const underlying = Promise.resolve().then(operation);
      void underlying.then(
        (value) => {
          release();
          finish(() => resolve(value));
        },
        (error: unknown) => {
          release();
          finish(() => reject(error));
        },
      );
    });
  });
}
