import { describe, expect, it, vi } from 'vitest';

import type { EligibilitySnapshot } from './cleanup-eligibility.js';
import { AdminService, type AdminServiceOptions } from './admin-service.js';

const TAB_A = '550e8400-e29b-41d4-a716-446655440000';
const TAB_B = '123e4567-e89b-42d3-a456-426614174000';
const GENERATED_AT = '2026-07-12T18:00:00.000Z';
const NOW = Date.parse(GENERATED_AT);

describe('AdminService', () => {
  it('builds an ordered immutable bounded administration snapshot', async () => {
    const options = dependencies();
    const service = new AdminService(options);

    const snapshot = await service.snapshot();

    expect(snapshot).toEqual({
      generatedAt: GENERATED_AT,
      uptimeSeconds: 7_200.5,
      memory: { rss: 100_000_000, heapUsed: 25_000_000 },
      totals: { tabs: 2, runningSessions: 1, bridges: 1, webSockets: 3 },
      cleanup: { enabled: true, running: false, lastRunAt: null },
      sessions: [
        {
          id: TAB_A,
          displayName: 'First',
          tmuxSessionName: 'webterm-tab-550e8400e29b41d4a716446655440000',
          desiredState: 'active',
          observedState: 'running',
          createdAt: '2026-07-12T16:00:00.000Z',
          lastActivityAt: '2026-07-12T17:00:00.000Z',
          ageSeconds: 7_200,
          connectedWebSockets: 2,
          bridgePid: 4321,
          cleanupEligible: true,
          lifecycleError: null,
        },
        {
          id: TAB_B,
          displayName: 'Second',
          tmuxSessionName: 'webterm-tab-123e4567e89b42d3a456426614174000',
          desiredState: 'stopped',
          observedState: 'stopped',
          createdAt: '2026-07-12T17:00:00.000Z',
          lastActivityAt: '2026-07-12T17:30:00.000Z',
          ageSeconds: 3_600,
          connectedWebSockets: 1,
          bridgePid: null,
          cleanupEligible: false,
          lifecycleError: null,
        },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.memory)).toBe(true);
    expect(Object.isFrozen(snapshot.cleanup)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions)).toBe(true);
    expect(Object.isFrozen(snapshot.sessions[0])).toBe(true);
    expect(options.runtime.exists).toHaveBeenCalledTimes(2);
    expect(options.eligibility.read).toHaveBeenCalledWith({
      id: TAB_A,
      thresholdMs: 3_600_000,
      cutoffMs: NOW - 3_600_000,
    });
  });

  it('caps rows at the configured maximum and probes with bounded concurrency', async () => {
    const ids = Array.from(
      { length: 21 },
      (_, index) =>
        `${index.toString(16).padStart(8, '0')}-e29b-41d4-a716-446655440000`,
    );
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const options = dependencies({
      maxSessions: 20,
      tabs: ids
        .map((id, position) => tab(id, position, `Tab ${position}`))
        .reverse(),
    });
    options.runtime.exists.mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return true;
    });
    const service = new AdminService({ ...options, probeConcurrency: 3 });

    const pending = service.snapshot();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await vi.waitFor(() => {
      while (releases.length > 0) releases.shift()?.();
      expect(options.runtime.exists).toHaveBeenCalledTimes(20);
    });
    const snapshot = await pending;

    expect(snapshot.sessions).toHaveLength(20);
    expect(snapshot.sessions.map((row) => row.displayName)).toEqual(
      ids.slice(0, 20).map((_id, index) => `Tab ${index}`),
    );
    expect(maximumActive).toBe(3);
  });

  it('degrades failed probes and unsafe metrics without exposing raw dependency data', async () => {
    const options = dependencies({
      now: () => Number.NaN,
      uptime: () => Number.POSITIVE_INFINITY,
      memoryUsage: () => ({ rss: -1, heapUsed: Number.NaN }),
    });
    options.runtime.exists.mockRejectedValue(
      new Error('tmux output: secret-session-name'),
    );
    options.eligibility.read.mockRejectedValue(
      new Error('cleanup environment HOME=/private'),
    );
    options.bridges.entries.mockReturnValue(
      Object.freeze([
        Object.freeze({ sessionId: TAB_A, pid: Number.NaN, attached: true }),
      ]),
    );
    options.cleanup.status.mockReturnValue({
      enabled: true,
      running: false,
      lastRunAt: null,
      dependencyFailure: 'settings_unavailable',
      rawError: 'private cleanup failure',
    } as never);

    const snapshot = await new AdminService(options).snapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.generatedAt).toBe('1970-01-01T00:00:00.000Z');
    expect(snapshot.uptimeSeconds).toBe(0);
    expect(snapshot.memory).toEqual({ rss: 0, heapUsed: 0 });
    expect(snapshot.sessions[0]).toMatchObject({
      observedState: 'unknown',
      ageSeconds: 0,
      bridgePid: null,
      cleanupEligible: false,
      lifecycleError: 'session_status_unavailable',
    });
    expect(serialized).not.toMatch(
      /secret-session|HOME|private cleanup|dependencyFailure|rawError|owner|authority|environment|command|stdout|stderr/i,
    );
    expect(serialized).not.toContain('"socket"');
  });

  it('retains only bounded lifecycle codes for current rows and clears on success', async () => {
    const options = dependencies();
    const service = new AdminService(options);

    service.recordLifecycleError(TAB_A, 'operation_failed');
    service.recordLifecycleError(TAB_B, 'raw terminal output' as never);
    expect((await service.snapshot()).sessions).toEqual([
      expect.objectContaining({
        id: TAB_A,
        lifecycleError: 'operation_failed',
      }),
      expect.objectContaining({ id: TAB_B, lifecycleError: null }),
    ]);

    service.clearLifecycleError(TAB_A);
    expect((await service.snapshot()).sessions[0]?.lifecycleError).toBeNull();

    for (let index = 0; index < 100; index += 1) {
      service.recordLifecycleError(
        `${index.toString(16).padStart(8, '0')}-e29b-41d4-a716-446655440000`,
        'operation_failed',
      );
    }
    expect(service.lifecycleErrorCount()).toBeLessThanOrEqual(2);
  });

  it('maps only strict public cleanup scheduler state', async () => {
    const options = dependencies();
    options.cleanup.status.mockReturnValue({
      enabled: true,
      running: true,
      lastRunAt: '2026-07-12T17:55:00.000Z',
      dependencyFailure: 'tabs_unavailable',
    });

    const snapshot = await new AdminService(options).snapshot();

    expect(snapshot.cleanup).toEqual({
      enabled: true,
      running: true,
      lastRunAt: '2026-07-12T17:55:00.000Z',
    });
    expect(Object.keys(snapshot.cleanup)).toEqual([
      'enabled',
      'running',
      'lastRunAt',
    ]);
  });
});

