import { describe, expect, it } from 'vitest';

import { FIXED_SESSION_ID } from './protocol.js';
import { parseClientConfig } from './client-config.js';

const validConfig = {
  basePath: '/terminal/',
  sessionId: FIXED_SESSION_ID,
  fontSize: 14,
  scrollback: 10_000,
  resizeDebounceMs: 100,
  reconnectMaxSeconds: 15,
};

describe('parseClientConfig', () => {
  it('returns only the approved normalized client fields', () => {
    expect(parseClientConfig(validConfig)).toEqual({
      ...validConfig,
      basePath: '/terminal',
    });
    expect(parseClientConfig({ ...validConfig, basePath: '/' }).basePath).toBe(
      '/',
    );
  });

  it.each([
    'terminal',
    '//terminal',
    '/terminal//nested',
    '/terminal/../admin',
    '/terminal?x=1',
  ])('rejects an invalid base path: %s', (basePath) => {
    expect(() => parseClientConfig({ ...validConfig, basePath })).toThrow();
  });

  it('requires the fixed session id', () => {
    expect(() =>
      parseClientConfig({ ...validConfig, sessionId: 'other' }),
    ).toThrow();
  });

  it.each([
    ['fontSize', 7],
    ['fontSize', 33],
    ['scrollback', -1],
    ['scrollback', 100_001],
    ['resizeDebounceMs', 24],
    ['resizeDebounceMs', 1_001],
    ['reconnectMaxSeconds', 0],
    ['reconnectMaxSeconds', 61],
  ] as const)('rejects %s outside its bounds', (field, value) => {
    expect(() =>
      parseClientConfig({ ...validConfig, [field]: value }),
    ).toThrow();
  });

  it('requires numeric settings to be integers', () => {
    expect(() =>
      parseClientConfig({ ...validConfig, fontSize: 14.5 }),
    ).toThrow();
  });

  it.each(['defaultShell', 'homeDir', 'logLevel', 'unknown'])(
    'rejects server-only or unknown key %s',
    (key) => {
      expect(() =>
        parseClientConfig({ ...validConfig, [key]: 'private' }),
      ).toThrow();
    },
  );
});
