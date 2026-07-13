import { isSessionId, type TabCollection } from '@flanterminal/shared';

import type { ActivityCleanupSnapshot } from './activity-tracker.js';
import type { WebSocketCleanupSnapshot } from './websocket-auth-index.js';

const MAX_TABS = 20;
const MAX_SOCKETS = 1_024;
const MAX_THRESHOLD_MS = 8_760 * 60 * 60 * 1_000;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export type CleanupSkipReason =
  | 'disabled'
  | 'invalid'
  | 'tab_absent'
  | 'inactive'
  | 'session_absent'
  | 'connected'
  | 'bridged'
  | 'activity_pending'
  | 'recent_activity'
  | 'invalid_timestamp'
  | 'dependency_error'
  | 'changed';

export type EligibilityGeneration = Readonly<{
  structure: number;
  activity: number;
  sockets: number;
}>;

export type EligibilitySnapshot = Readonly<{
  id: string;
  thresholdMs: number;
  cutoffMs: number;
  eligible: boolean;
  reason: CleanupSkipReason | null;
  generation: EligibilityGeneration;
}>;

export type EligibilityRequest = Readonly<{
  id: string;
  thresholdMs: number;
  cutoffMs: number;
}>;

export interface CleanupTabSource {
  snapshot(): TabCollection;
}

export interface CleanupActivitySource {
  cleanupSnapshot(id: string): ActivityCleanupSnapshot;
}

export interface CleanupSocketSource {
  cleanupSnapshot(id: string): WebSocketCleanupSnapshot;
}

export interface CleanupBridgeSource {
  get(id: string): unknown;
}

export interface CleanupRuntimeSource {
  exists(id: string): Promise<boolean>;
}

export type CleanupEligibilityReaderOptions = Readonly<{
  tabs: CleanupTabSource;
  activity: CleanupActivitySource;
  sockets: CleanupSocketSource;
  bridges: CleanupBridgeSource;
  runtime: CleanupRuntimeSource;
}>;

type SynchronousState = Readonly<{
  structure: number;
  desiredState: unknown;
  createdAt: unknown;
  lastActivityAt: unknown;
  activity: ActivityCleanupSnapshot;
  sockets: WebSocketCleanupSnapshot;
  bridged: boolean;
}>;

export class CleanupEligibilityReader {
  constructor(private readonly options: CleanupEligibilityReaderOptions) {}

  async read(request: EligibilityRequest): Promise<EligibilitySnapshot> {
    if (!validRequest(request)) return result(request, false, 'invalid');
    if (request.thresholdMs === 0) return result(request, false, 'disabled');

    let before: SynchronousState;
    try {
      const state = this.capture(request.id);
      if (state === undefined) return result(request, false, 'tab_absent');
      before = state;
    } catch {
      return result(request, false, 'dependency_error');
    }

    let exists: boolean;
    try {
      exists = await this.options.runtime.exists(request.id);
      if (typeof exists !== 'boolean') throw new Error();
    } catch {
      return result(request, false, 'dependency_error', before);
    }

    let after: SynchronousState;
    try {
      const state = this.capture(request.id);
      if (state === undefined) return result(request, false, 'changed', before);
      after = state;
    } catch {
      return result(request, false, 'dependency_error', before);
    }

    if (!sameState(before, after))
      return result(request, false, 'changed', after);
    if (after.desiredState !== 'active')
      return result(request, false, 'inactive', after);
    if (!exists) return result(request, false, 'session_absent', after);
    if (after.sockets.count > 0)
      return result(request, false, 'connected', after);
    if (after.bridged) return result(request, false, 'bridged', after);
    if (after.activity.pending)
      return result(request, false, 'activity_pending', after);

    const timestampValue = after.lastActivityAt ?? after.createdAt;
    if (typeof timestampValue !== 'string')
      return result(request, false, 'invalid_timestamp', after);
    const timestamp = Date.parse(timestampValue);
    if (
      !UTC_TIMESTAMP_PATTERN.test(timestampValue) ||
      !Number.isFinite(timestamp)
    )
      return result(request, false, 'invalid_timestamp', after);
    if (timestamp >= request.cutoffMs)
      return result(request, false, 'recent_activity', after);
    return result(request, true, null, after);
  }

  private capture(id: string): SynchronousState | undefined {
    const tabs = this.options.tabs.snapshot();
    if (
      !Number.isSafeInteger(tabs.structureRevision) ||
      tabs.structureRevision < 0 ||
      !Array.isArray(tabs.tabs) ||
      tabs.tabs.length > MAX_TABS
    ) {
      throw new Error();
    }
    const matches = tabs.tabs.filter((tab) => tab.id === id);
    if (matches.length > 1) throw new Error();
    const tab = matches[0];
    if (tab === undefined) return undefined;
    if (tab.desiredState !== 'active' && tab.desiredState !== 'stopped') {
      throw new Error();
    }

    const activity = this.options.activity.cleanupSnapshot(id);
    const sockets = this.options.sockets.cleanupSnapshot(id);
    if (
      !validGeneration(activity.generation) ||
      typeof activity.pending !== 'boolean' ||
      !validGeneration(sockets.generation) ||
      !Number.isSafeInteger(sockets.count) ||
      sockets.count < 0 ||
      sockets.count > MAX_SOCKETS
    ) {
      throw new Error();
    }
    return Object.freeze({
      structure: tabs.structureRevision,
      desiredState: tab.desiredState,
      createdAt: tab.createdAt,
      lastActivityAt: tab.lastActivityAt,
      activity,
      sockets,
      bridged: this.options.bridges.get(id) !== undefined,
    });
  }
}

export function sameEligibilityGeneration(
  left: EligibilitySnapshot,
  right: EligibilitySnapshot,
): boolean {
  return (
    left.id === right.id &&
    left.thresholdMs === right.thresholdMs &&
    left.cutoffMs === right.cutoffMs &&
    left.generation.structure === right.generation.structure &&
    left.generation.activity === right.generation.activity &&
    left.generation.sockets === right.generation.sockets
  );
}

function validRequest(request: EligibilityRequest): boolean {
  return (
    isSessionId(request.id) &&
    Number.isSafeInteger(request.thresholdMs) &&
    request.thresholdMs >= 0 &&
    request.thresholdMs <= MAX_THRESHOLD_MS &&
    Number.isSafeInteger(request.cutoffMs)
  );
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameState(left: SynchronousState, right: SynchronousState): boolean {
  return (
    left.structure === right.structure &&
    left.desiredState === right.desiredState &&
    left.createdAt === right.createdAt &&
    left.lastActivityAt === right.lastActivityAt &&
    left.activity.generation === right.activity.generation &&
    left.activity.pending === right.activity.pending &&
    left.sockets.generation === right.sockets.generation &&
    left.sockets.count === right.sockets.count &&
    left.bridged === right.bridged
  );
}

function result(
  request: EligibilityRequest,
  eligible: boolean,
  reason: CleanupSkipReason | null,
  state?: SynchronousState,
): EligibilitySnapshot {
  const generation = Object.freeze({
    structure: state?.structure ?? 0,
    activity: state?.activity.generation ?? 0,
    sockets: state?.sockets.generation ?? 0,
  });
  return Object.freeze({
    id: isSessionId(request.id) ? request.id : '',
    thresholdMs:
      Number.isSafeInteger(request.thresholdMs) && request.thresholdMs >= 0
        ? request.thresholdMs
        : 0,
    cutoffMs: Number.isSafeInteger(request.cutoffMs) ? request.cutoffMs : 0,
    eligible,
    reason,
    generation,
  });
}
