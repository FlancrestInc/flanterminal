import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { type AuthBootstrap } from '@flanterminal/shared';
import { type ReplaceResult } from './secure-json-file.js';
import { CsrfService, type CsrfRecord } from './csrf-service.js';
import {
  type AuthBootstrapResult,
  type AuthenticatedSession,
  type AuthMode,
  type LocalLoginAttempt,
  type RevocationReason,
  type UpstreamAuthentication,
  type UpstreamIdentity,
} from './auth-types.js';

type Credentials = {
  verify(username: string, password: string): Promise<boolean>;
  replacePassword(password: string): Promise<ReplaceResult>;
};
type Limiter = {
  consume(address: string): boolean;
  resetAddress(address: string): void;
};
type Stored = {
  id: string;
  mode: AuthMode;
  identityLabel: string;
  createdAt: number;
  lastSeen: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  upstreamExpiresAt?: number;
  csrf: CsrfRecord;
  digest: string;
};
export type AuthServiceOptions = Readonly<{
  mode: AuthMode;
  clock: () => number;
  randomBytes?: (size: number) => Uint8Array;
  credentialStore: Credentials;
  csrfService: CsrfService;
  rateLimiter: Limiter;
  idleDurationMs: number;
  absoluteDurationMs: number;
  maxSessions: number;
  maxObservers?: number;
}>;

export class AuthServiceError extends Error {
  constructor() {
    super('Authentication operation failed');
    this.name = 'AuthServiceError';
  }
}

export class AuthService {
  readonly #mode: AuthMode;
  readonly #clock: () => number;
  readonly #random: (n: number) => Uint8Array;
  readonly #credentials: Credentials;
  readonly #csrf: CsrfService;
  readonly #limiter: Limiter;
  readonly #idle: number;
  readonly #absolute: number;
  readonly #max: number;
  readonly #observerMax: number;
  readonly #byDigest = new Map<string, Stored>();
  readonly #byId = new Map<string, Stored>();
  readonly #observers = new Set<
    Readonly<{
      fn: (id: string, reason: RevocationReason) => void | Promise<void>;
    }>
  >();
  #passwordTail: Promise<void> = Promise.resolve();
  constructor(o: AuthServiceOptions) {
    if (
      !Number.isFinite(o.idleDurationMs) ||
      o.idleDurationMs <= 0 ||
      !Number.isFinite(o.absoluteDurationMs) ||
      o.absoluteDurationMs <= 0 ||
      !Number.isInteger(o.maxSessions) ||
      o.maxSessions < 1 ||
      o.maxSessions > 256 ||
      (o.maxObservers !== undefined &&
        (!Number.isInteger(o.maxObservers) ||
          o.maxObservers < 1 ||
          o.maxObservers > 64))
    )
      throw new AuthServiceError();
    this.#mode = o.mode;
    this.#clock = o.clock;
    this.#random = o.randomBytes ?? randomBytes;
    this.#credentials = o.credentialStore;
    this.#csrf = o.csrfService;
    this.#limiter = o.rateLimiter;
    this.#idle = o.idleDurationMs;
    this.#absolute = o.absoluteDurationMs;
    this.#max = o.maxSessions;
    this.#observerMax = Math.min(64, Math.max(1, o.maxObservers ?? 64));
  }

