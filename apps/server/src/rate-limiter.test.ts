import { describe, expect, it } from 'vitest';

import { LoginRateLimiter } from './rate-limiter.js';

describe('LoginRateLimiter', () => {
  it('consumes global and normalized address buckets atomically', () => {
    let now = 0;
    const limiter = new LoginRateLimiter({
      clock: () => now,
      global: { capacity: 2, refillPerSecond: 1 },
      address: { capacity: 1, refillPerSecond: 1 },
      maxAddresses: 2,
    });
    expect(limiter.consume('192.0.2.1')).toBe(true);
    expect(limiter.consume('::ffff:192.0.2.1')).toBe(false);
    expect(limiter.consume('192.0.2.2')).toBe(true);
    expect(limiter.consume('192.0.2.3')).toBe(false);
    now = 1000;
    expect(limiter.consume('192.0.2.1')).toBe(true);
  });

  it('contains rollback, invalid addresses, reset, and deterministic LRU eviction', () => {
    let now = 10_000;
    const limiter = new LoginRateLimiter({
      clock: () => now,
      global: { capacity: 10, refillPerSecond: 0 },
      address: { capacity: 1, refillPerSecond: 0 },
      maxAddresses: 2,
    });
    expect(limiter.consume('bad secret address')).toBe(true);
    expect(limiter.consume('another bad address')).toBe(false);
    limiter.resetAddress('bad secret address');
    expect(limiter.consume('bad secret address')).toBe(true);
    now = 9_000;
    expect(limiter.consume('203.0.113.1')).toBe(true);
    now = 11_000;
    expect(limiter.consume('203.0.113.2')).toBe(true);
    expect(limiter.trackedAddressCount()).toBe(2);
  });
});
