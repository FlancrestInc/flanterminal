import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createLifecycleLogger } from './logger.js';

describe('createLifecycleLogger', () => {
  it('emits only validated operational metadata for recognized lifecycle events', () => {
    const capture = logCapture();
    const logger = createLifecycleLogger('info', capture.destination);
    const identityHash = `sha256:${'a'.repeat(64)}`;

    logger.info('server_started', {
      bindHost: '127.0.0.1',
      port: 3000,
      basePath: '/terminal',
      identityHash,
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      category: 'startup',
      reason: 'configured',
      exitCode: 0,
      signal: 15,
      bufferedAmount: 1024,
      code: 1000,
      status: 200,
      safeLookingKey: 'must-not-be-logged',
      context: { nested: 'must-not-be-logged-either' },
    });

    expect(capture.records()).toEqual([
      expect.objectContaining({
        level: 30,
        event: 'server_started',
        bindHost: '127.0.0.1',
        port: 3000,
        basePath: '/terminal',
        identityHash,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        category: 'startup',
        reason: 'configured',
        exitCode: 0,
        signal: 15,
        bufferedAmount: 1024,
        code: 1000,
        status: 200,
      }),
    ]);
    expect(capture.output()).not.toContain('must-not-be-logged');
  });

  it('does not serialize secrets from events, keys, values, nesting, arrays, cycles, or getters', () => {
    const capture = logCapture();
    const logger = createLifecycleLogger('info', capture.destination);
    const getter = vi.fn(() => 'getter-private-key-secret');
    const secrets = [
      'password-secret',
      '$2b$12$bcrypt-hash-secret',
      'cookie-secret',
      'csrf-secret',
      'access-jwt-secret',
      'trusted-auth-header-secret',
      'Bearer authorization-secret',
      '-----BEGIN PRIVATE KEY-----private-key-secret',
      'ENV_PRIVATE_KEY_SECRET',
      'admin@example.test',
      'terminal-input-secret',
      'terminal-output-secret',
      'request-body-secret',
      'safe-looking-value-secret',
      'event-name-secret',
    ];
    const cyclic: Record<string, unknown> = {
      password: secrets[0],
      PASSWORD_HASH: secrets[1],
      headers: {
        cookie: secrets[2],
        'x-csrf-token': secrets[3],
        'cf-access-jwt-assertion': secrets[4],
        'x-authenticated-user': secrets[5],
        authorization: secrets[6],
      },
      body: secrets[12],
      terminal: { input: secrets[10], output: secrets[11] },
      environment: { PRIVATE_KEY: secrets[8] },
      privateKey: secrets[7],
      identity: secrets[9],
      email: secrets[9],
      message: secrets[13],
      array: secrets,
    };
    cyclic.self = cyclic;
    Object.defineProperty(cyclic, 'getter', {
      enumerable: true,
      get: getter,
    });

    expect(() =>
      logger.warn(`terminal_opened_${secrets[14]}`, {
        safeLookingMetadata: secrets[13],
        request: cyclic,
        array: [cyclic, secrets],
        cycle: cyclic,
      }),
    ).not.toThrow();

    const serialized = capture.output();
    expect(capture.records()[0]).toMatchObject({
      event: 'unrecognized_event',
    });
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(getter).not.toHaveBeenCalled();
  });

  it('drops invalid allowlisted values instead of coercing or traversing them', () => {
    const capture = logCapture();
    const logger = createLifecycleLogger('info', capture.destination);
    const throwingCategory = vi.fn(() => {
      throw new Error('getter-category-secret');
    });
    const metadata: Record<string, unknown> = {
      sessionId: 'contains spaces and raw identity@example.test',
      reason: 'x'.repeat(256),
      signal: Number.NaN,
      port: 70_000,
      code: { value: 'object-code-secret' },
      bindHost: 'host\nheader-secret',
      basePath: '../private-key-secret',
      identityHash: 'admin@example.test',
    };
    Object.defineProperty(metadata, 'category', {
      enumerable: true,
      get: throwingCategory,
    });

    expect(() =>
      logger.error('terminal_connection_failed', metadata),
    ).not.toThrow();

    const record = capture.records()[0]!;
    for (const key of [
      'sessionId',
      'reason',
      'signal',
      'port',
      'code',
      'bindHost',
      'basePath',
      'identityHash',
      'category',
    ]) {
      expect(record).not.toHaveProperty(key);
    }
    expect(capture.output()).not.toContain('secret');
    expect(throwingCategory).toHaveBeenCalledOnce();
  });

  it('preserves structured levels and respects the configured log threshold', () => {
    const capture = logCapture();
    const logger = createLifecycleLogger('warn', capture.destination);

    logger.info('terminal_opened', { sessionId: 'phase-3-main' });
    logger.warn('terminal_exited', {
      sessionId: 'phase-3-main',
      exitCode: 1,
      signal: 15,
    });
    logger.error('terminal_connection_failed', {
      sessionId: 'phase-3-main',
    });

    expect(capture.records()).toEqual([
      expect.objectContaining({ level: 40, event: 'terminal_exited' }),
      expect.objectContaining({
        level: 50,
        event: 'terminal_connection_failed',
      }),
    ]);
  });
});

function logCapture(): Readonly<{
  destination: Writable;
  output(): string;
  records(): ReadonlyArray<Record<string, unknown>>;
}> {
  let output = '';
  return {
    destination: new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
    output: () => output,
    records: () =>
      output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}
