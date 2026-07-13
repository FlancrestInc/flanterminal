// @vitest-environment jsdom

import type { AuthBootstrap } from '@flanterminal/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthApiError, type AuthApi } from './auth-api.js';
import { useAuth } from './useAuth.js';

const localRequired: AuthBootstrap = { authenticated: false, mode: 'local' };
const localSession: AuthBootstrap = {
  authenticated: true,
  mode: 'local',
  identityLabel: 'operator',
  csrfToken: 'csrf-local',
};
const upstreamSession: AuthBootstrap = {
  authenticated: true,
  mode: 'cloudflare-access',
  identityLabel: 'person@example.com',
  csrfToken: 'csrf-upstream',
  upstreamExpiresAt: '2026-07-13T18:02:00.000Z',
};
const trustedSession: AuthBootstrap = {
  authenticated: true,
  mode: 'trusted-header',
  identityLabel: 'trusted-operator',
  csrfToken: 'csrf-trusted',
};
const TRUSTED_REFRESH_MS = 4 * 60_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeApi(bootstrap: AuthBootstrap | Promise<AuthBootstrap>): AuthApi {
  return {
    bootstrap: vi.fn(async () => await bootstrap),
    login: vi.fn(async () => localSession),
    refresh: vi.fn(async () => upstreamSession),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
  };
}

async function flushAuth() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-07-13T18:00:00.000Z') });
});

afterEach(() => vi.useRealTimers());

