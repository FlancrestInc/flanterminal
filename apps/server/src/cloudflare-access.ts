import { inspect } from 'node:util';
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
  type JWTVerifyResult,
} from 'jose';

import { type UpstreamIdentity } from './auth-types.js';

const ASSERTION_HEADER = 'cf-access-jwt-assertion';
const MAX_ASSERTION_BYTES = 16 * 1024;
const MAX_HEADER_FIELDS = 128;
const MAX_IDENTITY_BYTES = 128;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;
const DEFAULT_MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const DEFAULT_JWKS_TIMEOUT_MS = 5_000;
const DEFAULT_JWKS_COOLDOWN_MS = 30_000;
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 10 * 60_000;
const compactJwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const audiencePattern = /^[A-Za-z0-9_-]{1,256}$/;
const unsafeIdentityPattern = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const cloudflareTeamLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const utf8 = new TextEncoder();

export type UpstreamHeaderValue = string | readonly string[] | undefined;
export type UpstreamHeaderView = Readonly<Record<string, UpstreamHeaderValue>>;
export interface UpstreamIdentityProvider<Request> {
  authenticate(request: Request): UpstreamIdentity | Promise<UpstreamIdentity>;
}

export class UpstreamProviderError extends Error {
  constructor() {
    super('Upstream identity validation failed');
    this.name = 'UpstreamProviderError';
  }
}

export type CloudflareJwtVerifier = (
  assertion: string,
  key: JWTVerifyGetKey,
  options: JWTVerifyOptions,
) => Promise<JWTVerifyResult>;

export type CloudflareAccessProviderOptions = Readonly<{
  teamOrigin: string;
  audience: string;
  clock?: () => number;
  verifier?: CloudflareJwtVerifier;
  fetch?: FetchImplementation;
  clockToleranceSeconds?: number;
  maxTokenLifetimeSeconds?: number;
  jwksTimeoutMs?: number;
  jwksCooldownMs?: number;
  jwksCacheMaxAgeMs?: number;
}>;

export class CloudflareAccessProvider implements UpstreamIdentityProvider<UpstreamHeaderView> {
  readonly #teamOrigin: string;
  readonly #audience: string;
  readonly #clock: () => number;
  readonly #verifier: CloudflareJwtVerifier;
  readonly #key: JWTVerifyGetKey;
  readonly #clockToleranceSeconds: number;
  readonly #maxTokenLifetimeSeconds: number;

  constructor(options: CloudflareAccessProviderOptions) {
    try {
      this.#teamOrigin = validateHttpsOrigin(options.teamOrigin);
      if (!audiencePattern.test(options.audience)) throw new Error();
      this.#audience = options.audience;
      this.#clock = options.clock ?? Date.now;
      this.#clockToleranceSeconds = boundedInteger(
        options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
        0,
        30,
      );
      this.#maxTokenLifetimeSeconds = boundedInteger(
        options.maxTokenLifetimeSeconds ?? DEFAULT_MAX_TOKEN_LIFETIME_SECONDS,
        60,
        7 * 24 * 60 * 60,
      );
      const timeoutDuration = boundedInteger(
        options.jwksTimeoutMs ?? DEFAULT_JWKS_TIMEOUT_MS,
        10,
        10_000,
      );
      const cooldownDuration = boundedInteger(
        options.jwksCooldownMs ?? DEFAULT_JWKS_COOLDOWN_MS,
        0,
        5 * 60_000,
      );
      const cacheMaxAge = boundedInteger(
        options.jwksCacheMaxAgeMs ?? DEFAULT_JWKS_CACHE_MAX_AGE_MS,
        1_000,
        60 * 60_000,
      );
      this.#key = createRemoteJWKSet(
        new URL(`${this.#teamOrigin}/cdn-cgi/access/certs`),
        {
          timeoutDuration,
          cooldownDuration,
          cacheMaxAge,
          ...(options.fetch === undefined
            ? {}
            : { [customFetch]: options.fetch }),
        },
      );
      this.#verifier =
        options.verifier ??
        (async (assertion, key, verifyOptions) =>
          await jwtVerify(assertion, key, verifyOptions));
    } catch {
      throw new UpstreamProviderError();
    }
  }

  async authenticate(headers: UpstreamHeaderView): Promise<UpstreamIdentity> {
    try {
      const assertion = readAssertion(headers);
      const now = this.#clock();
      if (!Number.isFinite(now) || now < 0) throw new Error();
      const verified = await this.#verifier(assertion, this.#key, {
        algorithms: ['RS256'],
        issuer: this.#teamOrigin,
        audience: this.#audience,
        requiredClaims: ['exp'],
        clockTolerance: this.#clockToleranceSeconds,
        currentDate: new Date(now),
      });
      if (verified.protectedHeader.alg !== 'RS256') throw new Error();
      const expiresAt = numericDateMilliseconds(verified.payload.exp);
      if (
        expiresAt <= now ||
        expiresAt - now > this.#maxTokenLifetimeSeconds * 1_000
      )
        throw new Error();
      if (verified.payload.nbf !== undefined) {
        const notBefore = numericDateMilliseconds(verified.payload.nbf);
        if (notBefore > now + this.#clockToleranceSeconds * 1_000)
          throw new Error();
      }
      const identityLabel = identityFromClaims(verified.payload);
      return Object.freeze({
        mode: 'cloudflare-access',
        identityLabel,
        expiresAt,
      });
    } catch {
      throw new UpstreamProviderError();
    }
  }

  toJSON() {
    return Object.freeze({ type: 'CloudflareAccessProvider' });
  }

  [inspect.custom]() {
    return 'CloudflareAccessProvider {}';
  }
}

function readAssertion(headers: UpstreamHeaderView): string {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers))
    throw new Error();
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADER_FIELDS) throw new Error();
  const matches = entries.filter(
    ([name]) => name.toLowerCase() === ASSERTION_HEADER,
  );
  if (matches.length !== 1) throw new Error();
  const value = matches[0]![1];
  if (
    typeof value !== 'string' ||
    utf8.encode(value).byteLength > MAX_ASSERTION_BYTES ||
    !compactJwtPattern.test(value)
  )
    throw new Error();
  return value;
}

function identityFromClaims(payload: JWTPayload): string {
  if (typeof payload.email === 'string') {
    const email = normalizeIdentity(payload.email);
    if (email !== undefined && emailPattern.test(email)) return email;
  }
  if (typeof payload.sub !== 'string') throw new Error();
  const subject = normalizeIdentity(payload.sub);
  if (subject === undefined) throw new Error();
  return subject;
}

function normalizeIdentity(value: string): string | undefined {
  const normalized = value.normalize('NFC');
  if (
    normalized.length === 0 ||
    utf8.encode(normalized).byteLength > MAX_IDENTITY_BYTES ||
    unsafeIdentityPattern.test(normalized)
  )
    return undefined;
  return normalized;
}

function numericDateMilliseconds(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  )
    throw new Error();
  return value * 1_000;
}

function validateHttpsOrigin(value: string): string {
  if (typeof value !== 'string') throw new Error();
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    value !== url.origin ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !isCloudflareTeamHostname(url.hostname)
  )
    throw new Error();
  return url.origin;
}

function isCloudflareTeamHostname(hostname: string): boolean {
  const labels = hostname.split('.');
  return (
    labels.length === 3 &&
    cloudflareTeamLabelPattern.test(labels[0]!) &&
    labels[1] === 'cloudflareaccess' &&
    labels[2] === 'com'
  );
}

function boundedInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error();
  return value;
}
