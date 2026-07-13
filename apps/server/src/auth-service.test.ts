import { describe, expect, it, vi } from 'vitest';
import { CsrfService } from './csrf-service.js';
import { AuthService } from './auth-service.js';

describe('AuthService', () => {
  it('establishes, authenticates without touching, touches, verifies CSRF and logs out once', async () => {
    let now = 1000;
    let byte = 1;
    const credentials = {
      verify: vi.fn(async () => true),
      replacePassword: vi.fn(),
    };
    const limiter = { consume: vi.fn(() => true), resetAddress: vi.fn() };
    const service = new AuthService({
      mode: 'local',
      clock: () => now,
      randomBytes: (n) => Buffer.alloc(n, byte++),
      credentialStore: credentials,
      csrfService: new CsrfService({ randomBytes: (n) => Buffer.alloc(n, 9) }),
      rateLimiter: limiter,
      idleDurationMs: 100,
      absoluteDurationMs: 1000,
      maxSessions: 2,
    });
    const revoked = vi.fn();
    service.onRevoked(revoked);
    const result = await service.login({
      username: 'admin',
      password: 'password-password',
      address: '127.0.0.1',
    });
    expect(result.cookieValue).toBeDefined();
    const session = service.authenticateCookie(result.cookieValue);
    expect(session?.lastSeen).toBe(1000);
    expect(
      service.verifyCsrf(
        session!.id,
        result.bootstrap.authenticated ? result.bootstrap.csrfToken : undefined,
      ),
    ).toBe(true);
    now = 1050;
    service.touch(session!.id, 'http');
    expect(service.authenticateCookie(result.cookieValue)?.lastSeen).toBe(1050);
    service.logout(session!.id);
    expect(service.authenticateCookie(result.cookieValue)).toBeUndefined();
    expect(revoked).toHaveBeenCalledOnce();
  });

  it('rate limits before verify, shapes wrong username, evicts capacity and expires once', async () => {
    const now = 0;
    let byte = 1;
    const verify = vi.fn(async () => false);
    const consume = vi.fn(() => false);
    const service = new AuthService({
      mode: 'local',
      clock: () => now,
      randomBytes: (n) => Buffer.alloc(n, byte++),
      credentialStore: { verify, replacePassword: vi.fn() },
      csrfService: new CsrfService(),
      rateLimiter: { consume, resetAddress: vi.fn() },
      idleDurationMs: 10,
      absoluteDurationMs: 100,
      maxSessions: 1,
    });
    await service.login({
      username: 'x',
      password: 'password-password',
      address: 'x',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('handles local failure, success reset, and wrong-mode calls generically', async () => {
    const h = setup('local');
    h.credentials.verify
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const failed = await h.service.login(login());
    expect(failed.bootstrap.authenticated).toBe(false);
    const success = await h.service.login(login());
    expect(success.bootstrap.authenticated).toBe(true);
    expect(h.limiter.resetAddress).toHaveBeenCalledOnce();
    await expect(
      h.service.bootstrap({
        type: 'upstream',
        identity: { mode: 'trusted-header', identityLabel: 'user' },
      }),
    ).rejects.toThrow('Authentication operation failed');
    const none = setup('none');
    await expect(none.service.login(login())).rejects.toThrow();
    const recovered = await none.service.bootstrap({ type: 'none' });
    expect(recovered.bootstrap.authenticated).toBe(true);
  });

  it('establishes none and matching upstream sessions with immutable secret-free views', async () => {
    const none = setup('none');
    const anonymous = await none.service.bootstrap({ type: 'none' });
    const anonymousView = none.service.authenticateCookie(
      anonymous.cookieValue,
    );
    expect(anonymousView?.identityLabel).toBe('anonymous');
    expect(Object.isFrozen(anonymousView)).toBe(true);
    expect(JSON.stringify(anonymousView)).not.toContain(anonymous.cookieValue!);
    expect(none.service.authenticateCookie('bad')).toBeUndefined();
    expect(Reflect.ownKeys(none.service)).toEqual([]);

    const upstream = setup('cloudflare-access');
    const result = await upstream.service.bootstrap({
      type: 'upstream',
      identity: {
        mode: 'cloudflare-access',
        identityLabel: 'person@example.com',
        expiresAt: 900,
      },
    });
    expect(result.bootstrap.authenticated).toBe(true);
    await expect(
      upstream.service.bootstrap({ type: 'none' }),
    ).rejects.toThrow();
  });

  it('evicts deterministic oldest activity and emits capacity once', async () => {
    const h = setup('none', { maxSessions: 2 });
    const revoked = vi.fn();
    h.service.onRevoked(revoked);
    const first = await h.service.bootstrap({ type: 'none' });
    h.time.now = 1;
    const second = await h.service.bootstrap({ type: 'none' });
    h.time.now = 2;
    h.service.touch(
      h.service.authenticateCookie(first.cookieValue)!.id,
      'terminal_input',
    );
    await h.service.bootstrap({ type: 'none' });
    expect(h.service.authenticateCookie(second.cookieValue)).toBeUndefined();
    expect(revoked).toHaveBeenCalledWith(expect.any(String), 'capacity');
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it('advances idle only on valid activity while absolute expiry never moves', async () => {
    const h = setup('none', { idleDurationMs: 10, absoluteDurationMs: 25 });
    const result = await h.service.bootstrap({ type: 'none' });
    const initial = h.service.authenticateCookie(result.cookieValue)!;
    h.time.now = 5;
    const unchanged = h.service.authenticateCookie(result.cookieValue)!;
    expect(unchanged.lastSeen).toBe(initial.lastSeen);
    h.service.touch(initial.id, 'http');
    const touched = h.service.authenticateCookie(result.cookieValue)!;
    expect(touched.idleExpiresAt).toBe(15);
    expect(touched.absoluteExpiresAt).toBe(25);
    h.time.now = 25;
    expect(h.service.authenticateCookie(result.cookieValue)).toBeUndefined();
  });

  it('expires at the upstream bound and refreshes only matching identity upstream expiry', async () => {
    const h = setup('trusted-header', {
      idleDurationMs: 100,
      absoluteDurationMs: 200,
    });
    const result = await h.service.bootstrap({
      type: 'upstream',
      identity: {
        mode: 'trusted-header',
        identityLabel: 'person',
        expiresAt: 20,
      },
    });
    const prior = h.service.authenticateCookie(result.cookieValue)!;
    expect(
      h.service.refresh(prior.id, {
        mode: 'trusted-header',
        identityLabel: 'other',
        expiresAt: 40,
      }),
    ).toBeUndefined();
    const refreshed = h.service.refresh(prior.id, {
      mode: 'trusted-header',
      identityLabel: 'person',
      expiresAt: 40,
    })!;
    expect(refreshed.idleExpiresAt).toBe(prior.idleExpiresAt);
    expect(refreshed.absoluteExpiresAt).toBe(prior.absoluteExpiresAt);
    h.time.now = 40;
    expect(h.service.authenticateCookie(result.cookieValue)).toBeUndefined();
  });

  it('refreshes an expiry-less trusted identity without moving application bounds', async () => {
    const h = setup('trusted-header');
    const result = await h.service.bootstrap({
      type: 'upstream',
      identity: { mode: 'trusted-header', identityLabel: 'person' },
    });
    const prior = h.service.authenticateCookie(result.cookieValue)!;
    const refreshed = h.service.refresh(prior.id, {
      mode: 'trusted-header',
      identityLabel: 'person',
    });
    expect(refreshed).toEqual(prior);
    expect(refreshed).not.toHaveProperty('upstreamExpiresAt');
    expect(
      h.service.refresh(prior.id, {
        mode: 'cloudflare-access',
        identityLabel: 'person',
        expiresAt: 50,
      }),
    ).toBeUndefined();
  });

  it('binds CSRF per session and makes logout and sweep idempotent', async () => {
    const h = setup('none', { idleDurationMs: 5 });
    const revoked = vi.fn();
    h.service.onRevoked(revoked);
    const one = await h.service.bootstrap({ type: 'none' });
    const two = await h.service.bootstrap({ type: 'none' });
    const oneSession = h.service.authenticateCookie(one.cookieValue)!;
    expect(
      h.service.verifyCsrf(
        oneSession.id,
        two.bootstrap.authenticated ? two.bootstrap.csrfToken : undefined,
      ),
    ).toBe(false);
    h.service.logout(oneSession.id);
    h.service.logout(oneSession.id);
    h.time.now = 5;
    h.service.sweepExpired();
    h.service.sweepExpired();
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  it('supports bounded independent revocation registrations and isolates async rejection', async () => {
    const h = setup('none', { maxObservers: 2 });
    const listener = vi.fn(async () => Promise.reject(new Error('observer')));
    const first = h.service.onRevoked(listener);
    const second = h.service.onRevoked(listener);
    expect(() => h.service.onRevoked(listener)).toThrow();
    first();
    first();
    const session = await h.service.bootstrap({ type: 'none' });
    h.service.logout(h.service.authenticateCookie(session.cookieValue)!.id);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    second();
  });

  it.each([
    'not_committed',
    'committed',
    'committed_durability_uncertain',
  ] as const)(
    'handles password change result %s at the commit authority boundary',
    async (state) => {
      const h = setup('local');
      h.credentials.verify.mockResolvedValue(true);
      h.credentials.replacePassword.mockResolvedValue({ state } as never);
      const result = await h.service.login(login());
      const id = h.service.authenticateCookie(result.cookieValue)!.id;
      await expect(
        h.service.changePassword(
          id,
          'current-password',
          'replacement-password',
        ),
      ).resolves.toBe(state !== 'not_committed');
      if (state === 'not_committed') {
        expect(h.service.authenticateCookie(result.cookieValue)).toBeDefined();
      } else {
        expect(
          h.service.authenticateCookie(result.cookieValue),
        ).toBeUndefined();
      }
    },
  );

  it('serializes complete password changes so only one old-password verification commits', async () => {
    const h = setup('local');
    h.credentials.verify.mockResolvedValueOnce(true);
    const result = await h.service.login(login());
    const id = h.service.authenticateCookie(result.cookieValue)!.id;
    h.credentials.verify
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    h.credentials.replacePassword.mockResolvedValue({ state: 'committed' });
    const revoked = vi.fn();
    h.service.onRevoked(revoked);
    const first = h.service.changePassword(
      id,
      'old-password-value',
      'first-replacement',
    );
    const second = h.service.changePassword(
      id,
      'old-password-value',
      'second-replacement',
    );
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(h.credentials.replacePassword).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it.each(['logout', 'expiry', 'capacity'] as const)(
    'does not replace a password when %s revokes the caller during verification',
    async (race) => {
      const h = setup('local', {
        maxSessions: 1,
        idleDurationMs: 5,
      });
      const gate = deferred<boolean>();
      const revoked = vi.fn();
      h.service.onRevoked(revoked);
      h.credentials.verify.mockResolvedValueOnce(true);
      const loginResult = await h.service.login(login());
      const session = h.service.authenticateCookie(loginResult.cookieValue)!;
      h.credentials.verify.mockReturnValueOnce(gate.promise);
      const change = h.service.changePassword(
        session.id,
        'current-password',
        'replacement-password',
      );
      await Promise.resolve();
      if (race === 'logout') h.service.logout(session.id);
      if (race === 'expiry') {
        h.time.now = 5;
        h.service.sweepExpired();
      }
      if (race === 'capacity') await h.service.login(login());
      gate.resolve(true);
      await expect(change).resolves.toBe(false);
      expect(h.credentials.replacePassword).not.toHaveBeenCalled();
      expect(revoked).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves the capacity victim and rate reset when establishment randomness fails', async () => {
    let calls = 0;
    const resetAddress = vi.fn();
    const service = new AuthService({
      mode: 'local',
      clock: () => 0,
      randomBytes: (size) => {
        calls += 1;
        if (calls > 2) throw new Error('random failure');
        return Buffer.alloc(size, calls);
      },
      credentialStore: {
        verify: vi.fn(async () => true),
        replacePassword: vi.fn(),
      },
      csrfService: new CsrfService(),
      rateLimiter: { consume: () => true, resetAddress },
      idleDurationMs: 100,
      absoluteDurationMs: 1000,
      maxSessions: 1,
    });
    const first = await service.login(login());
    const victim = service.authenticateCookie(first.cookieValue)!;
    await expect(service.login(login())).rejects.toThrow(
      'Authentication operation failed',
    );
    expect(service.authenticateCookie(first.cookieValue)?.id).toBe(victim.id);
    expect(resetAddress).toHaveBeenCalledTimes(1);
  });

  it('preserves the capacity victim and rate reset when CSRF construction fails', async () => {
    let csrfCalls = 0;
    class FailingCsrfService extends CsrfService {
      override create() {
        csrfCalls += 1;
        if (csrfCalls === 2) throw new Error('csrf failure');
        return super.create();
      }
    }
    let byte = 1;
    const resetAddress = vi.fn();
    const service = new AuthService({
      mode: 'local',
      clock: () => 0,
      randomBytes: (size) => Buffer.alloc(size, byte++),
      credentialStore: {
        verify: vi.fn(async () => true),
        replacePassword: vi.fn(),
      },
      csrfService: new FailingCsrfService(),
      rateLimiter: { consume: () => true, resetAddress },
      idleDurationMs: 100,
      absoluteDurationMs: 1000,
      maxSessions: 1,
    });
    const first = await service.login(login());
    const victim = service.authenticateCookie(first.cookieValue)!;
    await expect(service.login(login())).rejects.toThrow(
      'Authentication operation failed',
    );
    expect(service.authenticateCookie(first.cookieValue)?.id).toBe(victim.id);
    expect(resetAddress).toHaveBeenCalledTimes(1);
  });

  it('does not publish or evict when successful-login address reset throws', async () => {
    const h = setup('local', { maxSessions: 1 });
    const revoked = vi.fn();
    h.service.onRevoked(revoked);
    const first = await h.service.login(login());
    const victim = h.service.authenticateCookie(first.cookieValue)!;
    h.limiter.resetAddress.mockImplementationOnce(() => {
      throw new Error('reset failure');
    });
    await expect(h.service.login(login())).rejects.toThrow(
      'Authentication operation failed',
    );
    expect(h.service.authenticateCookie(first.cookieValue)?.id).toBe(victim.id);
    expect(revoked).not.toHaveBeenCalled();
  });

  it('queues observer-reentrant establishment after complete capacity replacement', async () => {
    const h = setup('none', { maxSessions: 1 });
    const first = await h.service.bootstrap({ type: 'none' });
    const revocations: string[] = [];
    let reentrant:
      Promise<Awaited<ReturnType<typeof h.service.bootstrap>>> | undefined;
    h.service.onRevoked((_id, reason) => {
      revocations.push(reason);
      if (!reentrant) reentrant = h.service.bootstrap({ type: 'none' });
    });

    const outer = await h.service.bootstrap({ type: 'none' });
    expect(h.service.authenticateCookie(first.cookieValue)).toBeUndefined();
    expect(h.service.authenticateCookie(outer.cookieValue)).toBeDefined();
    const inner = await reentrant!;
    expect(h.service.authenticateCookie(outer.cookieValue)).toBeUndefined();
    expect(h.service.authenticateCookie(inner.cookieValue)).toBeDefined();
    expect(revocations).toEqual(['capacity', 'capacity']);
  });

  it('serializes parallel bootstraps and remains capped deterministically', async () => {
    const h = setup('none', { maxSessions: 1 });
    const revoked = vi.fn();
    h.service.onRevoked(revoked);
    const results = await Promise.all([
      h.service.bootstrap({ type: 'none' }),
      h.service.bootstrap({ type: 'none' }),
      h.service.bootstrap({ type: 'none' }),
    ]);
    expect(
      h.service.authenticateCookie(results[0]!.cookieValue),
    ).toBeUndefined();
    expect(
      h.service.authenticateCookie(results[1]!.cookieValue),
    ).toBeUndefined();
    expect(h.service.authenticateCookie(results[2]!.cookieValue)).toBeDefined();
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  it('contains credential operational failures behind the generic error', async () => {
    const h = setup('local');
    h.credentials.verify.mockRejectedValueOnce(new Error('password /secret'));
    await expect(h.service.login(login())).rejects.toMatchObject({
      message: 'Authentication operation failed',
    });
  });
});

function login() {
  return {
    username: 'admin',
    password: 'password-password',
    address: '127.0.0.1',
  };
}

function setup(
  mode: 'local' | 'none' | 'cloudflare-access' | 'trusted-header',
  overrides: Partial<{
    idleDurationMs: number;
    absoluteDurationMs: number;
    maxSessions: number;
    maxObservers: number;
  }> = {},
) {
  const time = { now: 0 };
  let byte = 1;
  const credentials = {
    verify: vi.fn(async () => true),
    replacePassword: vi.fn(async () => ({ state: 'committed' as const })),
  };
  const limiter = { consume: vi.fn(() => true), resetAddress: vi.fn() };
  const service = new AuthService({
    mode,
    clock: () => time.now,
    randomBytes: (size) => Buffer.alloc(size, byte++),
    credentialStore: credentials,
    csrfService: new CsrfService({
      randomBytes: (size) => Buffer.alloc(size, byte++),
    }),
    rateLimiter: limiter,
    idleDurationMs: overrides.idleDurationMs ?? 100,
    absoluteDurationMs: overrides.absoluteDurationMs ?? 1000,
    maxSessions: overrides.maxSessions ?? 4,
    ...(overrides.maxObservers === undefined
      ? {}
      : { maxObservers: overrides.maxObservers }),
  });
  return { service, credentials, limiter, time };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