  async bootstrap(input: UpstreamAuthentication): Promise<AuthBootstrapResult> {
    if (this.#mode === 'local') {
      if (input.type !== 'none') throw new AuthServiceError();
      return frozen({
        bootstrap: frozen({ authenticated: false, mode: 'local' }),
      });
    }
    if (this.#mode === 'none') {
      if (input.type !== 'none') throw new AuthServiceError();
      return this.#safeEstablish('none', 'anonymous');
    }
    if (input.type !== 'upstream' || input.identity.mode !== this.#mode)
      throw new AuthServiceError();
    const identity = validateIdentity(input.identity);
    if (this.#mode === 'cloudflare-access' && identity.expiresAt === undefined)
      throw new AuthServiceError();
    if (identity.expiresAt !== undefined && identity.expiresAt <= this.#now())
      throw new AuthServiceError();
    return this.#safeEstablish(
      this.#mode,
      identity.identityLabel,
      identity.expiresAt,
    );
  }
  async login(input: LocalLoginAttempt): Promise<AuthBootstrapResult> {
    if (this.#mode !== 'local') throw new AuthServiceError();
    let allowed: boolean;
    try {
      allowed = this.#limiter.consume(input.address);
    } catch {
      throw new AuthServiceError();
    }
    if (!allowed)
      return frozen({
        bootstrap: frozen({ authenticated: false, mode: 'local' }),
      });
    let valid = false;
    try {
      valid = await this.#credentials.verify(input.username, input.password);
    } catch {
      throw new AuthServiceError();
    }
    if (!valid)
      return frozen({
        bootstrap: frozen({ authenticated: false, mode: 'local' }),
      });
    try {
      this.#limiter.resetAddress(input.address);
      return this.#safeEstablish('local', normalizeLabel(input.username));
    } catch {
      throw new AuthServiceError();
    }
  }
  authenticateCookie(
    rawCookie: string | undefined,
  ): AuthenticatedSession | undefined {
    if (typeof rawCookie !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(rawCookie))
      return undefined;
    const s = this.#byDigest.get(hash(rawCookie));
    if (!s) return undefined;
    const reason = this.#expiredReason(s);
    if (reason) {
      this.#revoke(s, reason);
      return undefined;
    }
    return view(s);
  }
  touch(id: string, activity: 'http' | 'terminal_input'): void {
    if (activity !== 'http' && activity !== 'terminal_input') return;
    const s = this.#byId.get(id);
    if (!s) return;
    const reason = this.#expiredReason(s);
    if (reason) {
      this.#revoke(s, reason);
      return;
    }
    const now = this.#now();
    s.lastSeen = now;
    s.idleExpiresAt = Math.min(s.absoluteExpiresAt, now + this.#idle);
  }
  refresh(
    id: string,
    upstream: UpstreamIdentity,
  ): AuthenticatedSession | undefined {
    const s = this.#byId.get(id);
    if (!s) return undefined;
    const reason = this.#expiredReason(s);
    if (reason) {
      this.#revoke(s, reason);
      return undefined;
    }
    if (s.mode === 'local' || s.mode === 'none') return undefined;
    let u: UpstreamIdentity;
    try {
      u = validateIdentity(upstream);
    } catch {
      return undefined;
    }
    if (
      u.mode !== s.mode ||
      u.identityLabel !== s.identityLabel ||
      u.expiresAt === undefined ||
      u.expiresAt <= this.#now() ||
      (s.upstreamExpiresAt !== undefined && u.expiresAt <= s.upstreamExpiresAt)
    )
      return undefined;
    s.upstreamExpiresAt = u.expiresAt;
    return view(s);
  }
  verifyCsrf(id: string, supplied: string | undefined): boolean {
    const s = this.#byId.get(id);
    if (!s) return false;
    const reason = this.#expiredReason(s);
    if (reason) {
      this.#revoke(s, reason);
      return false;
    }
    return this.#csrf.verify(s.csrf, supplied);
  }
  logout(id: string): void {
    const s = this.#byId.get(id);
    if (s) this.#revoke(s, 'logout');
  }
  changePassword(
    id: string,
    current: string,
    replacement: string,
  ): Promise<boolean> {
    const result = this.#passwordTail.then(
      async () => {
        const s = this.#byId.get(id);
        if (!s || s.mode !== 'local') return false;
        const expired = this.#expiredReason(s);
        if (expired) {
          this.#revoke(s, expired);
          return false;
        }
        let valid: boolean;
        try {
          valid = await this.#credentials.verify(s.identityLabel, current);
        } catch {
          throw new AuthServiceError();
        }
        if (!valid) return false;
        let replaced: ReplaceResult;
        try {
          replaced = await this.#credentials.replacePassword(replacement);
        } catch {
          throw new AuthServiceError();
        }
        if (replaced.state === 'not_committed') return false;
        for (const session of [...this.#byId.values()])
          this.#revoke(session, 'password_changed');
        return true;
      },
      async () => false,
    );
    this.#passwordTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  sweepExpired(): void {
    for (const s of [...this.#byId.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )) {
      const reason = this.#expiredReason(s);
      if (reason) this.#revoke(s, reason);
    }
  }
  onRevoked(
    fn: (id: string, reason: RevocationReason) => void | Promise<void>,
  ): () => void {
    if (typeof fn !== 'function' || this.#observers.size >= this.#observerMax)
      throw new AuthServiceError();
    const r = Object.freeze({ fn });
    this.#observers.add(r);
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.#observers.delete(r);
      }
    };
  }
  toJSON() {
    return frozen({ type: 'AuthService' });
  }
  [inspect.custom]() {
    return 'AuthService {}';
  }
  #establish(
    mode: AuthMode,
    label: string,
    upstreamExpiresAt?: number,
  ): AuthBootstrapResult {
    this.sweepExpired();
    if (this.#byId.size >= this.#max) {
      const oldest = [...this.#byId.values()].sort(
        (a, b) =>
          a.lastSeen - b.lastSeen ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      )[0]!;
      this.#revoke(oldest, 'capacity');
    }
    const now = this.#now();
    let cookie = '';
    let digest = '';
    let id = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      cookie = this.#token(32);
      digest = hash(cookie);
      if (!this.#byDigest.has(digest)) break;
      cookie = '';
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      id = this.#token(16);
      if (!this.#byId.has(id)) break;
      id = '';
    }
    if (!cookie || !id) throw new AuthServiceError();
    const issued = this.#csrf.create();
    const s: Stored = {
      id,
      mode,
      identityLabel: normalizeLabel(label),
      createdAt: now,
      lastSeen: now,
      idleExpiresAt: Math.min(now + this.#idle, now + this.#absolute),
      absoluteExpiresAt: now + this.#absolute,
      csrf: issued.record,
      digest,
      ...(upstreamExpiresAt === undefined ? {} : { upstreamExpiresAt }),
    };
    this.#byDigest.set(s.digest, s);
    this.#byId.set(id, s);
    const bootstrap: AuthBootstrap = frozen({
      authenticated: true,
      mode,
      identityLabel: s.identityLabel,
      csrfToken: issued.token,
      ...(upstreamExpiresAt === undefined
        ? {}
        : { upstreamExpiresAt: new Date(upstreamExpiresAt).toISOString() }),
    });
    return frozen({ bootstrap, cookieValue: cookie });
  }
  #safeEstablish(
    mode: AuthMode,
    label: string,
    upstreamExpiresAt?: number,
  ): AuthBootstrapResult {
    try {
      return this.#establish(mode, label, upstreamExpiresAt);
    } catch {
      throw new AuthServiceError();
    }
  }
  #token(size: number): string {
    const bytes = this.#random(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size)
      throw new AuthServiceError();
    return Buffer.from(bytes).toString('base64url');
  }
  #now(): number {
    const n = this.#clock();
    if (!Number.isFinite(n)) throw new AuthServiceError();
    return n;
  }
  #expiredReason(s: Stored): RevocationReason | undefined {
    const n = this.#now();
    const candidates: [
      [number, RevocationReason],
      [number, RevocationReason],
      [number, RevocationReason],
    ] = [
      [s.idleExpiresAt, 'idle'],
      [s.absoluteExpiresAt, 'absolute'],
      [s.upstreamExpiresAt ?? Infinity, 'upstream'],
    ];
    candidates.sort((a, b) => a[0] - b[0]);
    return n >= candidates[0][0] ? candidates[0][1] : undefined;
  }
  #revoke(s: Stored, reason: RevocationReason) {
    if (!this.#byId.delete(s.id)) return;
    this.#byDigest.delete(s.digest);
    s.digest = '';
    for (const r of [...this.#observers]) {
      try {
        const p = r.fn(s.id, reason);
        if (p) void Promise.resolve(p).catch(() => undefined);
      } catch {
        // Revocation observers cannot affect session authority.
      }
    }
  }
}
function validateIdentity(i: UpstreamIdentity): UpstreamIdentity {
  const label = normalizeLabel(i.identityLabel);
  if (i.mode !== 'cloudflare-access' && i.mode !== 'trusted-header')
    throw new AuthServiceError();
  if (i.expiresAt !== undefined) {
    try {
      if (!Number.isFinite(i.expiresAt)) throw new Error('invalid expiry');
      new Date(i.expiresAt).toISOString();
    } catch {
      throw new AuthServiceError();
    }
  }
  return frozen({
    mode: i.mode,
    identityLabel: label,
    ...(i.expiresAt === undefined ? {} : { expiresAt: i.expiresAt }),
  });
}
function normalizeLabel(v: string): string {
  if (typeof v !== 'string') throw new AuthServiceError();
  const n = v.normalize('NFC');
  if (
    !n ||
    new TextEncoder().encode(n).byteLength > 128 ||
    [...n].some((c) => {
      const x = c.codePointAt(0)!;
      return x < 32 || x === 127;
    })
  )
    throw new AuthServiceError();
  return n;
}
function hash(v: string) {
  return createHash('sha256').update(v).digest('hex');
}
function frozen<T>(v: T): T {
  return Object.freeze(v);
}
function view(s: Stored): AuthenticatedSession {
  return frozen({
    id: s.id,
    mode: s.mode,
    identityLabel: s.identityLabel,
    createdAt: s.createdAt,
    lastSeen: s.lastSeen,
    idleExpiresAt: s.idleExpiresAt,
    absoluteExpiresAt: s.absoluteExpiresAt,
    ...(s.upstreamExpiresAt === undefined
      ? {}
      : { upstreamExpiresAt: s.upstreamExpiresAt }),
  });
}