function dependencies(
  overrides: Partial<
    Pick<AdminServiceOptions, 'maxSessions' | 'now' | 'uptime' | 'memoryUsage'>
  > & { tabs?: ReturnType<typeof tab>[] } = {},
) {
  const records = overrides.tabs ?? [
    tab(TAB_B, 1, 'Second', 'stopped'),
    tab(TAB_A, 0, 'First', 'active'),
  ];
  const runtime = {
    exists: vi.fn(async (id: string) => id === TAB_A),
  };
  const eligibility = {
    read: vi.fn(async (request): Promise<EligibilitySnapshot> =>
      Object.freeze({
        id: request.id,
        thresholdMs: request.thresholdMs,
        cutoffMs: request.cutoffMs,
        eligible: request.id === TAB_A,
        reason: request.id === TAB_A ? null : 'inactive',
        generation: Object.freeze({ structure: 1, activity: 1, sockets: 1 }),
      }),
    ),
  };
  return {
    tabs: { snapshot: vi.fn(() => ({ structureRevision: 1, tabs: records })) },
    runtime,
    bridges: {
      entries: vi.fn<AdminServiceOptions['bridges']['entries']>(() =>
        Object.freeze([
          Object.freeze({ sessionId: TAB_A, pid: 4321, attached: true }),
        ]),
      ),
    },
    sockets: {
      entries: vi.fn<AdminServiceOptions['sockets']['entries']>(() =>
        Object.freeze([
          Object.freeze({ terminalTabId: TAB_A, count: 2 }),
          Object.freeze({ terminalTabId: TAB_B, count: 1 }),
        ]),
      ),
    },
    eligibility,
    cleanupSettings: {
      snapshot: vi.fn(() => ({ staleSessionCleanupHours: 1 })),
    },
    cleanup: {
      status: vi.fn<AdminServiceOptions['cleanup']['status']>(() => ({
        enabled: true,
        running: false,
        lastRunAt: null,
        dependencyFailure: null,
      })),
    },
    maxSessions: overrides.maxSessions ?? 2,
    now: overrides.now ?? (() => NOW),
    uptime: overrides.uptime ?? (() => 7_200.5),
    memoryUsage:
      overrides.memoryUsage ??
      (() => ({ rss: 100_000_000, heapUsed: 25_000_000 })),
  } satisfies AdminServiceOptions;
}

function tab(
  id: string,
  position: number,
  displayName: string,
  desiredState: 'active' | 'stopped' = 'active',
) {
  return {
    id,
    displayName,
    position,
    createdAt:
      id === TAB_A ? '2026-07-12T16:00:00.000Z' : '2026-07-12T17:00:00.000Z',
    lastActivityAt:
      id === TAB_A ? '2026-07-12T17:00:00.000Z' : '2026-07-12T17:30:00.000Z',
    desiredState,
  } as const;
}
