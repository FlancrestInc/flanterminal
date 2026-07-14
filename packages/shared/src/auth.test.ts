import { describe, expect, it } from 'vitest';

import {
  parseAuthBootstrap,
  parseLoginRequest,
  parsePasswordChangeRequest,
  parseSetupRequest,
  setupRequestSchema,
} from './index.js';

describe('authentication contracts', () => {
  it.each(['local', 'cloudflare-access', 'trusted-header'] as const)(
    'parses strict unauthenticated %s bootstrap',
    (mode) => {
      expect(parseAuthBootstrap({ authenticated: false, mode })).toEqual({
        authenticated: false,
        mode,
      });
    },
  );

  it('parses and freezes the exact local setup bootstrap', () => {
    const parsed = parseAuthBootstrap({
      authenticated: false,
      mode: 'local',
      setupRequired: true,
      username: 'webterm',
    });

    expect(parsed).toEqual({
      authenticated: false,
      mode: 'local',
      setupRequired: true,
      username: 'webterm',
    });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('normalizes safe configured usernames in setup bootstraps', () => {
    expect(
      parseAuthBootstrap({
        authenticated: false,
        mode: 'local',
        setupRequired: true,
        username: 'Cafe\u0301',
      }),
    ).toEqual({
      authenticated: false,
      mode: 'local',
      setupRequired: true,
      username: 'Caf\u00e9',
    });
  });

  it.each([
    {
      authenticated: false,
      mode: 'local',
      setupRequired: true,
      username: 'webterm',
      csrfToken: 'leak',
    },
    {
      authenticated: false,
      mode: 'cloudflare-access',
      setupRequired: true,
      username: 'webterm',
    },
    {
      authenticated: false,
      mode: 'trusted-header',
      setupRequired: true,
      username: 'webterm',
    },
    {
      authenticated: false,
      mode: 'local',
      setupRequired: false,
    },
    {
      authenticated: false,
      mode: 'local',
      username: 'webterm',
    },
    {
      authenticated: false,
      mode: 'local',
      setupRequired: true,
      username: 'line\nfeed',
    },
    {
      authenticated: false,
      mode: 'local',
      setupRequired: true,
      username: 'a'.repeat(129),
    },
  ])('rejects malformed setup bootstrap %#', (value) => {
    expect(() => parseAuthBootstrap(value)).toThrow();
  });

  it.each(['local', 'cloudflare-access', 'trusted-header', 'none'] as const)(
    'parses and freezes authenticated %s bootstrap',
    (mode) => {
      const parsed = parseAuthBootstrap({
        authenticated: true,
        mode,
        identityLabel: 'operator',
        csrfToken: 'csrf-token',
        ...(mode === 'cloudflare-access'
          ? { upstreamExpiresAt: '2026-07-12T18:00:00.000Z' }
          : {}),
      });

      expect(parsed.authenticated).toBe(true);
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );

  it('bounds identity labels to 128 UTF-8 bytes', () => {
    const parsed = parseAuthBootstrap({
      authenticated: true,
      mode: 'local',
      identityLabel: '\ud83d\ude80'.repeat(32),
      csrfToken: 'csrf-token',
    });
    if (!parsed.authenticated) throw new Error('expected authenticated result');
    expect(parsed.identityLabel).toBe('\ud83d\ude80'.repeat(32));
    expect(() =>
      parseAuthBootstrap({
        authenticated: true,
        mode: 'local',
        identityLabel: '\ud83d\ude80'.repeat(33),
        csrfToken: 'csrf-token',
      }),
    ).toThrow();
  });

  it('NFC-normalizes safe identity and username display values', () => {
    const bootstrap = parseAuthBootstrap({
      authenticated: true,
      mode: 'local',
      identityLabel: 'Cafe\u0301',
      csrfToken: 'csrf-token',
    });
    if (!bootstrap.authenticated)
      throw new Error('expected authenticated result');

    expect(bootstrap.identityLabel).toBe('Caf\u00e9');
    expect(
      parseLoginRequest({ username: 'Cafe\u0301', password: 'secret' })
        .username,
    ).toBe('Caf\u00e9');
  });

  it.each(['line\nfeed', 'override\u202ename', 'zero-width\u200bname'])(
    'rejects control and format characters in identity display value %j',
    (identityLabel) => {
      expect(() =>
        parseAuthBootstrap({
          authenticated: true,
          mode: 'local',
          identityLabel,
          csrfToken: 'csrf-token',
        }),
      ).toThrow();
      expect(() =>
        parseLoginRequest({ username: identityLabel, password: 'secret' }),
      ).toThrow();
    },
  );

  it.each([
    { authenticated: false, mode: 'none' },
    { authenticated: false, mode: 'local', csrfToken: 'leak' },
    {
      authenticated: true,
      mode: 'local',
      identityLabel: 'operator',
      csrfToken: 'csrf-token',
      sessionToken: 'leak',
    },
    {
      authenticated: true,
      mode: 'cloudflare-access',
      identityLabel: 'operator',
      csrfToken: 'csrf-token',
      upstreamExpiresAt: 'not-a-time',
    },
  ])('rejects malformed or unsafe bootstrap %#', (value) => {
    expect(() => parseAuthBootstrap(value)).toThrow();
  });

  it('parses strict frozen login requests with bounded identities', () => {
    const parsed = parseLoginRequest({
      username: 'operator',
      password: 'secret',
    });
    expect(parsed).toEqual({ username: 'operator', password: 'secret' });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() =>
      parseLoginRequest({
        username: 'operator',
        password: 'secret',
        otp: '123',
      }),
    ).toThrow();
    expect(() =>
      parseLoginRequest({
        username: '\ud83d\ude80'.repeat(33),
        password: 'secret',
      }),
    ).toThrow();
  });

  it('parses exact password-change requests and rejects secret extras', () => {
    const parsed = parsePasswordChangeRequest({
      currentPassword: 'old secret',
      newPassword: 'new secret',
    });
    expect(parsed).toEqual({
      currentPassword: 'old secret',
      newPassword: 'new secret',
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() =>
      parsePasswordChangeRequest({
        currentPassword: 'old',
        newPassword: 'new',
        hash: 'leak',
      }),
    ).toThrow();
  });

  it.each([
    'a'.repeat(12),
    'a'.repeat(72),
    '\ud83d\ude80'.repeat(3),
    '\ud83d\ude80'.repeat(18),
  ])('accepts a NUL-free setup password at a UTF-8 boundary', (password) => {
    expect(setupRequestSchema.parse({ password })).toEqual({ password });
  });

  it.each([
    'a'.repeat(11),
    'a'.repeat(73),
    `${'\ud83d\ude80'.repeat(2)}abc`,
    `${'\ud83d\ude80'.repeat(18)}a`,
    `valid-password\0`,
  ])('rejects an invalid setup password', (password) => {
    expect(() => parseSetupRequest({ password })).toThrow();
  });

  it('parses and freezes exact setup requests', () => {
    const parsed = parseSetupRequest({ password: 'valid-password' });

    expect(parsed).toEqual({ password: 'valid-password' });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() =>
      parseSetupRequest({ password: 'valid-password', hash: 'leak' }),
    ).toThrow();
  });
});