describe('useAuth', () => {
  it.each([
    localRequired,
    { ...localSession, mode: 'none' as const, csrfToken: 'csrf-none' },
  ])('bootstraps the strict server authentication state %#', async (state) => {
    const currentApi = fakeApi(state);
    const { result } = renderHook(() => useAuth(currentApi));
    await flushAuth();
    expect(result.current.bootstrap).toEqual(state);
  });

  it.each(['cloudflare-access', 'trusted-header'] as const)(
    'keeps an unauthenticated %s bootstrap on the retry-only access surface',
    async (mode) => {
      const currentApi = fakeApi({ authenticated: false, mode });
      const { result } = renderHook(() => useAuth(currentApi));
      await flushAuth();

      expect(result.current.status).toBe('access-error');
      expect(result.current.error).toBe('Access could not be verified.');
    },
  );

  it('logs in locally without retaining credentials or writing browser storage', async () => {
    const api = fakeApi(localRequired);
    const localStorageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();

    await act(async () => {
      await result.current.login('operator', 'private-password');
    });

    expect(api.login).toHaveBeenCalledWith(
      { username: 'operator', password: 'private-password' },
      expect.any(AbortSignal),
    );
    expect(result.current.status).toBe('authenticated');
    expect(result.current.bootstrap).toEqual(localSession);
    expect(localStorageSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(result.current)).not.toContain('private-password');
  });

  it('maps local and upstream failures to bounded user states', async () => {
    const api = fakeApi(localRequired);
    vi.mocked(api.login).mockRejectedValue(
      new AuthApiError('authentication_failed', 401),
    );
    const { result, rerender } = renderHook(
      ({ currentApi }) => useAuth(currentApi),
      {
        initialProps: { currentApi: api },
      },
    );
    await flushAuth();
    await act(async () => {
      await result.current.login('operator', 'private-password');
    });
    expect(result.current.error).toBe('Sign-in failed.');
    expect(result.current.error).not.toContain('private-password');

    const accessApi = fakeApi(
      Promise.reject(new Error('Cf-Access-Jwt-Assertion private payload')),
    );
    rerender({ currentApi: accessApi });
    await flushAuth();
    expect(result.current.error).toBe('Access could not be verified.');
  });

  it('schedules one upstream refresh before expiry and replaces the CSRF token', async () => {
    const next: AuthBootstrap = {
      ...upstreamSession,
      csrfToken: 'csrf-next',
      upstreamExpiresAt: '2026-07-13T18:04:00.000Z',
    };
    const api = fakeApi(upstreamSession);
    vi.mocked(api.refresh).mockResolvedValue(next);
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();
    expect(vi.getTimerCount()).toBe(1);
    const authenticatedEpoch = result.current.epoch;

    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(api.refresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(api.refresh).toHaveBeenCalledWith(
      'csrf-upstream',
      expect.any(AbortSignal),
    );
    expect(result.current.bootstrap).toMatchObject({ csrfToken: 'csrf-next' });
    expect(result.current.epoch).toBe(authenticatedEpoch);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('refreshes an expiry-less trusted header identity before the minimum idle bound', async () => {
    const next: AuthBootstrap = {
      ...trustedSession,
      csrfToken: 'csrf-trusted-next',
    };
    const api = fakeApi(trustedSession);
    vi.mocked(api.refresh).mockResolvedValue(next);
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();

    expect(result.current.status).toBe('authenticated');
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(TRUSTED_REFRESH_MS - 1));
    expect(api.refresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(api.refresh).toHaveBeenCalledWith(
      'csrf-trusted',
      expect.any(AbortSignal),
    );
    expect(result.current.bootstrap).toEqual(next);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    localSession,
    {
      ...localSession,
      upstreamExpiresAt: '2026-07-13T18:04:00.000Z',
    },
    { ...localSession, mode: 'none' as const, csrfToken: 'csrf-none' },
    {
      ...localSession,
      mode: 'none' as const,
      csrfToken: 'csrf-none',
      upstreamExpiresAt: '2026-07-13T18:04:00.000Z',
    },
  ])(
    'does not schedule identity refresh for the authenticated %s mode',
    async (state) => {
      const currentApi = fakeApi(state);
      const { result } = renderHook(() => useAuth(currentApi));
      await flushAuth();

      expect(result.current.status).toBe('authenticated');
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => vi.advanceTimersByTimeAsync(TRUSTED_REFRESH_MS));
      expect(currentApi.refresh).not.toHaveBeenCalled();
    },
  );

  it('fails closed when expiry-less trusted header identity refresh fails', async () => {
    const api = fakeApi(trustedSession);
    vi.mocked(api.refresh).mockRejectedValue(
      new AuthApiError('authentication_failed', 401),
    );
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();

    await act(async () => vi.advanceTimersByTimeAsync(TRUSTED_REFRESH_MS));

    expect(result.current.status).toBe('access-error');
    expect(result.current.bootstrap).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending refresh synchronously when logout starts', async () => {
    const logout = deferred<void>();
    const api = fakeApi(trustedSession);
    vi.mocked(api.logout).mockImplementation(async () => await logout.promise);
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();
    await act(async () => vi.advanceTimersByTimeAsync(TRUSTED_REFRESH_MS - 1));

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.logout();
    });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(api.refresh).not.toHaveBeenCalled();

    logout.resolve();
    await act(async () => void (await operation));
    expect(result.current.status).toBe('access-error');
    expect(result.current.bootstrap).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight refresh before a successful password change wins', async () => {
    const refresh = deferred<AuthBootstrap>();
    const password = deferred<void>();
    let refreshSignal: AbortSignal | undefined;
    const api = fakeApi(trustedSession);
    vi.mocked(api.refresh).mockImplementation(async (_csrf, signal) => {
      refreshSignal = signal;
      return await refresh.promise;
    });
    vi.mocked(api.changePassword).mockImplementation(
      async () => await password.promise,
    );
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();
    await act(async () => vi.advanceTimersByTimeAsync(TRUSTED_REFRESH_MS));
    expect(api.refresh).toHaveBeenCalledOnce();

    let operation!: Promise<void>;
    act(() => {
      operation = result.current.changePassword('old-password', 'new-password');
    });
    expect(refreshSignal?.aborted).toBe(true);
    refresh.resolve({ ...trustedSession, csrfToken: 'stale-refresh' });
    await flushAuth();
    expect(result.current.bootstrap).toEqual(trustedSession);

    password.resolve();
    await act(async () => void (await operation));
    expect(result.current.status).toBe('access-error');
    expect(result.current.bootstrap).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('serializes duplicate explicit operations and resumes refresh after the authority fails', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const signals: AbortSignal[] = [];
    const api = fakeApi(trustedSession);
    vi.mocked(api.logout)
      .mockImplementationOnce(async (_csrf, signal) => {
        signals.push(signal!);
        return await first.promise;
      })
      .mockImplementationOnce(async (_csrf, signal) => {
        signals.push(signal!);
        return await second.promise;
      });
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();

    let firstOperation!: Promise<void>;
    let secondOperation!: Promise<void>;
    act(() => {
      firstOperation = result.current.logout();
      secondOperation = result.current.logout();
    });
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    first.resolve();
    await act(async () => void (await firstOperation));
    expect(result.current.status).toBe('authenticated');
    second.reject(new AuthApiError('operation_failed', 500));
    await act(async () => void (await secondOperation));

    expect(result.current.status).toBe('authenticated');
    expect(result.current.error).toBe('Unable to complete the request.');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('fails closed when upstream refresh loses identity and clears its timer', async () => {
    const api = fakeApi(upstreamSession);
    vi.mocked(api.refresh).mockRejectedValue(
      new AuthApiError('authentication_failed', 401),
    );
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(result.current.status).toBe('access-error');
    expect(result.current.bootstrap).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      ...upstreamSession,
      identityLabel: 'different@example.com',
      upstreamExpiresAt: '2026-07-13T18:04:00.000Z',
    },
    { ...upstreamSession },
    localRequired,
  ])('rejects an inconsistent upstream refresh response %#', async (next) => {
    const api = fakeApi(upstreamSession);
    vi.mocked(api.refresh).mockResolvedValue(next);
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(result.current.status).toBe('access-error');
    expect(result.current.bootstrap).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts private requests, clears CSRF, and transitions on any private 401', async () => {
    const request = deferred<Response>();
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal ?? undefined;
        return await request.promise;
      },
    );
    const currentApi = fakeApi(localSession);
    const { result } = renderHook(() =>
      useAuth(currentApi, { fetchImpl, basePath: '/terminal' }),
    );
    await flushAuth();

    let pending!: Promise<Response>;
    act(() => {
      pending = result.current.privateFetch('/terminal/api/tabs', {
        method: 'POST',
      });
    });
    expect(observedSignal?.aborted).toBe(false);
    request.resolve(
      Response.json({ error: 'authentication_required' }, { status: 401 }),
    );
    await act(async () => void (await pending));

    expect(observedSignal?.aborted).toBe(true);
    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.bootstrap).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores concurrent late 401 responses after disposing the local auth epoch', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'authentication_required' }, { status: 401 }),
    );
    const currentApi = fakeApi(localSession);
    const { result } = renderHook(() => useAuth(currentApi, { fetchImpl }));
    await flushAuth();

    await act(async () => {
      await Promise.allSettled([
        result.current.privateFetch('/api/first'),
        result.current.privateFetch('/api/second'),
      ]);
    });

    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.error).toBeNull();
    expect(result.current.bootstrap).toBeNull();
  });

  it('ignores an old epoch 401 after successful reauthentication', async () => {
    const oldRequest = deferred<Response>();
    let oldSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        oldSignal = init?.signal ?? undefined;
        return await oldRequest.promise;
      },
    );
    const replacement: AuthBootstrap = {
      ...localSession,
      csrfToken: 'csrf-replacement',
    };
    const currentApi = fakeApi(localSession);
    vi.mocked(currentApi.login).mockResolvedValue(replacement);
    const { result } = renderHook(() => useAuth(currentApi, { fetchImpl }));
    await flushAuth();
    let pending!: Promise<Response>;
    act(() => {
      pending = result.current.privateFetch('/api/old-private-request');
    });

    act(() => result.current.authenticationRequired());
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => {
      await result.current.login('operator', 'replacement-password');
    });
    expect(result.current.bootstrap).toEqual(replacement);

    oldRequest.resolve(
      Response.json({ error: 'authentication_required' }, { status: 401 }),
    );
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    expect(result.current.status).toBe('authenticated');
    expect(result.current.bootstrap).toEqual(replacement);
  });

  it('does not mutate a replacement auth epoch for late success or rejection', async () => {
    const oldSuccess = deferred<Response>();
    const oldFailure = deferred<Response>();
    const fetchImpl = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(async () => await oldSuccess.promise)
      .mockImplementationOnce(async () => await oldFailure.promise);
    const replacement: AuthBootstrap = {
      ...localSession,
      csrfToken: 'csrf-replacement',
    };
    const currentApi = fakeApi(localSession);
    vi.mocked(currentApi.login).mockResolvedValue(replacement);
    const { result } = renderHook(() => useAuth(currentApi, { fetchImpl }));
    await flushAuth();
    const success = result.current.privateFetch('/api/old-success');
    const failure = result.current.privateFetch('/api/old-failure');

    act(() => result.current.authenticationRequired());
    await act(async () => {
      await result.current.login('operator', 'replacement-password');
    });
    oldSuccess.resolve(new Response(null, { status: 204 }));
    oldFailure.reject(new Error('old private failure'));
    await act(async () => {
      await expect(success).rejects.toMatchObject({ name: 'AbortError' });
      await expect(failure).rejects.toMatchObject({ name: 'AbortError' });
    });

    expect(result.current.status).toBe('authenticated');
    expect(result.current.bootstrap).toEqual(replacement);
  });

  it('injects CSRF only into private mutations and composes caller cancellation', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init ?? {});
        return new Response(null, { status: 204 });
      },
    );
    const controller = new AbortController();
    const currentApi = fakeApi(localSession);
    const { result } = renderHook(() => useAuth(currentApi, { fetchImpl }));
    await flushAuth();

    await act(async () => {
      await result.current.privateFetch('/api/read', { method: 'GET' });
      await result.current.privateFetch('/api/write', {
        method: 'PATCH',
        headers: { 'X-Custom': 'yes' },
        signal: controller.signal,
      });
    });

    expect(new Headers(calls[0]!.headers).has('X-CSRF-Token')).toBe(false);
    expect(new Headers(calls[1]!.headers).get('X-CSRF-Token')).toBe(
      'csrf-local',
    );
    expect(new Headers(calls[1]!.headers).get('X-Custom')).toBe('yes');
    expect(calls[1]).toMatchObject({
      cache: 'no-store',
      credentials: 'include',
    });
    controller.abort();
    expect(calls[1]!.signal?.aborted).toBe(false);
  });

  it.each([
    'https://outside.example/terminal/api/tabs',
    '/outside/api/tabs',
    '/terminal/private/tabs',
    '/terminal/api/../private',
    '/terminal/api/%2e%2e/private',
    '/terminal/api/%2Foutside',
    '/terminal%2Fapi/tabs',
    '//outside.example/terminal/api/tabs',
  ])(
    'rejects private request URL outside the mounted API boundary: %s',
    async (url) => {
      window.history.replaceState({}, '', '/terminal/');
      const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
      const currentApi = fakeApi(localSession);
      const { result } = renderHook(() =>
        useAuth(currentApi, { fetchImpl, basePath: '/terminal' }),
      );
      await flushAuth();

      const error = await result.current
        .privateFetch(url, { method: 'POST' })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AuthApiError);
      expect(String(error)).toBe(
        'AuthApiError: Authentication request failed.',
      );
      expect(String(error)).not.toMatch(/csrf-local|outside|private|terminal/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['/terminal', '/terminal/api/tabs'],
    ['/', '/api/tabs'],
  ] as const)(
    'allows canonical private APIs beneath base path %s',
    async (basePath, url) => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
      const currentApi = fakeApi(localSession);
      const { result } = renderHook(() =>
        useAuth(currentApi, { fetchImpl, basePath }),
      );
      await flushAuth();

      await expect(result.current.privateFetch(url)).resolves.toMatchObject({
        status: 204,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('preserves Request semantics while init method and headers override the Request', async () => {
    window.history.replaceState({}, '', '/terminal/');
    const calls: Array<readonly [RequestInfo | URL, RequestInit | undefined]> =
      [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([input, init]);
        return new Response(null, { status: 204 });
      },
    );
    const currentApi = fakeApi(localSession);
    const { result } = renderHook(() =>
      useAuth(currentApi, { fetchImpl, basePath: '/terminal' }),
    );
    await flushAuth();
    const request = new Request('http://localhost:3000/terminal/api/tabs', {
      method: 'POST',
      headers: { 'X-Request': 'request-value' },
    });

    await result.current.privateFetch(request, {
      method: 'PATCH',
      headers: { 'X-Init': 'init-value' },
    });

    expect(calls[0]![0]).toBe(request);
    expect(calls[0]![1]?.method).toBe('PATCH');
    const headers = new Headers(calls[0]![1]?.headers);
    expect(headers.get('X-Request')).toBeNull();
    expect(headers.get('X-Init')).toBe('init-value');
    expect(headers.get('X-CSRF-Token')).toBe('csrf-local');
  });

  it.each(['request', 'init', 'epoch'] as const)(
    'aborts private fetch from the %s signal',
    async (source) => {
      window.history.replaceState({}, '', '/terminal/');
      const requestController = new AbortController();
      const initController = new AbortController();
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('cancelled', 'AbortError')),
              { once: true },
            );
          }),
      );
      const currentApi = fakeApi(localSession);
      const { result } = renderHook(() =>
        useAuth(currentApi, { fetchImpl, basePath: '/terminal' }),
      );
      await flushAuth();
      const request = new Request('http://localhost:3000/terminal/api/tabs', {
        signal: requestController.signal,
      });
      const pending = result.current.privateFetch(request, {
        signal: initController.signal,
      });

      if (source === 'request') requestController.abort();
      if (source === 'init') initController.abort();
      if (source === 'epoch')
        act(() => result.current.authenticationRequired());

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    },
  );

  it('removes composed abort listeners after private fetch settles', async () => {
    const requestController = new AbortController();
    const initController = new AbortController();
    const initAdd = vi.spyOn(initController.signal, 'addEventListener');
    const initRemove = vi.spyOn(initController.signal, 'removeEventListener');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const currentApi = fakeApi(localSession);
    const { result } = renderHook(() =>
      useAuth(currentApi, { fetchImpl, basePath: '/terminal' }),
    );
    await flushAuth();
    const request = new Request(`${window.location.origin}/terminal/api/tabs`, {
      signal: requestController.signal,
    });
    const requestAdd = vi.spyOn(request.signal, 'addEventListener');
    const requestRemove = vi.spyOn(request.signal, 'removeEventListener');

    await result.current.privateFetch(request, {
      signal: initController.signal,
    });

    expect(requestAdd).toHaveBeenCalled();
    expect(initAdd).toHaveBeenCalled();
    expect(requestRemove).toHaveBeenCalledTimes(requestAdd.mock.calls.length);
    expect(initRemove).toHaveBeenCalledTimes(initAdd.mock.calls.length);
  });

  it('ignores a late private response after a caller signal aborts', async () => {
    const response = deferred<Response>();
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => await response.promise);
    const currentApi = fakeApi(localSession);
    const { result } = renderHook(() =>
      useAuth(currentApi, { fetchImpl, basePath: '/terminal' }),
    );
    await flushAuth();
    const pending = result.current.privateFetch('/terminal/api/tabs', {
      signal: controller.signal,
    });

    controller.abort();
    response.resolve(
      Response.json({ error: 'authentication_required' }, { status: 401 }),
    );

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(result.current.status).toBe('authenticated');
    expect(result.current.bootstrap).toEqual(localSession);
  });

  it('logs out and treats a successful password change as authentication loss', async () => {
    const api = fakeApi(localSession);
    const { result } = renderHook(() => useAuth(api));
    await flushAuth();
    await act(async () => void (await result.current.logout()));
    expect(api.logout).toHaveBeenCalledWith(
      'csrf-local',
      expect.any(AbortSignal),
    );
    expect(result.current.status).toBe('unauthenticated');

    await act(async () => void (await result.current.retry()));
    vi.mocked(api.bootstrap).mockResolvedValue(localSession);
    await act(async () => void (await result.current.retry()));
    await act(
      async () =>
        void (await result.current.changePassword(
          'old-private',
          'new-private',
        )),
    );
    expect(api.changePassword).toHaveBeenCalledWith(
      'csrf-local',
      { currentPassword: 'old-private', newPassword: 'new-private' },
      expect.any(AbortSignal),
    );
    expect(result.current.status).toBe('unauthenticated');
  });

  it('aborts bootstrap on disposal and reboots after a persisted page returns', async () => {
    const first = deferred<AuthBootstrap>();
    const api = fakeApi(first.promise);
    let firstSignal: AbortSignal | undefined;
    vi.mocked(api.bootstrap)
      .mockImplementationOnce(async (signal) => {
        firstSignal = signal;
        return await first.promise;
      })
      .mockResolvedValue(localSession);
    const { result } = renderHook(() => useAuth(api));

    act(() =>
      window.dispatchEvent(
        new PageTransitionEvent('pagehide', { persisted: true }),
      ),
    );
    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.status).toBe('loading');
    first.resolve(localSession);
    await flushAuth();
    expect(result.current.status).toBe('loading');
    expect(result.current.bootstrap).toBeNull();
    act(() =>
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      ),
    );
    await flushAuth();
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
  });
});
