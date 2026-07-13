import { describe, expect, it } from 'vitest';

import {
  MAX_FONT_SIZE,
  MAX_SCROLLBACK,
  MIN_FONT_SIZE,
  MIN_SCROLLBACK,
  parseClientConfig,
} from './client-config.js';

const validConfig = {
  basePath: '/terminal/',
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
    expect(() =>
      parseClientConfig({ ...validConfig, resizeDebounceMs: 100.5 }),
    ).toThrow();
  });

  it('retains the Phase 2 preference bounds until the atomic client migration', () => {
    expect({
      MIN_FONT_SIZE,
      MAX_FONT_SIZE,
      MIN_SCROLLBACK,
      MAX_SCROLLBACK,
    }).toEqual({
      MIN_FONT_SIZE: 8,
      MAX_FONT_SIZE: 32,
      MIN_SCROLLBACK: 0,
      MAX_SCROLLBACK: 100_000,
    });
  });

  it.each(['theme', 'defaultShell', 'homeDir', 'logLevel', 'unknown'])(
    'rejects authenticated preference, server-only, or unknown key %s',
    (key) => {
      expect(() =>
        parseClientConfig({ ...validConfig, [key]: 'private' }),
      ).toThrow();
    },
  );
});
