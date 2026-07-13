import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATION_REQUIRED,
  AUTHENTICATION_REQUIRED_REASON,
  BRIDGE_RESTART,
  SESSION_REPLACED,
  SESSION_RESTARTING,
  SESSION_STOPPED,
  apiErrorResponseSchema,
  createTabBodySchema,
  displayNameSchema,
  persistedTabsDocumentSchema,
  renameTabBodySchema,
  reorderTabsBodySchema,
  sessionHealthSchema,
  tabCollectionResponseSchema,
  tabIdSchema,
  tabRecordSchema,
  tabViewSchema,
  type DesiredState,
  type SessionState,
  type TabRecord,
} from './tabs.js';

const TAB_ID = '550e8400-e29b-41d4-a716-446655440000';
const SECOND_TAB_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

const record: TabRecord = {
  id: TAB_ID,
  displayName: 'Terminal 1',
  position: 0,
  createdAt: '2026-07-11T12:00:00.000Z',
  lastActivityAt: '2026-07-11T12:01:00.000Z',
  desiredState: 'active',
};

describe('tab identity', () => {
  it('keeps authentication and terminal lifecycle close codes distinct', () => {
    expect([
      SESSION_REPLACED,
      AUTHENTICATION_REQUIRED,
      BRIDGE_RESTART,
      SESSION_STOPPED,
      SESSION_RESTARTING,
    ]).toEqual([4001, 4003, 4010, 4011, 4012]);
    expect(AUTHENTICATION_REQUIRED_REASON).toBe('authentication_required');
  });

  it.each([
    TAB_ID,
    SECOND_TAB_ID,
    '01890f3e-7b5a-7cc1-98c4-dc0c0c07398f',
    'ffffffff-ffff-8fff-bfff-ffffffffffff',
  ])('accepts canonical lowercase UUID %s', (id) => {
    expect(tabIdSchema.parse(id)).toBe(id);
  });

  it.each([
    '550E8400-E29B-41D4-A716-446655440000',
    '550e8400-E29b-41d4-a716-446655440000',
    '550e8400-e29b-01d4-a716-446655440000',
    '550e8400-e29b-91d4-a716-446655440000',
    '550e8400-e29b-41d4-7716-446655440000',
    '550e8400-e29b-41d4-c716-446655440000',
    '00000000-0000-0000-0000-000000000000',
    '../550e8400-e29b-41d4-a716-446655440000',
    '550e8400/e29b/41d4/a716/446655440000',
    '550e8400\\e29b\\41d4\\a716\\446655440000',
    '%35%35%30e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000%2f..',
    '550e8400e29b41d4a716446655440000',
    'not-a-uuid',
  ])('rejects non-canonical or unsafe tab ID %s', (id) => {
    expect(tabIdSchema.safeParse(id).success).toBe(false);
  });
});

describe('tab display names', () => {
  it('trims and NFC-normalizes names', () => {
    expect(displayNameSchema.parse('  Cafe\u0301  ')).toBe('Caf\u00e9');
  });

  it('bounds names by both Unicode code points and UTF-8 bytes', () => {
    expect(displayNameSchema.parse('a'.repeat(80))).toBe('a'.repeat(80));
    expect(displayNameSchema.parse('\ud83d\ude80'.repeat(32))).toBe(
      '\ud83d\ude80'.repeat(32),
    );
    expect(displayNameSchema.safeParse('\ud83d\ude80'.repeat(33)).success).toBe(
      false,
    );
  });

  it.each(['', '   ', 'a'.repeat(81)])(
    'rejects names outside 1-80 code points or 128 UTF-8 bytes',
    (name) => {
      expect(displayNameSchema.safeParse(name).success).toBe(false);
    },
  );

  it.each([
    'line\nfeed',
    '\ntrimmed-newline\n',
    'tab\tname',
    '\ttrimmed-tab\t',
    'control\u0000name',
    'next\u0085line',
    'line\u2028separator',
    '\u2028trimmed-separator\u2029',
    'paragraph\u2029separator',
    'override\u202ename',
    'embedding\u202aname',
    'isolate\u2066name',
    'pop-isolate\u2069name',
    'arabic-mark\u061cname',
    'left-to-right-mark\u200ename',
    'right-to-left-mark\u200fname',
    'deprecated-bidi\u206aname',
    'deprecated-bidi\u206fname',
    'zero-width\u200bname',
  ])('rejects forbidden formatting character in %j', (name) => {
    expect(displayNameSchema.safeParse(name).success).toBe(false);
  });

  it('rejects lone UTF-16 surrogates but accepts valid surrogate pairs', () => {
    expect(displayNameSchema.safeParse('high-\ud800-surrogate').success).toBe(
      false,
    );
    expect(displayNameSchema.safeParse('low-\udfff-surrogate').success).toBe(
      false,
    );
    expect(displayNameSchema.parse('valid-\ud83d\ude80-pair')).toBe(
      'valid-\ud83d\ude80-pair',
    );
  });

  it('preserves legitimate ZWJ emoji and ZWNJ orthography', () => {
    expect(
      displayNameSchema.parse('Developer \ud83d\udc69\u200d\ud83d\udcbb'),
    ).toBe('Developer \ud83d\udc69\u200d\ud83d\udcbb');
    expect(
      displayNameSchema.parse(
        '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645',
      ),
    ).toBe('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645');
  });
});

