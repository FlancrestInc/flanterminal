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
import type { WebSocketRuntimeSnapshot } from './websocket-auth-index.js';

const HARD_MAX_SESSIONS = 20;
const DEFAULT_PROBE_CONCURRENCY = 4;
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
  entries(): readonly BridgeRuntimeSnapshot[];
}

export interface AdminSocketSource {
  entries(): readonly WebSocketRuntimeSnapshot[];
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
  private readonly uptime: () => number;
  private readonly memoryUsage: () => Readonly<{
    rss: number;
    heapUsed: number;
  }>;
  private readonly errors = new Map<string, AdminLifecycleError>();

  constructor(private readonly options: AdminServiceOptions) {
    if (
      !Number.isInteger(options.maxSessions) ||
      options.maxSessions < 1 ||
      options.maxSessions > HARD_MAX_SESSIONS
    ) {
      throw new Error('Invalid administration session capacity');
    }
    const concurrency = options.probeConcurrency ?? DEFAULT_PROBE_CONCURRENCY;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > HARD_MAX_SESSIONS
    ) {
      throw new Error('Invalid administration probe concurrency');
    }
    this.maxSessions = options.maxSessions;
    this.probeConcurrency = concurrency;
    this.now = options.now ?? Date.now;
    this.uptime = options.uptime ?? (() => process.uptime());
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  }

  async snapshot(): Promise<AdminSnapshot> {
    const now = safeEpoch(this.readNumber(this.now));
    const tabs = this.orderedTabs();
    this.retainCurrentErrors(new Set(tabs.map((tab) => tab.id)));
    const bridges = bridgeMap(this.readBridgeEntries());
    const sockets = socketMap(this.readSocketEntries());
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
        bridges: bridges.size,
        webSockets: [...sockets.values()].reduce(
          (sum, count) => sum + count,
          0,
        ),
      },
      cleanup: cleanupStatus,
      sessions: rows,
    });
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
      const exists = await this.options.runtime.exists(tab.id);
      if (typeof exists !== 'boolean') throw new Error();
      observedState = exists ? 'running' : 'stopped';
    } catch {
      observedState = 'unknown';
      dependencyError = 'session_status_unavailable';
    }

    let cleanupEligible = false;
    if (thresholdHours > 0) {
      try {
        const eligibility = await this.options.eligibility.read({
          id: tab.id,
          thresholdMs,
          cutoffMs,
        });
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

  private readBridgeEntries(): readonly BridgeRuntimeSnapshot[] {
    try {
      const entries = this.options.bridges.entries();
      return Array.isArray(entries)
        ? entries.slice(0, this.maxSessions)
        : Object.freeze([]);
    } catch {
      return Object.freeze([]);
    }
  }

  private readSocketEntries(): readonly WebSocketRuntimeSnapshot[] {
    try {
      const entries = this.options.sockets.entries();
      return Array.isArray(entries)
        ? entries.slice(0, this.maxSessions)
        : Object.freeze([]);
    } catch {
      return Object.freeze([]);
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

function socketMap(
  entries: readonly WebSocketRuntimeSnapshot[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const entry of entries) {
    if (!isSessionId(entry.terminalTabId)) continue;
    const count = safeNonnegativeInteger(entry.count);
    result.set(
      entry.terminalTabId,
      safeNonnegativeInteger((result.get(entry.terminalTabId) ?? 0) + count),
    );
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
