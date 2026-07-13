import { describe, expect, it } from 'vitest';

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
});
