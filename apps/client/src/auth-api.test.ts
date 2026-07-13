import { describe, expect, it, vi } from 'vitest';

import { AuthApiError, createAuthApi } from './auth-api.js';

const authenticated = {
  authenticated: true as const,
  mode: 'local' as const,
  identityLabel: 'operator',
  csrfToken: 'csrf-token',
};

describe('createAuthApi', () => {
  it('uses the mounted document base with included credentials and no-store', async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json(authenticated);
      },
    );
    const api = createAuthApi({
      baseUrl: 'https://terminal.example/tools/terminal/',
      fetchImpl,
    });

    await expect(api.bootstrap()).resolves.toEqual(authenticated);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://terminal.example/tools/terminal/api/auth/session'),
      expect.objectContaining({
        cache: 'no-store',
        credentials: 'include',
        method: 'GET',
      }),
    );
  });

  it('sends strict local login JSON without a CSRF token', async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void input;
        void init;
        return Response.json(authenticated);
      },
    );
    const api = createAuthApi({
      baseUrl: 'https://example.test/t/',
      fetchImpl,
    });

    await api.login({ username: 'operator', password: 'private-password' });

    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://example.test/t/api/auth/login',
    );
    const init = fetchImpl.mock.calls[0]![1];
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        username: 'operator',
        password: 'private-password',
      }),
    });
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/json',
    );
  });

  it('protects refresh, logout, and password change with the in-memory CSRF token', async () => {
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        return String(input).endsWith('/refresh')
          ? Response.json(authenticated)
          : new Response(null, { status: 204 });
      },
    );
    const api = createAuthApi({
      baseUrl: 'https://example.test/t/',
      fetchImpl,
    });

    await api.refresh('csrf-token');
    await api.logout('csrf-token');
    await api.changePassword('csrf-token', {
      currentPassword: 'old-private',
      newPassword: 'new-private',
    });

    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      'https://example.test/t/api/auth/refresh',
      'https://example.test/t/api/auth/logout',
      'https://example.test/t/api/auth/password',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-token');
      expect(init).toMatchObject({ credentials: 'include', cache: 'no-store' });
    }
  });

  it('strictly parses bootstrap responses and returns only bounded errors', async () => {
    const invalid = createAuthApi({
      baseUrl: 'https://example.test/t/',
      fetchImpl: vi.fn(async () =>
        Response.json({ ...authenticated, privateKey: 'private-value' }),
      ),
    });
    const rejected = createAuthApi({
      baseUrl: 'https://example.test/t/',
      fetchImpl: vi.fn(async () =>
        Response.json({ error: 'authentication_failed' }, { status: 401 }),
      ),
    });

    const invalidError = await invalid
      .bootstrap()
      .catch((error: unknown) => error);
    expect(invalidError).toBeInstanceOf(AuthApiError);
    expect(String(invalidError)).not.toMatch(/private|csrf|Zod/i);
    await expect(rejected.bootstrap()).rejects.toMatchObject({
      name: 'AuthApiError',
      code: 'authentication_failed',
      status: 401,
    });
  });

  it('passes abort cancellation through without wrapping request details', async () => {
    const controller = new AbortController();
    const abort = new DOMException('private cancellation detail', 'AbortError');
    const api = createAuthApi({
      baseUrl: 'https://example.test/t/',
      fetchImpl: vi.fn(async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        throw abort;
      }),
    });

    await expect(api.bootstrap(controller.signal)).rejects.toBe(abort);
  });
});
