import { describe, expect, it } from 'vitest';

import { parseClientConfig } from './client-config.js';

const validConfig = {
  basePath: '/terminal/',
  resizeDebounceMs: 100,
  reconnectMaxSeconds: 15,
};

describe('parseClientConfig', () => {
  it('returns only the approved normalized client fields', () => {
    expect(parseClientConfig(validConfig)).toEqual({
      ...validConfig,
      basePath: '/terminal',
    });
    expect(Object.isFrozen(parseClientConfig(validConfig))).toBe(true);
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

  it.each([
    '/terminal/./admin',
    '/terminal/%2e%2e/admin',
    '/terminal/%2Fadmin',
    '/terminal/%5cadmin',
    '/terminal/%zz/admin',
  ])('rejects ambiguous or encoded base path %s', (basePath) => {
    expect(() => parseClientConfig({ ...validConfig, basePath })).toThrow();
  });

  it('rejects the removed fixed session field', () => {
    expect(() =>
      parseClientConfig({
        ...validConfig,
        sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      }),
    ).toThrow();
  });

  it.each([
    ['resizeDebounceMs', 24],
    ['resizeDebounceMs', 1_001],
    ['reconnectMaxSeconds', 0],
    ['reconnectMaxSeconds', 61],
  ] as const)('rejects %s outside its bounds', (field, value) => {
    expect(() =>
      parseClientConfig({ ...validConfig, [field]: value }),
    ).toThrow();
  });

  it('requires transport settings to be integers', () => {
    expect(() =>
      parseClientConfig({ ...validConfig, resizeDebounceMs: 100.5 }),
    ).toThrow();
  });

  it.each([
    'fontSize',
    'scrollback',
    'theme',
    'defaultShell',
    'homeDir',
    'logLevel',
    'unknown',
  ])(
    'rejects authenticated preference, server-only, or unknown key %s',
    (key) => {
      expect(() =>
        parseClientConfig({ ...validConfig, [key]: 'private' }),
      ).toThrow();
    },
  );
});
