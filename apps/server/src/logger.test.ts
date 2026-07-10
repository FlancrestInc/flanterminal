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
});
