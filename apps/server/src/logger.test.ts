import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLifecycleLogger } from './logger.js';

describe('createLifecycleLogger', () => {
  it('emits structured lifecycle metadata and redacts sensitive keys', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createLifecycleLogger('info', destination);

    logger.info('terminal_opened', {
      sessionId: 'phase-1-main',
      password: 'password-secret',
      token: 'token-secret',
      authorization: 'authorization-secret',
      cookie: 'cookie-secret',
      privateKey: 'key-secret',
      env: { SECRET: 'env-secret' },
    });

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: 'terminal_opened',
      sessionId: 'phase-1-main',
      password: '[Redacted]',
      token: '[Redacted]',
      authorization: '[Redacted]',
      cookie: '[Redacted]',
      privateKey: '[Redacted]',
      env: '[Redacted]',
    });
    expect(output).not.toContain('secret');
  });

  it('recursively redacts mixed-case sensitive keys in arrays and cycles safely', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createLifecycleLogger('info', destination);
    const cyclic: Record<string, unknown> = {
      SeCrEt: 'deep-secret-value',
      children: [
        {
          password: 'password-value',
          TOKEN: 'token-value',
          Authorization: 'authorization-value',
          COOKIE: 'cookie-value',
          PrivateKey: 'private-key-value',
          ENV: { PRIVATE: 'environment-value' },
          apiKey: 'api-key-value',
          ACCESStoken: 'access-token-value',
        },
      ],
    };
    cyclic.self = cyclic;

    expect(() =>
      logger.info('terminal_nested', {
        sessionId: 'phase-1-main',
        context: { nested: cyclic },
      }),
    ).not.toThrow();

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record).toMatchObject({
      context: {
        nested: {
          SeCrEt: '[Redacted]',
          children: [
            {
              password: '[Redacted]',
              TOKEN: '[Redacted]',
              Authorization: '[Redacted]',
              COOKIE: '[Redacted]',
              PrivateKey: '[Redacted]',
              ENV: '[Redacted]',
              apiKey: '[Redacted]',
              ACCESStoken: '[Redacted]',
            },
          ],
          self: '[Circular]',
        },
      },
    });
    for (const value of [
      'deep-secret-value',
      'password-value',
      'token-value',
      'authorization-value',
      'cookie-value',
      'private-key-value',
      'environment-value',
      'api-key-value',
      'access-token-value',
    ]) {
      expect(output).not.toContain(value);
    }
  });
});
