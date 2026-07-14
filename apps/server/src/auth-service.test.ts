import { describe, expect, it, vi } from 'vitest';
import { CsrfService } from './csrf-service.js';
import { AuthService } from './auth-service.js';
import { type EnrollmentResult } from './credential-store.js';
import { LoginRateLimiter } from './rate-limiter.js';

describe('AuthService', () => {
  it('establishes, authenticates without touching, touches, verifies CSRF and logs out once', async () => {
    let now = 1000;
    let byte = 1;
    const credentials = {
      isInitialized: vi.fn(() => true),
      enroll: vi.fn(),
      verify: vi.fn(async () => true),
      replacePassword: vi.fn(),
    };
    const limiter = { consume: vi.fn(() => true), resetAddress: vi.fn() };
    const service = new AuthService({
      mode: 'local',
      localUsername: 'admin',
      onDurabilityUncertain: vi.fn(),
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
      credentialStore: {
        isInitialized: vi.fn(() => true),
        enroll: vi.fn(),
        verify,
        replacePassword: vi.fn(),
      },
      localUsername: 'admin',
      onDurabilityUncertain: vi.fn(),
      csrfService: new CsrfService(),
      rateLimiter: { consume, resetAddress: vi.fn() },
      idleDurationMs: 10,
      absoluteDurationMs: 100,
      maxSessions: 1,
    });
    const denied = await service.login({
      username: 'x',
      password: 'password-password',
      address: 'x',
    });
    expect(denied.failure).toBe('rate_limited');
    expect(verify).not.toHaveBeenCalled();
  });

  it('distinguishes credential rejection internally without changing the bootstrap', async () => {
    const h = setup('local');
    h.credentials.verify.mockResolvedValue(false);

    const denied = await h.service.login(login());

    expect(denied).toEqual({
      bootstrap: { authenticated: false, mode: 'local' },
    });
    expect(denied.failure).toBe('authentication_failed');
    expect(Object.keys(denied)).toEqual(['bootstrap']);
    expect({ ...denied }).not.toHaveProperty('failure');
    expect(JSON.stringify(denied)).not.toContain('failure');
  });

  it('publishes exact frozen setup-required bootstrap state only while local credentials are uninitialized', async () => {
    const h = setup('local', { localUsername: 'operator' });
    h.credentials.isInitialized.mockReturnValue(false);

    const fresh = await h.service.bootstrap({ type: 'none' });

    expect(fresh).toEqual({
      bootstrap: {
        authenticated: false,
        mode: 'local',
        setupRequired: true,
        username: 'operator',
      },
    });
    expect(Object.isFrozen(fresh)).toBe(true);
    expect(Object.isFrozen(fresh.bootstrap)).toBe(true);

    h.credentials.isInitialized.mockReturnValue(true);
    const initialized = await h.service.bootstrap({ type: 'none' });
    expect(initialized).toEqual({
      bootstrap: { authenticated: false, mode: 'local' },
    });
    expect(Object.isFrozen(initialized)).toBe(true);
    expect(Object.isFrozen(initialized.bootstrap)).toBe(true);
  });

  it('rejects an invalid configured local username', () => {
    expect(() => setup('local', { localUsername: 'admin\0secret' })).toThrow(
      'Authentication operation failed',
    );
  });

  it('returns a hidden setup-required login failure before limiter or verifier work', async () => {
    const h = setup('local', { localUsername: 'operator' });
    h.credentials.isInitialized.mockReturnValue(false);

    const result = await h.service.login(login());

    expect(result).toEqual({
      bootstrap: {
        authenticated: false,
        mode: 'local',
        setupRequired: true,
        username: 'operator',
      },
    });
    expect(result.failure).toBe('setup_required');
    expect(Object.keys(result)).toEqual(['bootstrap']);
    expect(JSON.stringify(result)).not.toContain('failure');
    expect(h.limiter.consume).not.toHaveBeenCalled();
    expect(h.credentials.verify).not.toHaveBeenCalled();
  });

  it('rejects setup outside local mode before credential or limiter work', async () => {
    const h = setup('none');

    await expect(
      h.service.setup({ password: 'password-password', address: '127.0.0.1' }),
    ).rejects.toThrow('Authentication operation failed');
    expect(h.credentials.isInitialized).not.toHaveBeenCalled();
    expect(h.credentials.enroll).not.toHaveBeenCalled();
    expect(h.limiter.consume).not.toHaveBeenCalled();
  });

  it('returns hidden already-initialized setup failure before consuming limiter capacity', async () => {
    const h = setup('local');

    const result = await h.service.setup({
      password: 'password-password',
      address: '127.0.0.1',
    });

    expect(result).toEqual({
      bootstrap: { authenticated: false, mode: 'local' },
    });
    expect(result.failure).toBe('already_initialized');
    expect(Object.keys(result)).toEqual(['bootstrap']);
    expect(JSON.stringify(result)).not.toContain('failure');
    expect(h.credentials.enroll).not.toHaveBeenCalled();
    expect(h.limiter.consume).not.toHaveBeenCalled();
  });

  it('enrolls the configured local username and establishes a normal session', async () => {
    const h = setup('local', { localUsername: 'operator' });
    let initialized = false;
    h.credentials.isInitialized.mockImplementation(() => initialized);
    h.credentials.enroll.mockImplementation(async () => {
      initialized = true;
      return { outcome: 'enrolled', persistence: 'committed' };
    });

    const result = await h.service.setup({
      password: 'password-password',
      address: '127.0.0.1',
    });

    expect(result.bootstrap).toMatchObject({
      authenticated: true,
      mode: 'local',
      identityLabel: 'operator',
    });
    expect(h.service.authenticateCookie(result.cookieValue)).toMatchObject({
      identityLabel: 'operator',
    });
    expect(h.credentials.enroll).toHaveBeenCalledWith('password-password');
    expect(h.limiter.consume).toHaveBeenCalledWith('127.0.0.1');
    expect(h.limiter.resetAddress).toHaveBeenCalledWith('127.0.0.1');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.bootstrap)).toBe(true);
  });

  it('admits concurrent claims but lets credential serialization select exactly one winner', async () => {
    const h = setup('local', { maxSessions: 2 });
    let initialized = false;
    const firstEnrollment = deferred<void>();
    h.credentials.isInitialized.mockImplementation(() => initialized);
    h.credentials.enroll.mockImplementationOnce(async () => {
      await firstEnrollment.promise;
      initialized = true;
      return { outcome: 'enrolled', persistence: 'committed' };
    });
    h.credentials.enroll.mockImplementationOnce(async () => ({
      outcome: 'already_initialized',
    }));

    const first = h.service.setup({
      password: 'first-password',
      address: '127.0.0.1',
    });
    const second = h.service.setup({
      password: 'second-password',
      address: '127.0.0.2',
    });
    await Promise.resolve();
    expect(h.credentials.enroll).toHaveBeenCalledTimes(1);

    firstEnrollment.resolve();
    const [winner, loser] = await Promise.all([first, second]);

    expect(winner.bootstrap.authenticated).toBe(true);
    expect(loser).toEqual({
      bootstrap: { authenticated: false, mode: 'local' },
    });
    expect(loser.failure).toBe('already_initialized');
    expect(h.credentials.enroll).toHaveBeenCalledTimes(2);
    expect(h.limiter.consume).toHaveBeenCalledTimes(2);
    expect(h.random).toHaveBeenCalledTimes(2);
  });

  it('returns rate-limited for limiter rejection and bounded setup overflow', async () => {
    const rejected = setup('local');
    rejected.credentials.isInitialized.mockReturnValue(false);
    rejected.limiter.consume.mockReturnValue(false);
    const denied = await rejected.service.setup({
      password: 'password-password',
      address: '127.0.0.1',
    });
    expect(denied.failure).toBe('rate_limited');
    expect(rejected.credentials.enroll).not.toHaveBeenCalled();

    const bounded = setup('local', { maxSessions: 1 });
    const enrollment = deferred<{
      outcome: 'enrolled';
      persistence: 'committed';
    }>();
    bounded.credentials.isInitialized.mockReturnValue(false);
    bounded.credentials.enroll.mockReturnValueOnce(enrollment.promise);
    const admitted = bounded.service.setup({
      password: 'first-password',
      address: '127.0.0.1',
    });
    const overflow = await bounded.service.setup({
      password: 'second-password',
      address: '127.0.0.2',
    });
    expect(overflow.failure).toBe('rate_limited');
    expect(bounded.limiter.consume).toHaveBeenCalledOnce();

    enrollment.resolve({ outcome: 'enrolled', persistence: 'committed' });
    await expect(admitted).resolves.toMatchObject({
      bootstrap: { authenticated: true, mode: 'local' },
    });
  });

  it.each(['not_committed', 'exception'] as const)(
    'contains an enrollment %s and permits the next admitted claim',
    async (failure) => {
      const h = setup('local', { maxSessions: 2 });
      let initialized = false;
      h.credentials.isInitialized.mockImplementation(() => initialized);
      if (failure === 'not_committed') {
        h.credentials.enroll.mockResolvedValueOnce({
          outcome: 'not_committed',
        });
      } else {
        h.credentials.enroll.mockRejectedValueOnce(
          new Error('hashing /secret failed'),
        );
      }
      h.credentials.enroll.mockImplementationOnce(async () => {
        initialized = true;
        return { outcome: 'enrolled', persistence: 'committed' };
      });

      const first = h.service.setup({
        password: 'first-password',
        address: '127.0.0.1',
      });
      const second = h.service.setup({
        password: 'second-password',
        address: '127.0.0.2',
      });

      await expect(first).rejects.toMatchObject({
        message: 'Authentication operation failed',
      });
      const recovered = await second;
      expect(recovered.bootstrap.authenticated).toBe(true);
      expect(h.service.authenticateCookie(recovered.cookieValue)).toBeDefined();
      expect(h.credentials.enroll).toHaveBeenCalledTimes(2);
    },
  );

  it('warns exactly once without arguments and authenticates after uncertain credential durability', async () => {
    const warning = vi.fn();
    const h = setup('local', { onDurabilityUncertain: warning });
    h.credentials.isInitialized.mockReturnValue(false);
    h.credentials.enroll.mockResolvedValueOnce({
      outcome: 'enrolled',
      persistence: 'committed_durability_uncertain',
    });

    const result = await h.service.setup({
      password: 'password-password',
      address: '127.0.0.1',
    });

    expect(result.bootstrap.authenticated).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith();
  });

  it('keeps committed credentials after session preparation fails and allows normal login', async () => {
    let initialized = false;
    let enrolledPassword = '';
    let randomCalls = 0;
    const credentials = {
      isInitialized: vi.fn(() => initialized),
      enroll: vi.fn(async (password: string) => {
        initialized = true;
        enrolledPassword = password;
        return {
          outcome: 'enrolled' as const,
          persistence: 'committed' as const,
        };
      }),
      verify: vi.fn(async (username: string, password: string) =>
        Boolean(
          initialized && username === 'admin' && password === enrolledPassword,
        ),
      ),
      replacePassword: vi.fn(),
    };
    const service = new AuthService({
      mode: 'local',
      localUsername: 'admin',
      onDurabilityUncertain: vi.fn(),
      clock: () => 0,
      randomBytes: (size) => {
        randomCalls += 1;
        if (randomCalls === 1) throw new Error('random failed');
        return Buffer.alloc(size, randomCalls);
      },
      credentialStore: credentials,
      csrfService: new CsrfService(),
      rateLimiter: { consume: vi.fn(() => true), resetAddress: vi.fn() },
      idleDurationMs: 100,
      absoluteDurationMs: 1000,
      maxSessions: 1,
    });

    await expect(
      service.setup({
        password: 'password-password',
        address: '127.0.0.1',
      }),
    ).rejects.toThrow('Authentication operation failed');
    expect(initialized).toBe(true);
    expect(credentials.enroll).toHaveBeenCalledOnce();

    const loggedIn = await service.login(login());
    expect(loggedIn.bootstrap.authenticated).toBe(true);
    expect(service.authenticateCookie(loggedIn.cookieValue)).toBeDefined();
    expect(credentials.enroll).toHaveBeenCalledOnce();
  });

  it('denies a login burst immediately while one admitted verification is unresolved', async () => {
    const firstVerification = deferred<boolean>();
    const secondVerification = deferred<boolean>();
    const verify = vi
      .fn()
      .mockReturnValueOnce(firstVerification.promise)
      .mockReturnValueOnce(secondVerification.promise);
    let randomByte = 1;
    const random = vi.fn((size: number) => Buffer.alloc(size, randomByte++));
    const csrf = new CsrfService({
      randomBytes: (size) => Buffer.alloc(size, 2),
    });
    const createCsrf = vi.spyOn(csrf, 'create');
    const limiter = new LoginRateLimiter({
      clock: () => 0,
      global: { capacity: 2, refillPerSecond: 0 },
      address: { capacity: 1, refillPerSecond: 0 },
      maxAddresses: 2,
    });
    const service = new AuthService({
      mode: 'local',
      clock: () => 0,
      randomBytes: random,
      credentialStore: {
        isInitialized: vi.fn(() => true),
        enroll: vi.fn(),
        verify,
        replacePassword: vi.fn(),
      },
      localUsername: 'admin',
      onDurabilityUncertain: vi.fn(),
      csrfService: csrf,
      rateLimiter: limiter,
      idleDurationMs: 100,
      absoluteDurationMs: 1000,
      maxSessions: 2,
    });

    const firstAdmitted = service.login(login());
    const denied = [service.login(login())];
    const secondAdmitted = service.login({
      ...login(),
      address: '127.0.0.2',
    });
    denied.push(
      ...Array.from({ length: 32 }, (_, index) =>
        service.login({
          ...login(),
          address: index % 2 === 0 ? '127.0.0.1' : '127.0.0.2',
        }),
      ),
    );
    const settled: boolean[] = [];
    for (const attempt of denied)
      void attempt.then((result) =>
        settled.push(result.bootstrap.authenticated),
      );
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toHaveLength(denied.length);
    expect(settled).not.toContain(true);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(random).not.toHaveBeenCalled();
    expect(createCsrf).not.toHaveBeenCalled();
    expect(limiter.trackedAddressCount()).toBeLessThanOrEqual(2);

    firstVerification.resolve(true);
    secondVerification.resolve(true);
    const [first, second] = await Promise.all([firstAdmitted, secondAdmitted]);
    expect(service.authenticateCookie(first.cookieValue)).toBeDefined();
    expect(service.authenticateCookie(second.cookieValue)).toBeDefined();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(random).toHaveBeenCalledTimes(4);
    expect(createCsrf).toHaveBeenCalledTimes(2);
  });

  it('reserves admitted login commits in FIFO order without preparing secrets early', async () => {
    const h = setup('local', { maxSessions: 2 });
    const firstVerification = deferred<boolean>();
    h.credentials.verify
      .mockReturnValueOnce(firstVerification.promise)
      .mockResolvedValueOnce(true);
    const createCsrf = vi.spyOn(h.csrf, 'create');
    const settled: string[] = [];

    const first = h.service
      .login(login())
      .then((result) => (settled.push('first'), result));
    const second = h.service
      .login({ ...login(), address: '127.0.0.2' })
      .then((result) => (settled.push('second'), result));
    await Promise.resolve();
    await Promise.resolve();

    expect(h.credentials.verify).toHaveBeenCalledTimes(2);
    expect(settled).toEqual([]);
    expect(h.random).not.toHaveBeenCalled();
    expect(createCsrf).not.toHaveBeenCalled();

    firstVerification.resolve(true);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(settled).toEqual(['first', 'second']);
    expect(h.service.authenticateCookie(firstResult.cookieValue)).toBeDefined();
    expect(
      h.service.authenticateCookie(secondResult.cookieValue),
    ).toBeDefined();
    expect(h.random).toHaveBeenCalledTimes(4);
    expect(createCsrf).toHaveBeenCalledTimes(2);
  });

  it('caps pending logins before limiter admission and recovers after settlement', async () => {
    let now = 0;
    let byte = 1;
    const firstVerification = deferred<boolean>();
    const verify = vi
      .fn()
      .mockReturnValueOnce(firstVerification.promise)
      .mockResolvedValueOnce(true);
    const limiter = new LoginRateLimiter({
      clock: () => now,
      global: { capacity: 1, refillPerSecond: 1 },
      address: { capacity: 1, refillPerSecond: 1 },
      maxAddresses: 2,
    });
    const consume = vi.spyOn(limiter, 'consume');
    const service = new AuthService({
      mode: 'local',
      clock: () => now,
      randomBytes: (size) => Buffer.alloc(size, byte++),
      credentialStore: {
        isInitialized: vi.fn(() => true),
        enroll: vi.fn(),
        verify,
        replacePassword: vi.fn(),
      },
      localUsername: 'admin',
      onDurabilityUncertain: vi.fn(),
      csrfService: new CsrfService(),
      rateLimiter: limiter,
      idleDurationMs: 100,
      absoluteDurationMs: 1000,
      maxSessions: 1,
    });

    const pending = service.login(login());
    now = 1000;
    const denied = await service.login({
      ...login(),
      address: '127.0.0.2',
    });
    expect(denied.bootstrap.authenticated).toBe(false);
    expect(denied.failure).toBe('rate_limited');
    expect(consume).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();

    firstVerification.resolve(false);
    expect((await pending).bootstrap.authenticated).toBe(false);
    now = 2000;
    const recovered = await service.login({
      ...login(),
      address: '127.0.0.2',
    });
    expect(recovered.bootstrap.authenticated).toBe(true);
    expect(consume).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it.each(['invalid', 'throwing'] as const)(
    'lets a second FIFO login recover after an %s head verification',
    async (outcome) => {
      const h = setup('local', { maxSessions: 2 });
      const firstVerification = deferred<boolean>();
      h.credentials.verify
        .mockReturnValueOnce(firstVerification.promise)
        .mockResolvedValueOnce(true);
      const first = h.service.login(login());
      let secondSettled = false;
      const second = h.service
        .login({ ...login(), address: '127.0.0.2' })
        .then((result) => {
          secondSettled = true;
          return result;
        });
      await Promise.resolve();
      await Promise.resolve();
      const settledBeforeHead = secondSettled;
      const secretsPreparedBeforeHead = h.random.mock.calls.length;

      if (outcome === 'invalid') firstVerification.resolve(false);
      else firstVerification.reject(new Error('verification failure'));
      if (outcome === 'invalid')
        expect((await first).bootstrap.authenticated).toBe(false);
      else
        await expect(first).rejects.toThrow('Authentication operation failed');
      const recovered = await second;

      expect(settledBeforeHead).toBe(false);
      expect(secretsPreparedBeforeHead).toBe(0);
      expect(recovered.bootstrap.authenticated).toBe(true);
      expect(h.service.authenticateCookie(recovered.cookieValue)).toBeDefined();
    },
  );

  it('handles a queued verification rejection immediately without breaking FIFO', async () => {
    const h = setup('local', { maxSessions: 3 });
    const firstVerification = deferred<boolean>();
    h.credentials.verify
      .mockReturnValueOnce(firstVerification.promise)
      .mockRejectedValueOnce(new Error('verification failure'));
    let unhandledRejections = 0;
    let rejectionHandledEvents = 0;
    const onUnhandled = () => {
      unhandledRejections += 1;
    };
    const onHandled = () => {
      rejectionHandledEvents += 1;
    };
    process.on('unhandledRejection', onUnhandled);
    process.on('rejectionHandled', onHandled);

    try {
      const settled: string[] = [];
      const first = h.service
        .login(login())
        .then((result) => (settled.push('first'), result));
      const second = h.service.login({ ...login(), address: '127.0.0.2' }).then(
        (result) => (settled.push('second'), result),
        (error: unknown) => {
          settled.push('second_failed');
          throw error;
        },
      );
      void second.catch(() => undefined);
      await flushRejectionEvents();
      const settledBeforeFirst = [...settled];

      firstVerification.resolve(true);
      const firstResult = await first;
      await expect(second).rejects.toThrow('Authentication operation failed');
      await flushRejectionEvents();
      const later = await h.service.login({
        ...login(),
        address: '127.0.0.3',
      });

      expect(settledBeforeFirst).toEqual([]);
      expect(settled).toEqual(['first', 'second_failed']);
      expect(
        h.service.authenticateCookie(firstResult.cookieValue),
      ).toBeDefined();
      expect(h.service.authenticateCookie(later.cookieValue)).toBeDefined();
      expect(unhandledRejections).toBe(0);
      expect(rejectionHandledEvents).toBe(0);
    } finally {
      firstVerification.resolve(true);
      process.off('unhandledRejection', onUnhandled);
      process.off('rejectionHandled', onHandled);
    }
  });

  it('contains synchronous verification throws inside their FIFO slot', async () => {
    const h = setup('local', { maxSessions: 2 });
    h.credentials.verify.mockImplementationOnce(() => {
      throw new Error('synchronous verification failure');
    });

    const failed = h.service.login(login());
    const recovered = h.service.login({
      ...login(),
      address: '127.0.0.2',
    });
    await expect(failed).rejects.toThrow('Authentication operation failed');
    const result = await recovered;
    expect(h.service.authenticateCookie(result.cookieValue)).toBeDefined();
    await expect(
      h.service.login({ ...login(), address: '127.0.0.3' }),
    ).resolves.toMatchObject({
      bootstrap: { authenticated: true, mode: 'local' },
    });
  });

  it('reserves the original login slot before synchronous verifier reentry', async () => {
    let reenter = false;
    let reentered = false;
    let byte = 1;
    const settled: string[] = [];
    let reentrantBootstrap!: Promise<unknown>;
    let reentrantLogin!: Promise<Awaited<ReturnType<AuthService['login']>>>;
    const credentials = {
      isInitialized: vi.fn(() => true),
      enroll: vi.fn(),
      verify: vi.fn(() => {
        if (reenter && !reentered) {
          reentered = true;
          reentrantBootstrap = service
            .bootstrap({ type: 'none' })
            .then((result) => (settled.push('bootstrap'), result));
          reentrantLogin = service
            .login({ ...login(), address: '127.0.0.4' })
            .then((result) => (settled.push('reentrant'), result));
        }
        return true;
      }),
      replacePassword: vi.fn(),
    };
    const service = new AuthService({
      mode: 'local',
      localUsername: 'admin',
      onDurabilityUncertain: vi.fn(),
      clock: () => 0,
      randomBytes: (size) => Buffer.alloc(size, byte++),
      credentialStore: credentials,
      csrfService: new CsrfService({
        randomBytes: (size) => Buffer.alloc(size, byte++),
      }),
      rateLimiter: { consume: vi.fn(() => true), resetAddress: vi.fn() },
      idleDurationMs: 100,
      absoluteDurationMs: 1000,
      maxSessions: 2,
    });
    const firstSeed = await service.login(login());
    const secondSeed = await service.login({
      ...login(),
      address: '127.0.0.2',
    });
    const revoked = vi.fn();
    service.onRevoked(revoked);
    let unhandledRejections = 0;
    const onUnhandled = () => {
      unhandledRejections += 1;
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      reenter = true;
      const original = service
        .login({ ...login(), address: '127.0.0.3' })
        .then((result) => (settled.push('original'), result));
      const [originalResult, reentrantResult] = await Promise.all([
        original,
        reentrantLogin,
        reentrantBootstrap,
      ]).then(([outer, inner]) => [outer, inner] as const);
      await flushRejectionEvents();

      expect(settled).toEqual(['original', 'bootstrap', 'reentrant']);
      expect(service.authenticateCookie(firstSeed.cookieValue)).toBeUndefined();
      expect(
        service.authenticateCookie(secondSeed.cookieValue),
      ).toBeUndefined();
      expect(
        service.authenticateCookie(originalResult.cookieValue),
      ).toBeDefined();
      expect(
        service.authenticateCookie(reentrantResult.cookieValue),
      ).toBeDefined();
      expect(revoked.mock.calls).toEqual([
        [expect.any(String), 'capacity'],
        [expect.any(String), 'capacity'],
      ]);
      expect(unhandledRejections).toBe(0);

      await expect(
        service.login({ ...login(), address: '127.0.0.5' }),
      ).resolves.toMatchObject({
        bootstrap: { authenticated: true, mode: 'local' },
      });
      expect(credentials.verify).toHaveBeenCalledTimes(5);
      expect(revoked).toHaveBeenCalledTimes(3);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('bounds bootstrap slots behind an unresolved admitted login', async () => {
    const h = setup('local', { maxSessions: 1 });
    const verification = deferred<boolean>();
    h.credentials.verify.mockReturnValueOnce(verification.promise);
    const createCsrf = vi.spyOn(h.csrf, 'create');
    const loginResult = h.service.login(login());
    const bootstraps = Array.from({ length: 12 }, () =>
      h.service.bootstrap({ type: 'none' }),
    );
    const observed = bootstraps.map((bootstrap) =>
      bootstrap.then(
        () => 'fulfilled' as const,
        (error: unknown) =>
          error instanceof Error ? error.message : 'unknown error',
      ),
    );
    await Promise.resolve();
    await Promise.resolve();

    const immediate = await Promise.all(
      observed
        .slice(7)
        .map(async (outcome) =>
          Promise.race([outcome, Promise.resolve('pending' as const)]),
        ),
    );
    expect(immediate).toEqual(Array(5).fill('Authentication operation failed'));
    expect(h.random).not.toHaveBeenCalled();
    expect(createCsrf).not.toHaveBeenCalled();

    verification.resolve(true);
    const established = await loginResult;
    const outcomes = await Promise.all(observed);
    expect(outcomes.slice(0, 7)).toEqual(Array(7).fill('fulfilled'));
    expect(outcomes.slice(7)).toEqual(
      Array(5).fill('Authentication operation failed'),
    );
    expect(h.service.authenticateCookie(established.cookieValue)).toBeDefined();
    expect(h.random).toHaveBeenCalledTimes(2);
    expect(createCsrf).toHaveBeenCalledOnce();
    await expect(h.service.bootstrap({ type: 'none' })).resolves.toMatchObject({
      bootstrap: { authenticated: false, mode: 'local' },
    });
  });

  it('bounds a bootstrap-only flood before preparing secrets', async () => {
    const h = setup('none', { maxSessions: 2 });
    const createCsrf = vi.spyOn(h.csrf, 'create');
    const attempts = Array.from({ length: 12 }, () =>
      h.service.bootstrap({ type: 'none' }),
    );
    expect(h.random).not.toHaveBeenCalled();
    expect(createCsrf).not.toHaveBeenCalled();

    const outcomes = await Promise.allSettled(attempts);
    const fulfilled = outcomes.filter(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        Awaited<(typeof attempts)[number]>
      > => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(8);
    expect(rejected).toHaveLength(4);
    expect(rejected.map((outcome) => outcome.reason)).toEqual(
      Array(4).fill(
        expect.objectContaining({ message: 'Authentication operation failed' }),
      ),
    );
    expect(h.random).toHaveBeenCalledTimes(16);
    expect(createCsrf).toHaveBeenCalledTimes(8);
    const results = fulfilled.map((outcome) => outcome.value);
    for (const result of results.slice(0, -2))
      expect(h.service.authenticateCookie(result.cookieValue)).toBeUndefined();
    for (const result of results.slice(-2))
      expect(h.service.authenticateCookie(result.cookieValue)).toBeDefined();
    await expect(h.service.bootstrap({ type: 'none' })).resolves.toMatchObject({
      bootstrap: { authenticated: true, mode: 'none' },
    });
  });

  it('recovers the bounded bootstrap queue after a throwing head slot', async () => {
    let calls = 0;
    const service = new AuthService({
      mode: 'none',
      clock: () => 0,
      randomBytes: (size) => {
        calls += 1;
        if (calls === 1) throw new Error('random failure');
        return Buffer.alloc(size, calls);
      },
      credentialStore: {
        isInitialized: vi.fn(() => false),
        enroll: vi.fn(),
        verify: vi.fn(),
        replacePassword: vi.fn(),
      },
      csrfService: new CsrfService(),
      rateLimiter: { consume: vi.fn(), resetAddress: vi.fn() },
      idleDurationMs: 100,
      absoluteDurationMs: 1000,
      maxSessions: 2,
    });

    const first = service.bootstrap({ type: 'none' });
    const second = service.bootstrap({ type: 'none' });
    await expect(first).rejects.toThrow('Authentication operation failed');
    await expect(second).resolves.toMatchObject({
      bootstrap: { authenticated: true, mode: 'none' },
    });
    await expect(service.bootstrap({ type: 'none' })).resolves.toMatchObject({
      bootstrap: { authenticated: true, mode: 'none' },
    });
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
    await expect(
      none.service.bootstrap({
        type: 'upstream',
        identity: { mode: 'trusted-header', identityLabel: 'user' },
      }),
    ).rejects.toThrow('Authentication operation failed');
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

  it('captures immutable websocket authority and rejects stale authority touches', async () => {
    const h = setup('none', { idleDurationMs: 10, absoluteDurationMs: 25 });
    const result = await h.service.bootstrap({ type: 'none' });
    const authority = h.service.authenticateAuthority(result.cookieValue)!;

    expect(Object.isFrozen(authority)).toBe(true);
    expect(authority.generation).toBeGreaterThan(0);
    expect(
      h.service.isActiveAuthority(authority.id, authority.generation),
    ).toBe(true);
    h.time.now = 5;
    expect(
      h.service.touchAuthority(
        authority.id,
        authority.generation,
        'terminal_input',
      ),
    ).toBe(true);
    expect(
      h.service.authenticateCookie(result.cookieValue)?.idleExpiresAt,
    ).toBe(15);

    h.service.logout(authority.id);
    expect(
      h.service.isActiveAuthority(authority.id, authority.generation),
    ).toBe(false);
    expect(
      h.service.touchAuthority(
        authority.id,
        authority.generation,
        'terminal_input',
      ),
    ).toBe(false);
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

  it.each([
    ['local', undefined],
    ['none', undefined],
    ['cloudflare-access', 80],
    ['trusted-header', undefined],
  ] as const)(
    'resumes a %s session by rotating only its CSRF authority',
    async (mode, expiresAt) => {
      const h = setup(mode);
      const established =
        mode === 'local'
          ? await h.service.login(login())
          : await h.service.bootstrap(
              mode === 'none'
                ? { type: 'none' }
                : {
                    type: 'upstream',
                    identity: {
                      mode,
                      identityLabel: 'person',
                      ...(expiresAt === undefined ? {} : { expiresAt }),
                    },
                  },
            );
      const prior = h.service.authenticateCookie(established.cookieValue)!;
      const priorToken = established.bootstrap.authenticated
        ? established.bootstrap.csrfToken
        : undefined;
      h.time.now = 10;

      const resumed = h.service.resume(prior.id)!;

      expect(resumed).not.toHaveProperty('cookieValue');
      expect(resumed.bootstrap).toMatchObject({
        authenticated: true,
        mode,
        identityLabel:
          mode === 'none' ? 'anonymous' : mode === 'local' ? 'admin' : 'person',
      });
      expect(h.service.authenticateCookie(established.cookieValue)).toEqual(
        prior,
      );
      expect(h.service.verifyCsrf(prior.id, priorToken)).toBe(false);
      expect(
        h.service.verifyCsrf(
          prior.id,
          resumed.bootstrap.authenticated
            ? resumed.bootstrap.csrfToken
            : undefined,
        ),
      ).toBe(true);
      expect(Object.isFrozen(resumed)).toBe(true);
      expect(Object.isFrozen(resumed.bootstrap)).toBe(true);
    },
  );

  it('expires and revokes a stale session before resume', async () => {
    const h = setup('none', { idleDurationMs: 5 });
    const revoked = vi.fn();
    h.service.onRevoked(revoked);
    const established = await h.service.bootstrap({ type: 'none' });
    const session = h.service.authenticateCookie(established.cookieValue)!;
    h.time.now = 5;

    expect(h.service.resume(session.id)).toBeUndefined();
    expect(h.service.resume(session.id)).toBeUndefined();
    expect(revoked).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledWith(session.id, 'idle');
  });

  it('keeps the prior CSRF authority when resume preparation fails', async () => {
    let csrfCalls = 0;
    class FailingCsrfService extends CsrfService {
      override create() {
        csrfCalls += 1;
        if (csrfCalls === 2) throw new Error('csrf failure');
        return super.create();
      }
    }
    let byte = 1;
    const csrf = new FailingCsrfService({
      randomBytes: (size) => Buffer.alloc(size, byte++),
    });
    const service = new AuthService({
      mode: 'none',
      clock: () => 0,
      randomBytes: (size) => Buffer.alloc(size, byte++),
      credentialStore: {
        isInitialized: vi.fn(() => false),
        enroll: vi.fn(),
        verify: vi.fn(),
        replacePassword: vi.fn(),
      },
      csrfService: csrf,
      rateLimiter: { consume: vi.fn(() => true), resetAddress: vi.fn() },
      idleDurationMs: 100,
      absoluteDurationMs: 1_000,
      maxSessions: 1,
    });
    const established = await service.bootstrap({ type: 'none' });
    const session = service.authenticateCookie(established.cookieValue)!;
    const token = established.bootstrap.authenticated
      ? established.bootstrap.csrfToken
      : undefined;

    expect(() => service.resume(session.id)).toThrow(
      'Authentication operation failed',
    );
    expect(service.authenticateCookie(established.cookieValue)).toEqual(
      session,
    );
    expect(service.verifyCsrf(session.id, token)).toBe(true);
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

  it('rejects a concurrent password change immediately without calling credentials', async () => {
    const h = setup('local');
    h.credentials.verify.mockResolvedValueOnce(true);
    const result = await h.service.login(login());
    const id = h.service.authenticateCookie(result.cookieValue)!.id;
    const gate = deferred<boolean>();
    h.credentials.verify.mockClear();
    h.credentials.verify.mockReturnValueOnce(gate.promise);
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
    let secondResult: boolean | undefined;
    void second.then((value) => {
      secondResult = value;
    });
    await Promise.resolve();
    await Promise.resolve();
    const rejectedWhileFirstPending = secondResult;

    gate.resolve(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(rejectedWhileFirstPending).toBe(false);
    expect(h.credentials.verify).toHaveBeenCalledOnce();
    expect(h.credentials.replacePassword).toHaveBeenCalledOnce();
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it('clears password change single-flight state after credential failure', async () => {
    const h = setup('local');
    const loginResult = await h.service.login(login());
    const id = h.service.authenticateCookie(loginResult.cookieValue)!.id;
    const gate = deferred<boolean>();
    h.credentials.verify.mockClear();
    h.credentials.verify.mockReturnValueOnce(gate.promise);

    const failed = h.service.changePassword(
      id,
      'old-password-value',
      'failed-replacement',
    );
    const concurrent = h.service.changePassword(
      id,
      'old-password-value',
      'retained-replacement',
    );
    let concurrentResult: boolean | undefined;
    void concurrent.then((value) => {
      concurrentResult = value;
    });
    await Promise.resolve();
    await Promise.resolve();
    const rejectedWhileFirstPending = concurrentResult;
    gate.reject(new Error('credential failure'));

    await expect(failed).rejects.toThrow('Authentication operation failed');
    await expect(concurrent).resolves.toBe(false);
    expect(rejectedWhileFirstPending).toBe(false);
    h.credentials.verify.mockResolvedValueOnce(true);
    h.credentials.replacePassword.mockResolvedValueOnce({ state: 'committed' });
    await expect(
      h.service.changePassword(
        id,
        'old-password-value',
        'successful-replacement',
      ),
    ).resolves.toBe(true);
  });

  it('revokes every local session exactly once after a password change', async () => {
    const h = setup('local', { maxSessions: 4 });
    const sessions = await Promise.all([
      h.service.login(login()),
      h.service.login(login()),
      h.service.login(login()),
    ]);
    const ids = sessions.map(
      (result) => h.service.authenticateCookie(result.cookieValue)!.id,
    );
    const revoked = vi.fn();
    h.service.onRevoked(revoked);

    await expect(
      h.service.changePassword(
        ids[0]!,
        'old-password-value',
        'replacement-password',
      ),
    ).resolves.toBe(true);

    for (const result of sessions)
      expect(h.service.authenticateCookie(result.cookieValue)).toBeUndefined();
    expect(revoked.mock.calls).toEqual(
      ids.map((id) => [id, 'password_changed']),
    );
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
        isInitialized: vi.fn(() => true),
        enroll: vi.fn(),
        verify: vi.fn(async () => true),
        replacePassword: vi.fn(),
      },
      localUsername: 'admin',
      onDurabilityUncertain: vi.fn(),
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
        isInitialized: vi.fn(() => true),
        enroll: vi.fn(),
        verify: vi.fn(async () => true),
        replacePassword: vi.fn(),
      },
      localUsername: 'admin',
      onDurabilityUncertain: vi.fn(),
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
    localUsername: string;
    onDurabilityUncertain: () => void;
  }> = {},
) {
  const time = { now: 0 };
  let byte = 1;
  const credentials = {
    isInitialized: vi.fn(() => true),
    enroll: vi.fn(async (): Promise<EnrollmentResult> => ({
      outcome: 'enrolled',
      persistence: 'committed',
    })),
    verify: vi.fn(async () => true),
    replacePassword: vi.fn(async () => ({ state: 'committed' as const })),
  };
  const limiter = { consume: vi.fn(() => true), resetAddress: vi.fn() };
  const random = vi.fn((size: number) => Buffer.alloc(size, byte++));
  const csrf = new CsrfService({
    randomBytes: (size) => Buffer.alloc(size, byte++),
  });
  const options = {
    clock: () => time.now,
    randomBytes: random,
    credentialStore: credentials,
    csrfService: csrf,
    rateLimiter: limiter,
    idleDurationMs: overrides.idleDurationMs ?? 100,
    absoluteDurationMs: overrides.absoluteDurationMs ?? 1000,
    maxSessions: overrides.maxSessions ?? 4,
    ...(overrides.maxObservers === undefined
      ? {}
      : { maxObservers: overrides.maxObservers }),
  };
  const service =
    mode === 'local'
      ? new AuthService({
          ...options,
          mode,
          localUsername: overrides.localUsername ?? 'admin',
          onDurabilityUncertain: overrides.onDurabilityUncertain ?? vi.fn(),
        })
      : new AuthService({ ...options, mode });
  return { service, credentials, limiter, time, random, csrf };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function flushRejectionEvents() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}
