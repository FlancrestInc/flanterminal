import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { CsrfService } from './csrf-service.js';

describe('CsrfService', () => {
  it('creates opaque 256-bit tokens and verifies strict input', () => {
    const service = new CsrfService({ randomBytes: () => Buffer.alloc(32, 7) });
    const issued = service.create();
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.verify(issued.record, issued.token)).toBe(true);
    expect(service.verify(issued.record, undefined)).toBe(false);
    expect(service.verify(issued.record, `${issued.token}!`)).toBe(false);
    expect(service.verify(issued.record, 'a'.repeat(513))).toBe(false);
    expect(JSON.stringify(issued.record)).not.toContain(issued.token);
  });

  it('compares only equal-length digests and exposes no token in inspection or errors', () => {
    const comparisons: Array<[number, number]> = [];
    const compare = vi.fn((left: Uint8Array, right: Uint8Array) => {
      comparisons.push([left.byteLength, right.byteLength]);
      return Buffer.from(left).equals(Buffer.from(right));
    });
    const service = new CsrfService({
      randomBytes: () => Buffer.alloc(32, 11),
      compare,
    });
    const issued = service.create();
    expect(service.verify(issued.record, 'A'.repeat(43))).toBe(false);
    expect(service.verify(issued.record, issued.token)).toBe(true);
    expect(service.verify(issued.record, undefined)).toBe(false);
    expect(service.verify(issued.record, 'bad!')).toBe(false);
    expect(service.verify(issued.record, 'A'.repeat(513))).toBe(false);
    expect(comparisons).toEqual([
      [32, 32],
      [32, 32],
    ]);
    expect(inspect(service)).not.toContain(issued.token);
    expect(JSON.stringify(issued.record)).not.toContain(issued.token);
  });
});
