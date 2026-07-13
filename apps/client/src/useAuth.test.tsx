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
    const { result } = renderHook(() => useAuth(currentApi, { fetchImpl }));
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
      await Promise.all([
        result.current.privateFetch('/first'),
        result.current.privateFetch('/second'),
      ]);
    });

    expect(result.current.status).toBe('unauthenticated');
    expect(result.current.error).toBeNull();
    expect(result.current.bootstrap).toBeNull();
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
      await result.current.privateFetch('/read', { method: 'GET' });
      await result.current.privateFetch('/write', {
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
    expect(calls[1]!.signal?.aborted).toBe(true);
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
    act(() =>
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true }),
      ),
    );
    await flushAuth();
    expect(api.bootstrap).toHaveBeenCalledTimes(2);
  });
});
