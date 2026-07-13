import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const records = new WeakMap<CsrfRecord, Uint8Array>();

export class CsrfRecord {}

export class CsrfService {
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #compare: (left: Uint8Array, right: Uint8Array) => boolean;
  constructor(
    options: Readonly<{
      randomBytes?: (size: number) => Uint8Array;
      compare?: (left: Uint8Array, right: Uint8Array) => boolean;
    }> = {},
  ) {
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#compare = options.compare ?? timingSafeEqual;
  }
  create(): Readonly<{ token: string; record: CsrfRecord }> {
    const bytes = this.#randomBytes(32);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32)
      throw new Error('CSRF operation failed');
    const token = Buffer.from(bytes).toString('base64url');
    const record = Object.freeze(new CsrfRecord());
    records.set(record, digest(token));
    return Object.freeze({ token, record });
  }
  verify(record: CsrfRecord, supplied: string | undefined): boolean {
    if (
      typeof supplied !== 'string' ||
      supplied.length > 512 ||
      !TOKEN_PATTERN.test(supplied)
    )
      return false;
    const expected = records.get(record);
    if (!expected) return false;
    return this.#compare(expected, digest(supplied));
  }
  [inspect.custom](): string {
    return 'CsrfService {}';
  }
}

function digest(value: string): Uint8Array {
  return createHash('sha256').update(value).digest();
}
