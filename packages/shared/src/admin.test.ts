import { describe, expect, it } from 'vitest';

import {
  parseAdminActionRequest,
  parseAdminSnapshot,
  parseCleanupResult,
  apiErrorCodeSchema,
} from './index.js';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const NOW = '2026-07-12T18:00:00.000Z';
const row = {
  id: ID,
  displayName: 'Terminal 1',
  tmuxSessionName: `webterm-${ID}`,
  desiredState: 'active',
  observedState: 'running',
  createdAt: '2026-07-12T17:00:00.000Z',
  lastActivityAt: '2026-07-12T17:59:00.000Z',
  ageSeconds: 3_600,
  connectedWebSockets: 1,
  bridgePid: 1234,
  cleanupEligible: false,
  lifecycleError: null,
};
const snapshot = {
  generatedAt: NOW,
  uptimeSeconds: 7_200,
  memory: { rss: 100_000_000, heapUsed: 25_000_000 },
  totals: { tabs: 1, runningSessions: 1, bridges: 1, webSockets: 1 },
  cleanup: { enabled: true, running: false, lastRunAt: null },
  sessions: [row],
};

describe('administration contracts', () => {
  it('parses and deeply freezes a strict bounded snapshot', () => {
    const parsed = parseAdminSnapshot(snapshot);

    expect(parsed).toEqual(snapshot);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.memory)).toBe(true);
    expect(Object.isFrozen(parsed.sessions)).toBe(true);
    expect(Object.isFrozen(parsed.sessions[0])).toBe(true);
  });

  it.each([
    'restart_bridge',
    'terminate',
    'recreate',
    'restart_session',
  ] as const)('parses admin action %s', (action) => {
    expect(parseAdminActionRequest({ action })).toEqual({ action });
  });

  it('rejects unknown action request fields', () => {
    expect(() =>
      parseAdminActionRequest({ action: 'terminate', force: true }),
    ).toThrow();
    expect(() => parseAdminActionRequest({ action: 'delete' })).toThrow();
  });

  it.each([
    { ...snapshot, generatedAt: 'yesterday' },
    { ...snapshot, unknown: true },
    { ...snapshot, memory: { ...snapshot.memory, rss: -1 } },
    { ...snapshot, totals: { ...snapshot.totals, tabs: 1.5 } },
    { ...snapshot, sessions: [{ ...row, id: 'not-a-uuid' }] },
    { ...snapshot, sessions: [{ ...row, observedState: 'starting' }] },
    { ...snapshot, sessions: [{ ...row, connectedWebSockets: -1 }] },
    { ...snapshot, sessions: [{ ...row, bridgePid: 1.5 }] },
    { ...snapshot, sessions: [{ ...row, lifecycleError: 'x'.repeat(129) }] },
  ])('rejects malformed snapshot %#', (value) => {
    expect(() => parseAdminSnapshot(value)).toThrow();
  });

  it('bounds snapshot row count to the supported session maximum', () => {
    expect(() =>
      parseAdminSnapshot({
        ...snapshot,
        sessions: Array.from({ length: 21 }, (_, index) => ({
          ...row,
          id: `${index.toString(16).padStart(8, '0')}-e29b-41d4-a716-446655440000`,
        })),
      }),
    ).toThrow();
  });

  it('preserves the existing tab display policy and normalizes display values', () => {
    expect(
      parseAdminSnapshot({
        ...snapshot,
        sessions: [
          {
            ...row,
            displayName: '\ud83d\ude80'.repeat(80),
            lifecycleError: 'Cafe\u0301',
          },
        ],
      }).sessions[0]?.displayName,
    ).toBe('\ud83d\ude80'.repeat(80));
    expect(
      parseAdminSnapshot({
        ...snapshot,
        sessions: [
          { ...row, displayName: 'Developer \ud83d\udc69\u200d\ud83d\udcbb' },
        ],
      }).sessions[0]?.displayName,
    ).toBe('Developer \ud83d\udc69\u200d\ud83d\udcbb');
    expect(
      parseAdminSnapshot({
        ...snapshot,
        sessions: [{ ...row, lifecycleError: 'Cafe\u0301' }],
      }).sessions[0]?.lifecycleError,
    ).toBe('Caf\u00e9');
    expect(() =>
      parseAdminSnapshot({
        ...snapshot,
        sessions: [{ ...row, displayName: '\ud83d\ude80'.repeat(81) }],
      }),
    ).toThrow();
  });

  it.each(['line\nfeed', 'override\u202ename', 'zero-width\u200bname'])(
    'rejects misleading control or format characters in admin value %j',
    (value) => {
      expect(() =>
        parseAdminSnapshot({
          ...snapshot,
          sessions: [{ ...row, lifecycleError: value }],
        }),
      ).toThrow();
      expect(() =>
        parseAdminSnapshot({
          ...snapshot,
          sessions: [{ ...row, displayName: value }],
        }),
      ).toThrow();
    },
  );

  it('parses and freezes a strict cleanup result', () => {
    const result = {
      disabled: false,
      examined: 4,
      terminated: 1,
      skipped: 2,
      failed: 1,
      startedAt: '2026-07-12T18:00:00.000Z',
      finishedAt: '2026-07-12T18:00:01.000Z',
    };
    const parsed = parseCleanupResult(result);

    expect(parsed).toEqual(result);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseCleanupResult({ ...result, examined: -1 })).toThrow();
    expect(() =>
      parseCleanupResult({ ...result, terminalOutput: 'secret' }),
    ).toThrow();
  });

  it.each([
    'invalid_request',
    'origin_forbidden',
    'tab_not_found',
    'session_limit',
    'order_conflict',
    'invalid_session_state',
    'json_required',
    'operation_failed',
    'authentication_required',
    'authentication_failed',
    'csrf_invalid',
    'rate_limited',
    'password_invalid',
    'setup_required',
    'setup_already_completed',
    'settings_invalid',
    'durability_uncertain',
    'cleanup_disabled',
  ])('accepts stable API error code %s', (code) => {
    expect(apiErrorCodeSchema.parse(code)).toBe(code);
  });
});
