import ipaddr from 'ipaddr.js';

type BucketConfig = Readonly<{ capacity: number; refillPerSecond: number }>;
export type LoginRateLimiterOptions = Readonly<{
  clock: () => number;
  global: BucketConfig;
  address: BucketConfig;
  maxAddresses: number;
}>;

type Bucket = { tokens: number; updatedAt: number; usedAt: number };

export class LoginRateLimiter {
  readonly #clock: () => number;
  readonly #globalConfig: BucketConfig;
  readonly #addressConfig: BucketConfig;
  readonly #maxAddresses: number;
  readonly #addresses = new Map<string, Bucket>();
  readonly #global: Bucket;
  #lastNow = 0;
  #sequence = 0;

  constructor(options: LoginRateLimiterOptions) {
    validateBucket(options.global);
    validateBucket(options.address);
    if (
      !Number.isInteger(options.maxAddresses) ||
      options.maxAddresses < 1 ||
      options.maxAddresses > 1024
    )
      throw new Error('Invalid rate limiter options');
    this.#clock = options.clock;
    this.#globalConfig = Object.freeze({ ...options.global });
    this.#addressConfig = Object.freeze({ ...options.address });
    this.#maxAddresses = options.maxAddresses;
    const now = this.#now();
    this.#global = {
      tokens: options.global.capacity,
      updatedAt: now,
      usedAt: 0,
    };
  }

  consume(address: string): boolean {
    const now = this.#now();
    const key = normalizeAddress(address);
    let addressBucket = this.#addresses.get(key);
    if (!addressBucket) {
      if (this.#addresses.size >= this.#maxAddresses) this.#evictOldest();
      addressBucket = {
        tokens: this.#addressConfig.capacity,
        updatedAt: now,
        usedAt: ++this.#sequence,
      };
      this.#addresses.set(key, addressBucket);
    }
    refill(this.#global, this.#globalConfig, now);
    refill(addressBucket, this.#addressConfig, now);
    addressBucket.usedAt = ++this.#sequence;
    if (this.#global.tokens < 1 || addressBucket.tokens < 1) return false;
    this.#global.tokens -= 1;
    addressBucket.tokens -= 1;
    return true;
  }

  resetAddress(address: string): void {
    this.#addresses.delete(normalizeAddress(address));
  }

  trackedAddressCount(): number {
    return this.#addresses.size;
  }

  #now(): number {
    const value = this.#clock();
    if (!Number.isFinite(value)) return this.#lastNow;
    this.#lastNow = Math.max(this.#lastNow, value);
    return this.#lastNow;
  }

  #evictOldest(): void {
    let selected: readonly [string, Bucket] | undefined;
    for (const entry of this.#addresses) {
      if (
        !selected ||
        entry[1].usedAt < selected[1].usedAt ||
        (entry[1].usedAt === selected[1].usedAt && entry[0] < selected[0])
      )
        selected = entry;
    }
    if (selected) this.#addresses.delete(selected[0]);
  }
}
export { LoginRateLimiter as BoundedLoginRateLimiter };

function refill(bucket: Bucket, config: BucketConfig, now: number): void {
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(
    config.capacity,
    bucket.tokens + (elapsed / 1000) * config.refillPerSecond,
  );
  bucket.updatedAt = now;
}

function normalizeAddress(value: string): string {
  if (typeof value !== 'string' || value.length > 256) return 'unknown';
  try {
    return ipaddr.process(value).toString();
  } catch {
    return 'unknown';
  }
}

function validateBucket(value: BucketConfig): void {
  if (
    !Number.isFinite(value.capacity) ||
    value.capacity <= 0 ||
    !Number.isFinite(value.refillPerSecond) ||
    value.refillPerSecond < 0
  )
    throw new Error('Invalid rate limiter options');
}
