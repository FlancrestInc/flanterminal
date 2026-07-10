import { describe, expect, it } from 'vitest';

import { FIXED_SESSION_ID } from '@flanterminal/shared';

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
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('uses only the supplied env object', () => {
    expect(loadConfig({}).port).toBe(3000);
    expect(loadConfig({ APP_PORT: '3456' }).port).toBe(3456);
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
    ['WS_MAX_BUFFER_BYTES', '1073741825'],
    ['RESIZE_DEBOUNCE_MS', '24'],
    ['RESIZE_DEBOUNCE_MS', '1001'],
    ['RECONNECT_MAX_SECONDS', '0'],
    ['RECONNECT_MAX_SECONDS', '61'],
    ['LOG_LEVEL', 'verbose'],
    ['HOME_DIR', 'home/webterm'],
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
        sessionId: FIXED_SESSION_ID,
        fontSize: 14,
        scrollback: 10_000,
        resizeDebounceMs: 100,
        reconnectMaxSeconds: 15,
      },
    );
  });
});
