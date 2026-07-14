import { describe, expect, it } from 'vitest';
import proxyaddr from 'proxy-addr';

import { loadConfig, toClientConfig } from './config.js';

describe('loadConfig', () => {
  it('loads defaults from the supplied environment', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      port: 3000,
      bindHost: '0.0.0.0',
      basePath: '/',
      publicUrl: 'http://localhost:3000',
      publicOrigin: 'http://localhost:3000',
      publicHost: 'localhost:3000',
      defaultShell: '/bin/bash',
      defaultFontSize: 14,
      xtermScrollback: 10_000,
      tmuxHistoryLimit: 20_000,
      wsHeartbeatSeconds: 30,
      wsMaxBufferBytes: 1_048_576,
      resizeDebounceMs: 100,
      reconnectMaxSeconds: 15,
      logLevel: 'info',
      homeDir: '/home/webterm',
      dataDir: '/app/data',
      sessionMaxCount: 10,
      authMode: 'local',
      localAuthUsername: 'webterm',
      bcryptCost: 12,
      authIdleMinutes: 60,
      authAbsoluteHours: 24,
      authSessionMaxCount: 32,
      trustProxy: false,
      trustedAuthHeader: 'X-Auth-User',
      allowedShells: ['/bin/bash'],
      maxFontSize: 32,
      maxXtermScrollback: 100_000,
      maxTmuxHistoryLimit: 1_000_000,
      maxStaleSessionCleanupHours: 8_760,
      sessionCleanupIntervalMinutes: 15,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('uses only the supplied env object', () => {
    expect(loadConfig({}).port).toBe(3000);
    expect(loadConfig({ APP_PORT: '3456' }).port).toBe(3456);
  });

  it('ignores the obsolete local password-file environment variable', () => {
    const config = loadConfig({
      LOCAL_AUTH_PASSWORD_FILE: 'arbitrary obsolete value',
    });

    expect(config).toEqual(loadConfig({}));
    expect(config).not.toHaveProperty('localAuthPasswordFile');
  });

  it('merges defaults, config file, then environment and normalizes once', () => {
    const config = loadConfig(
      {
        APP_PORT: '5000',
        AUTH_MODE: 'none',
        ALLOWED_SHELLS: ' /bin/bash, /bin/fish ',
      },
      {
        port: 4000,
        authMode: 'trusted-header',
        trustProxy: ['10.0.0.0/8'],
        allowedShells: ['/bin/bash', '/bin/zsh'],
      },
    );

    expect(config).toMatchObject({
      port: 5000,
      authMode: 'none',
      trustProxy: ['10.0.0.0/8'],
      allowedShells: ['/bin/bash', '/bin/fish'],
    });
    expect(Object.isFrozen(config.trustProxy)).toBe(true);
    expect(Object.isFrozen(config.allowedShells)).toBe(true);
  });

  it('accepts every Phase 3 inclusive numeric boundary', () => {
    const minimum = loadConfig({
      BCRYPT_COST: '10',
      AUTH_IDLE_MINUTES: '5',
      AUTH_ABSOLUTE_HOURS: '1',
      AUTH_SESSION_MAX_COUNT: '1',
      MAX_FONT_SIZE: '8',
      MAX_XTERM_SCROLLBACK: '0',
      MAX_TMUX_HISTORY_LIMIT: '0',
      MAX_STALE_SESSION_CLEANUP_HOURS: '0',
      SESSION_CLEANUP_INTERVAL_MINUTES: '5',
    });
    const maximum = loadConfig({
      BCRYPT_COST: '15',
      AUTH_IDLE_MINUTES: '1440',
      AUTH_ABSOLUTE_HOURS: '168',
      AUTH_SESSION_MAX_COUNT: '256',
      MAX_FONT_SIZE: '32',
      MAX_XTERM_SCROLLBACK: '100000',
      MAX_TMUX_HISTORY_LIMIT: '1000000',
      MAX_STALE_SESSION_CLEANUP_HOURS: '8760',
      SESSION_CLEANUP_INTERVAL_MINUTES: '1440',
    });

    expect(minimum).toMatchObject({
      bcryptCost: 10,
      authIdleMinutes: 5,
      authAbsoluteHours: 1,
      authSessionMaxCount: 1,
      maxFontSize: 8,
      maxXtermScrollback: 0,
      maxTmuxHistoryLimit: 0,
      maxStaleSessionCleanupHours: 0,
      sessionCleanupIntervalMinutes: 5,
    });
    expect(maximum).toMatchObject({
      bcryptCost: 15,
      authIdleMinutes: 1_440,
      authAbsoluteHours: 168,
      authSessionMaxCount: 256,
      maxFontSize: 32,
      maxXtermScrollback: 100_000,
      maxTmuxHistoryLimit: 1_000_000,
      maxStaleSessionCleanupHours: 8_760,
      sessionCleanupIntervalMinutes: 1_440,
    });
  });

  it.each([
    ['BCRYPT_COST', '9'],
    ['BCRYPT_COST', '16'],
    ['AUTH_IDLE_MINUTES', '4'],
    ['AUTH_IDLE_MINUTES', '1441'],
    ['AUTH_ABSOLUTE_HOURS', '0'],
    ['AUTH_ABSOLUTE_HOURS', '169'],
    ['AUTH_SESSION_MAX_COUNT', '0'],
    ['AUTH_SESSION_MAX_COUNT', '257'],
    ['MAX_FONT_SIZE', '7'],
    ['MAX_FONT_SIZE', '33'],
    ['MAX_XTERM_SCROLLBACK', '-1'],
    ['MAX_XTERM_SCROLLBACK', '100001'],
    ['MAX_TMUX_HISTORY_LIMIT', '-1'],
    ['MAX_TMUX_HISTORY_LIMIT', '1000001'],
    ['MAX_STALE_SESSION_CLEANUP_HOURS', '-1'],
    ['MAX_STALE_SESSION_CLEANUP_HOURS', '8761'],
    ['SESSION_CLEANUP_INTERVAL_MINUTES', '4'],
    ['SESSION_CLEANUP_INTERVAL_MINUTES', '1441'],
  ])('rejects Phase 3 numeric bound %s=%s', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(
      'Invalid server configuration',
    );
  });

  it('validates mode-specific Cloudflare settings without requiring local credential access', () => {
    expect(() => loadConfig({ AUTH_MODE: 'cloudflare-access' })).toThrow(
      'Invalid server configuration',
    );
    expect(() =>
      loadConfig({
        AUTH_MODE: 'cloudflare-access',
        CLOUDFLARE_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/path',
        CLOUDFLARE_ACCESS_AUD: 'audience',
      }),
    ).toThrow('Invalid server configuration');

    const config = loadConfig({
      AUTH_MODE: 'cloudflare-access',
      CLOUDFLARE_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
      CLOUDFLARE_ACCESS_AUD: 'audience_123',
      LOCAL_AUTH_PASSWORD_FILE: '/does/not/need/to/exist',
    });
    expect(config).toMatchObject({
      authMode: 'cloudflare-access',
      cloudflareTeamDomain: 'https://team.cloudflareaccess.com',
      cloudflareAccessAud: 'audience_123',
    });

    for (const teamDomain of [
      'https://localhost',
      'https://127.0.0.1',
      'https://10.0.0.1',
      'https://[::1]',
      'https://example.com',
      'https://cloudflareaccess.com',
      'https://a.b.cloudflareaccess.com',
      'https://team.cloudflareaccess.com.evil.test',
      'https://-team.cloudflareaccess.com',
      'https://team-.cloudflareaccess.com',
      `https://${'a'.repeat(64)}.cloudflareaccess.com`,
    ]) {
      expect(() =>
        loadConfig({
          AUTH_MODE: 'cloudflare-access',
          CLOUDFLARE_TEAM_DOMAIN: teamDomain,
          CLOUDFLARE_ACCESS_AUD: 'audience',
        }),
      ).toThrow('Invalid server configuration');
    }
    expect(
      loadConfig({
        AUTH_MODE: 'cloudflare-access',
        CLOUDFLARE_TEAM_DOMAIN: 'https://my-team.cloudflareaccess.com',
        CLOUDFLARE_ACCESS_AUD: 'audience',
      }).cloudflareTeamDomain,
    ).toBe('https://my-team.cloudflareaccess.com');
  });

  it('bounds safe usernames and Cloudflare audience tokens', () => {
    expect(
      loadConfig({ LOCAL_AUTH_USERNAME: 'a'.repeat(64) }).localAuthUsername,
    ).toBe('a'.repeat(64));
    expect(() => loadConfig({ LOCAL_AUTH_USERNAME: '' })).toThrow();
    expect(() => loadConfig({ LOCAL_AUTH_USERNAME: 'a'.repeat(65) })).toThrow();
    expect(() => loadConfig({ LOCAL_AUTH_USERNAME: 'unsafe name' })).toThrow();

    const cloudflare = {
      AUTH_MODE: 'cloudflare-access',
      CLOUDFLARE_TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
    } as const;
    expect(
      loadConfig({ ...cloudflare, CLOUDFLARE_ACCESS_AUD: 'a'.repeat(256) })
        .cloudflareAccessAud,
    ).toBe('a'.repeat(256));
    expect(() =>
      loadConfig({ ...cloudflare, CLOUDFLARE_ACCESS_AUD: 'a'.repeat(257) }),
    ).toThrow();
    expect(() =>
      loadConfig({ ...cloudflare, CLOUDFLARE_ACCESS_AUD: 'unsafe audience' }),
    ).toThrow();
  });

  it('rejects invalid modes and HTTP header names', () => {
    expect(() => loadConfig({ AUTH_MODE: 'oauth' })).toThrow();
    expect(() => loadConfig({ TRUSTED_AUTH_HEADER: 'X Auth User' })).toThrow();
    expect(
      loadConfig({ TRUSTED_AUTH_HEADER: 'X_Auth-User' }).trustedAuthHeader,
    ).toBe('X_Auth-User');
  });

  it('requires explicit proxy ranges for trusted-header mode', () => {
    expect(() => loadConfig({ AUTH_MODE: 'trusted-header' })).toThrow(
      'Invalid server configuration',
    );
    expect(() =>
      loadConfig({
        AUTH_MODE: 'trusted-header',
        TRUST_PROXY: '2',
        TRUSTED_AUTH_HEADER: 'X-Forwarded-User',
      }),
    ).toThrow('Invalid server configuration');
    expect(
      loadConfig({
        AUTH_MODE: 'trusted-header',
        TRUST_PROXY: '10.0.0.0/8',
        TRUSTED_AUTH_HEADER: 'X-Forwarded-User',
      }),
    ).toMatchObject({
      authMode: 'trusted-header',
      trustProxy: ['10.0.0.0/8'],
      trustedAuthHeader: 'X-Forwarded-User',
    });
    expect(
      loadConfig({ AUTH_MODE: 'local', TRUST_PROXY: '2' }).trustProxy,
    ).toBe(2);
    expect(
      loadConfig({ AUTH_MODE: 'none', TRUST_PROXY: 'false' }).trustProxy,
    ).toBe(false);
  });

  it('normalizes and validates proxy CIDRs, shells, and environment-only paths', () => {
    const config = loadConfig({
      APP_CONFIG_FILE: '/etc/flanterminal.json',
      TRUST_PROXY: ' 10.0.0.0/8,2001:DB8::/32 ',
      DEFAULT_SHELL: '/bin/zsh',
      ALLOWED_SHELLS: ' /bin/bash,/bin/zsh ',
    });

    expect(config).toMatchObject({
      appConfigFile: '/etc/flanterminal.json',
      trustProxy: ['10.0.0.0/8', '2001:db8::/32'],
      allowedShells: ['/bin/bash', '/bin/zsh'],
    });
    expect(() => loadConfig({ APP_CONFIG_FILE: 'config.json' })).toThrow();
    expect(() => loadConfig({ TRUST_PROXY: 'not-an-ip' })).toThrow();
    expect(() =>
      loadConfig({ ALLOWED_SHELLS: '/bin/bash,/bin/bash' }),
    ).toThrow();
    expect(() =>
      loadConfig({ DEFAULT_SHELL: '/bin/zsh', ALLOWED_SHELLS: '/bin/bash' }),
    ).toThrow();
  });

  it('canonicalizes and deduplicates semantic proxy networks', () => {
    const config = loadConfig({
      TRUST_PROXY: [
        '2001:0DB8:0:0::1/32',
        '2001:db8:ffff::2/32',
        '10.20.30.40/8',
        '10.99.88.77/8',
        '192.0.2.1',
        '192.0.2.1/32',
        '::ffff:198.51.100.129/120',
        '198.51.100.42/24',
      ].join(','),
    });

    expect(config.trustProxy).toEqual([
      '2001:db8::/32',
      '10.0.0.0/8',
      '192.0.2.1/32',
      '198.51.100.0/24',
    ]);
    const matcher = proxyaddr.compile(config.trustProxy as string[]);
    expect(matcher('2001:db8:abcd::1', 0)).toBe(true);
    expect(matcher('10.200.1.1', 0)).toBe(true);
    expect(matcher('::ffff:198.51.100.8', 0)).toBe(true);
    expect(matcher('203.0.113.1', 0)).toBe(false);
  });

  it('rejects more than 64 configured proxy entries', () => {
    const entries = Array.from(
      { length: 65 },
      (_, index) => `10.0.${index}.1/32`,
    );

    expect(() => loadConfig({ TRUST_PROXY: entries.join(',') })).toThrow(
      'Invalid server configuration',
    );
  });

  it.each(['0.0.0.0/0', '::/0'])(
    'rejects proxy range unsupported by proxy-addr: %s',
    (entry) => {
      expect(() => loadConfig({ TRUST_PROXY: entry })).toThrow(
        'Invalid server configuration',
      );
    },
  );

  it('accepts native config arrays and rejects env-only or unknown file keys', () => {
    expect(
      loadConfig({}, { trustProxy: ['127.0.0.1', '::1/128'] }),
    ).toMatchObject({ trustProxy: ['127.0.0.1/32', '::1/128'] });
    expect(() => loadConfig({}, { appConfigFile: '/tmp/config.json' })).toThrow(
      'Invalid server configuration',
    );
    expect(() =>
      loadConfig({}, { localAuthPasswordFile: '/tmp/password' }),
    ).toThrow('Invalid server configuration');
    expect(() => loadConfig({}, { unknown: true })).toThrow(
      'Invalid server configuration',
    );
  });

  it('normalizes base paths and derives public origin fields', () => {
    const config = loadConfig({
      APP_BASE_PATH: '/terminal/',
      APP_PUBLIC_URL: 'https://terminal.example:8443',
    });

    expect(config.basePath).toBe('/terminal');
    expect(config.publicOrigin).toBe('https://terminal.example:8443');
    expect(config.publicHost).toBe('terminal.example:8443');
  });

  it.each([
    '/terminal/./admin',
    '/terminal/%2e%2e/admin',
    '/terminal/%2Fadmin',
    '/terminal/%5cadmin',
    '/terminal/%zz/admin',
  ])('rejects ambiguous or encoded server base path %s', (basePath) => {
    expect(() => loadConfig({ APP_BASE_PATH: basePath })).toThrow(
      'Invalid server configuration',
    );
  });

  it.each([
    ['APP_PORT', '0'],
    ['APP_PORT', '65536'],
    ['APP_PORT', '1.5'],
    ['APP_BASE_PATH', 'terminal'],
    ['APP_BASE_PATH', '/terminal/../admin'],
    ['APP_PUBLIC_URL', 'ftp://example.test'],
    ['APP_PUBLIC_URL', 'https://example.test/path'],
    ['DEFAULT_SHELL', 'bin/bash'],
    ['DEFAULT_FONT_SIZE', '7'],
    ['DEFAULT_FONT_SIZE', '33'],
    ['TMUX_HISTORY_LIMIT', '-1'],
    ['TMUX_HISTORY_LIMIT', '1000001'],
    ['WS_HEARTBEAT_SECONDS', '4'],
    ['WS_HEARTBEAT_SECONDS', '301'],
    ['WS_MAX_BUFFER_BYTES', '65535'],
    ['WS_MAX_BUFFER_BYTES', '1048577'],
    ['WS_MAX_BUFFER_BYTES', '1073741825'],
    ['RESIZE_DEBOUNCE_MS', '24'],
    ['RESIZE_DEBOUNCE_MS', '1001'],
    ['RECONNECT_MAX_SECONDS', '0'],
    ['RECONNECT_MAX_SECONDS', '61'],
    ['LOG_LEVEL', 'verbose'],
    ['HOME_DIR', 'home/webterm'],
    ['DATA_DIR', 'app/data'],
    ['SESSION_MAX_COUNT', '0'],
    ['SESSION_MAX_COUNT', '21'],
    ['SESSION_MAX_COUNT', '1.5'],
  ])('rejects invalid %s safely', (key, value) => {
    let error: unknown;

    try {
      loadConfig({ [key]: value });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Invalid server configuration');
    expect((error as Error).message).not.toContain(value);
  });

  it('loads tab persistence settings at their inclusive boundaries', () => {
    expect(
      loadConfig({ DATA_DIR: '/var/lib/flanterminal', SESSION_MAX_COUNT: '1' }),
    ).toMatchObject({
      dataDir: '/var/lib/flanterminal',
      sessionMaxCount: 1,
    });
    expect(loadConfig({ SESSION_MAX_COUNT: '20' }).sessionMaxCount).toBe(20);
  });

  it('clamps terminal scrollback to its supported range', () => {
    expect(loadConfig({ XTERM_SCROLLBACK: '-5' }).xtermScrollback).toBe(0);
    expect(loadConfig({ XTERM_SCROLLBACK: '100001' }).xtermScrollback).toBe(
      100_000,
    );
  });

  it('projects only approved fields to client configuration', () => {
    expect(toClientConfig(loadConfig({ APP_BASE_PATH: '/terminal/' }))).toEqual(
      {
        basePath: '/terminal',
        resizeDebounceMs: 100,
        reconnectMaxSeconds: 15,
      },
    );
  });

  it.each([
    {
      DEFAULT_FONT_SIZE: '8',
      XTERM_SCROLLBACK: '0',
      RESIZE_DEBOUNCE_MS: '25',
      RECONNECT_MAX_SECONDS: '1',
    },
    {
      DEFAULT_FONT_SIZE: '32',
      XTERM_SCROLLBACK: '100000',
      RESIZE_DEBOUNCE_MS: '1000',
      RECONNECT_MAX_SECONDS: '60',
    },
  ])('projects successful boundary configuration to the client', (env) => {
    expect(() => toClientConfig(loadConfig(env))).not.toThrow();
  });
});
