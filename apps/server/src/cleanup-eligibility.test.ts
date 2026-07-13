import { describe, expect, it, vi } from 'vitest';

import {
  CleanupEligibilityReader,
  type CleanupEligibilityReaderOptions,
} from './cleanup-eligibility.js';

const TAB = '550e8400-e29b-41d4-a716-446655440000';
const NOW = Date.parse('2026-07-13T12:00:00.000Z');
const CUTOFF = NOW - 60 * 60 * 1_000;

describe('CleanupEligibilityReader', () => {
  it('returns a frozen eligible snapshot only for an old active disconnected session', async () => {
    const harness = eligibilityHarness();
    const result = await harness.reader.read({
      id: TAB,
      thresholdMs: 3_600_000,
      cutoffMs: CUTOFF,
    });

    expect(result).toMatchObject({
      id: TAB,
      thresholdMs: 3_600_000,
      cutoffMs: CUTOFF,
      eligible: true,
      reason: null,
      generation: { structure: 4, activity: 0, sockets: 0 },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.generation)).toBe(true);
  });

  it.each([
    ['disabled', { thresholdMs: 0 }],
    ['tab_absent', { absent: true }],
    ['inactive', { desiredState: 'stopped' }],
    ['session_absent', { exists: false }],
    ['connected', { socketCount: 1 }],
    ['bridged', { bridged: true }],
    ['activity_pending', { activityPending: true }],
    ['recent_activity', { lastActivityAt: new Date(CUTOFF).toISOString() }],
  ] as const)('skips %s sessions conservatively', async (reason, changes) => {
    const harness = eligibilityHarness(changes);
    await expect(
      harness.reader.read({
        id: TAB,
        thresholdMs: 'thresholdMs' in changes ? changes.thresholdMs : 3_600_000,
        cutoffMs: CUTOFF,
      }),
    ).resolves.toMatchObject({ eligible: false, reason });
  });

  it('uses creation time only when activity is absent and requires strictly older timestamps', async () => {
    const old = eligibilityHarness({ lastActivityAt: null });
    const boundary = eligibilityHarness({
      lastActivityAt: null,
      createdAt: new Date(CUTOFF).toISOString(),
    });

    await expect(
      old.reader.read({ id: TAB, thresholdMs: 3_600_000, cutoffMs: CUTOFF }),
    ).resolves.toMatchObject({ eligible: true, reason: null });
    await expect(
      boundary.reader.read({
        id: TAB,
        thresholdMs: 3_600_000,
        cutoffMs: CUTOFF,
      }),
    ).resolves.toMatchObject({ eligible: false, reason: 'recent_activity' });
  });

  it.each([
    { createdAt: 'not-a-date', lastActivityAt: null },
    { lastActivityAt: 'not-a-date' },
    { lastActivityAt: '2026-07-10' },
  ])('skips invalid timestamps', async (changes) => {
    const harness = eligibilityHarness(changes);
    await expect(
      harness.reader.read({
        id: TAB,
        thresholdMs: 3_600_000,
        cutoffMs: CUTOFF,
      }),
    ).resolves.toMatchObject({ eligible: false, reason: 'invalid_timestamp' });
  });

  it('fails closed on dependency errors and asynchronous generation drift', async () => {
    const failed = eligibilityHarness();
    failed.exists.mockRejectedValueOnce(new Error('private tmux detail'));
    const drifting = eligibilityHarness();
    drifting.exists.mockImplementationOnce(async () => {
      drifting.activityState.generation += 1;
      return true;
    });

    await expect(
      failed.reader.read({ id: TAB, thresholdMs: 3_600_000, cutoffMs: CUTOFF }),
    ).resolves.toMatchObject({ eligible: false, reason: 'dependency_error' });
    await expect(
      drifting.reader.read({
        id: TAB,
        thresholdMs: 3_600_000,
        cutoffMs: CUTOFF,
      }),
    ).resolves.toMatchObject({ eligible: false, reason: 'changed' });
  });

  it('bounds invalid identifiers and incoherent dependency results', async () => {
    const harness = eligibilityHarness();
    await expect(
      harness.reader.read({
        id: 'x'.repeat(10_000),
        thresholdMs: 3_600_000,
        cutoffMs: CUTOFF,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ id: '', eligible: false, reason: 'invalid' }),
    );
    harness.socketState.count = Number.MAX_SAFE_INTEGER + 1;
    await expect(
      harness.reader.read({
        id: TAB,
        thresholdMs: 3_600_000,
        cutoffMs: CUTOFF,
      }),
    ).resolves.toMatchObject({ eligible: false, reason: 'dependency_error' });

    const invalidState = eligibilityHarness({ desiredState: 'invalid' });
    await expect(
      invalidState.reader.read({
        id: TAB,
        thresholdMs: 3_600_000,
        cutoffMs: CUTOFF,
      }),
    ).resolves.toMatchObject({ eligible: false, reason: 'dependency_error' });
  });
});

function eligibilityHarness(
  changes: {
    thresholdMs?: number;
    absent?: boolean;
    desiredState?: 'active' | 'stopped' | 'invalid';
    exists?: boolean;
    socketCount?: number;
    bridged?: boolean;
    activityPending?: boolean;
    createdAt?: string;
    lastActivityAt?: string | null;
  } = {},
) {
  const activityState = {
    generation: 0,
    pending: changes.activityPending ?? false,
  };
  const socketState = { generation: 0, count: changes.socketCount ?? 0 };
  const tab = {
    id: TAB,
    displayName: 'Terminal',
    position: 0,
    createdAt: changes.createdAt ?? new Date(CUTOFF - 60_000).toISOString(),
    lastActivityAt: Object.hasOwn(changes, 'lastActivityAt')
      ? changes.lastActivityAt
      : new Date(CUTOFF - 60_000).toISOString(),
    desiredState: changes.desiredState ?? 'active',
  };
  const exists = vi.fn(async () => changes.exists ?? true);
  const options: CleanupEligibilityReaderOptions = {
    tabs: {
      snapshot: () => ({
        structureRevision: 4,
        tabs: changes.absent ? [] : [tab as never],
      }),
    },
    activity: { cleanupSnapshot: () => Object.freeze({ ...activityState }) },
    sockets: { cleanupSnapshot: () => Object.freeze({ ...socketState }) },
    bridges: { get: () => (changes.bridged ? {} : undefined) },
    runtime: { exists },
  };
  return {
    reader: new CleanupEligibilityReader(options),
    activityState,
    socketState,
    exists,
  };
}