describe('tab records and views', () => {
  it('parses desired and session states through strict records and views', () => {
    const desiredStates: DesiredState[] = ['active', 'stopped'];
    const sessionStates: SessionState[] = ['running', 'stopped', 'unknown'];

    for (const desiredState of desiredStates) {
      expect(
        tabRecordSchema.parse({ ...record, desiredState }).desiredState,
      ).toBe(desiredState);
    }
    for (const state of sessionStates) {
      const session = { state, attached: state === 'running', bridgePid: null };
      expect(tabViewSchema.parse({ ...record, session }).session).toEqual(
        session,
      );
    }
  });

  it('validates positions, UTC timestamps, health PIDs, and unknown fields', () => {
    expect(tabRecordSchema.safeParse({ ...record, position: -1 }).success).toBe(
      false,
    );
    expect(
      tabRecordSchema.safeParse({ ...record, position: 0.5 }).success,
    ).toBe(false);
    expect(
      tabRecordSchema.safeParse({
        ...record,
        createdAt: '2026-07-11T06:00:00-06:00',
      }).success,
    ).toBe(false);
    expect(
      tabRecordSchema.safeParse({ ...record, private: true }).success,
    ).toBe(false);
    expect(
      sessionHealthSchema.safeParse({
        state: 'running',
        attached: true,
        bridgePid: 1234,
      }).success,
    ).toBe(true);
    expect(
      sessionHealthSchema.safeParse({
        state: 'running',
        attached: true,
        bridgePid: 1.5,
      }).success,
    ).toBe(false);
    expect(
      sessionHealthSchema.safeParse({
        state: 'running',
        attached: true,
        bridgePid: null,
        output: 'secret',
      }).success,
    ).toBe(false);
  });

  it('parses strict persisted documents and collection responses', () => {
    const document = { formatVersion: 1, structureRevision: 0, tabs: [record] };
    expect(persistedTabsDocumentSchema.parse(document)).toEqual(document);
    expect(
      persistedTabsDocumentSchema.safeParse({ ...document, formatVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      persistedTabsDocumentSchema.safeParse({
        ...document,
        structureRevision: -1,
      }).success,
    ).toBe(false);
    expect(
      persistedTabsDocumentSchema.safeParse({ ...document, unknown: true })
        .success,
    ).toBe(false);

    const response = {
      structureRevision: 7,
      tabs: [
        {
          ...record,
          session: { state: 'running', attached: true, bridgePid: 1234 },
        },
      ],
    };
    expect(tabCollectionResponseSchema.parse(response)).toEqual(response);
    expect(
      tabCollectionResponseSchema.safeParse({ ...response, formatVersion: 1 })
        .success,
    ).toBe(false);
  });

  it('loads a legacy Phase 2 name while keeping IDs and positions unchanged', () => {
    const legacyName = '\ud83d\ude80'.repeat(80);
    const document = {
      formatVersion: 1,
      structureRevision: 9,
      tabs: [{ ...record, displayName: legacyName }],
    };

    expect(persistedTabsDocumentSchema.parse(document)).toEqual(document);
  });

  it.each([
    ['duplicate ID', [record, { ...record, position: 1 }]],
    ['duplicate position', [record, { ...record, id: SECOND_TAB_ID }]],
    ['position gap', [record, { ...record, id: SECOND_TAB_ID, position: 2 }]],
    ['out-of-range position', [{ ...record, position: 1 }]],
    [
      'records out of position order',
      [
        { ...record, position: 1 },
        { ...record, id: SECOND_TAB_ID, position: 0 },
      ],
    ],
  ])('rejects persisted documents with %s', (_reason, tabs) => {
    expect(
      persistedTabsDocumentSchema.safeParse({
        formatVersion: 1,
        structureRevision: 2,
        tabs,
      }).success,
    ).toBe(false);
  });
});

describe('tab API contracts', () => {
  it('parses and normalizes strict create and rename bodies', () => {
    expect(createTabBodySchema.parse({})).toEqual({});
    expect(
      createTabBodySchema.parse({ displayName: '  Cafe\u0301  ' }),
    ).toEqual({
      displayName: 'Caf\u00e9',
    });
    expect(renameTabBodySchema.parse({ displayName: '  Work  ' })).toEqual({
      displayName: 'Work',
    });
    expect(
      createTabBodySchema.safeParse({ displayName: 'Tab', extra: true })
        .success,
    ).toBe(false);
    expect(renameTabBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects legacy over-byte-limit names for new create and rename inputs', () => {
    const legacyName = '\ud83d\ude80'.repeat(80);

    expect(
      createTabBodySchema.safeParse({ displayName: legacyName }).success,
    ).toBe(false);
    expect(
      renameTabBodySchema.safeParse({ displayName: legacyName }).success,
    ).toBe(false);
  });

  it('requires a strict nonnegative revision and canonical IDs for reorder', () => {
    const body = { structureRevision: 3, ids: [TAB_ID, SECOND_TAB_ID] };
    expect(reorderTabsBodySchema.parse(body)).toEqual(body);
    expect(
      reorderTabsBodySchema.safeParse({ ...body, structureRevision: -1 })
        .success,
    ).toBe(false);
    expect(
      reorderTabsBodySchema.safeParse({ ...body, ids: ['../tab'] }).success,
    ).toBe(false);
    expect(
      reorderTabsBodySchema.safeParse({ ...body, extra: true }).success,
    ).toBe(false);
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
  ])('parses stable API error code %s', (error) => {
    expect(apiErrorResponseSchema.parse({ error })).toEqual({ error });
  });

  it('rejects unstable or detailed API errors', () => {
    expect(
      apiErrorResponseSchema.safeParse({ error: 'internal_error' }).success,
    ).toBe(false);
    expect(
      apiErrorResponseSchema.safeParse({
        error: 'operation_failed',
        detail: '/private',
      }).success,
    ).toBe(false);
  });

  it('exports stable application WebSocket close codes', () => {
    expect(SESSION_REPLACED).toBe(4001);
    expect(BRIDGE_RESTART).toBe(4010);
    expect(SESSION_STOPPED).toBe(4011);
    expect(SESSION_RESTARTING).toBe(4012);
  });
});
