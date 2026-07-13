import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthRouter, type AuthRouterOptions } from './auth-routes.js';
import type {
  AuthBootstrapResult,
  AuthenticatedSession,
} from './auth-types.js';

const ORIGIN = 'https://terminal.example';
const COOKIE = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);
const NEXT_CSRF = 'c'.repeat(43);
let server: Server | undefined;
let options: AuthRouterOptions;

beforeEach(() => {
  options = routerOptions();
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('createAuthRouter', () => {
  it('returns a public no-store local bootstrap without creating a cookie', async () => {
    const response = await call('/terminal/api/auth/session');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      authenticated: false,
      mode: 'local',
    });
    expect(options.authService.bootstrap).toHaveBeenCalledWith({
      type: 'none',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(
      options.workspaceBootstrap.ensureForAuthenticatedSession,
    ).not.toHaveBeenCalled();
  });

  it('establishes none mode and returns only shared bootstrap fields', async () => {
    options = routerOptions({
      mode: 'none',
      session: session({ mode: 'none', identityLabel: 'anonymous' }),
    });
    vi.mocked(options.authService.bootstrap).mockResolvedValue(
      authenticatedResult('none', 'anonymous'),
    );

    const response = await call('/terminal/api/auth/session');

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      authenticated: true,
      mode: 'none',
      identityLabel: 'anonymous',
      csrfToken: CSRF,
    });
    expect(response.headers.get('set-cookie')).toContain(
      'Path=/terminal; HttpOnly; Secure; SameSite=Strict',
    );
    expect(text).not.toContain('cookieValue');
    expect(
      options.workspaceBootstrap.ensureForAuthenticatedSession,
    ).toHaveBeenCalledOnce();
    expect(options.authService.authenticateCookie).toHaveBeenCalledBefore(
      vi.mocked(options.workspaceBootstrap.ensureForAuthenticatedSession),
    );
  });

  it.each(['missing cookie value', 'unresolved cookie session'] as const)(
    'fails closed for an authenticated bootstrap with %s',
    async (failure) => {
      options = routerOptions({ mode: 'none' });
      const result = authenticatedResult('none', 'anonymous');
      vi.mocked(options.authService.bootstrap).mockResolvedValue(
        failure === 'missing cookie value'
          ? { bootstrap: result.bootstrap }
          : result,
      );
      if (failure === 'unresolved cookie session')
        vi.mocked(options.authService.authenticateCookie).mockReturnValue(
          undefined,
        );

      const response = await call('/terminal/api/auth/session');

      expect(response.status).toBe(500);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: 'operation_failed' });
      expect(text).not.toContain(CSRF);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(
        options.workspaceBootstrap.ensureForAuthenticatedSession,
      ).not.toHaveBeenCalled();
      expect(options.authService.touch).not.toHaveBeenCalled();
      expect(options.authService.authenticateCookie).toHaveBeenCalledTimes(
        failure === 'missing cookie value' ? 0 : 1,
      );
    },
  );

  it('resumes an existing cookie after authentication and touches HTTP activity', async () => {
    vi.mocked(options.authService.resume).mockReturnValue({
      bootstrap: {
        authenticated: true,
        mode: 'local',
        identityLabel: 'admin',
        csrfToken: NEXT_CSRF,
      },
    });

    const response = await call('/terminal/api/auth/session', {
      headers: { Cookie: `flanterminal_session=${COOKIE}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ csrfToken: NEXT_CSRF });
    expect(options.authService.resume).toHaveBeenCalledWith('session-id');
    expect(options.authService.touch).toHaveBeenCalledWith(
      'session-id',
      'http',
    );
    expect(options.authService.bootstrap).not.toHaveBeenCalled();
    expect(
      options.workspaceBootstrap.ensureForAuthenticatedSession,
    ).toHaveBeenCalledOnce();
  });

  it.each([
    ['authentication_failed', 401, 'authentication_failed'],
    ['rate_limited', 429, 'rate_limited'],
  ] as const)(
    'maps internal login %s without serializing it',
    async (failure, status, error) => {
      vi.mocked(options.authService.login).mockResolvedValue({
        bootstrap: { authenticated: false, mode: 'local' },
        failure,
      });

      const response = await mutation('/terminal/api/auth/login', {
        username: 'admin',
        password: 'private-password',
      });

      expect(response.status).toBe(status);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error });
      expect(text).not.toContain('failure');
      expect(text).not.toContain('private-password');
      expect(response.headers.get('set-cookie')).toBeNull();
    },
  );

  it('logs in with exact origin JSON and sets the configured cookie', async () => {
    vi.mocked(options.authService.login).mockResolvedValue(
      authenticatedResult('local', 'admin'),
    );

    const response = await mutation('/terminal/api/auth/login', {
      username: 'admin',
      password: 'private-password',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      mode: 'local',
      identityLabel: 'admin',
      csrfToken: CSRF,
    });
    expect(options.authService.login).toHaveBeenCalledWith({
      username: 'admin',
      password: 'private-password',
      address: '127.0.0.1',
    });
    expect(response.headers.get('set-cookie')).toBe(
      `flanterminal_session=${COOKIE}; Path=/terminal; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(
      options.workspaceBootstrap.ensureForAuthenticatedSession,
    ).toHaveBeenCalledOnce();
    expect(options.authService.authenticateCookie).toHaveBeenCalledBefore(
      vi.mocked(options.workspaceBootstrap.ensureForAuthenticatedSession),
    );
  });

  it.each(['cloudflare-access', 'trusted-header'] as const)(
    'coordinates a successful %s bootstrap after application authority exists',
    async (mode) => {
      const identityLabel = 'person@example.com';
      const identity = { mode, identityLabel };
      options = routerOptions({
        mode,
        session: session({ mode, identityLabel }),
        ...(mode === 'cloudflare-access'
          ? {
              cloudflareAccessProvider: {
                authenticate: vi.fn(async () => identity),
              },
            }
          : {
              trustedHeaderProvider: {
                authenticate: vi.fn(async () => identity),
              },
            }),
      });
      vi.mocked(options.authService.bootstrap).mockResolvedValue(
        authenticatedResult(mode, identityLabel),
      );

      const response = await call('/terminal/api/auth/session');

      expect(response.status).toBe(200);
      expect(
        options.workspaceBootstrap.ensureForAuthenticatedSession,
      ).toHaveBeenCalledOnce();
      expect(options.authService.authenticateCookie).toHaveBeenCalledBefore(
        vi.mocked(options.workspaceBootstrap.ensureForAuthenticatedSession),
      );
    },
  );

  it('fails closed without publishing a cookie when workspace bootstrap fails', async () => {
    options = routerOptions({
      mode: 'none',
      session: session({ mode: 'none', identityLabel: 'anonymous' }),
    });
    vi.mocked(options.authService.bootstrap).mockResolvedValue(
      authenticatedResult('none', 'anonymous'),
    );
    vi.mocked(
      options.workspaceBootstrap.ensureForAuthenticatedSession,
    ).mockRejectedValue(new Error('private tab storage failure'));

    const response = await call('/terminal/api/auth/session');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'operation_failed' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(options.authService.touch).not.toHaveBeenCalled();
  });

  it.each([
    [{ Origin: ORIGIN, 'Content-Type': 'text/plain' }, 415, 'json_required'],
    [
      { Origin: 'https://wrong.example', 'Content-Type': 'application/json' },
      403,
      'origin_forbidden',
    ],
  ] as const)(
    'rejects login admission before credentials',
    async (headers, status, error) => {
      const response = await call('/terminal/api/auth/login', {
        method: 'POST',
        headers,
        body: '{}',
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(options.authService.login).not.toHaveBeenCalled();
    },
  );

  it('refreshes the bound upstream identity, rotates CSRF, and touches after CSRF', async () => {
    const upstream = {
      mode: 'cloudflare-access' as const,
      identityLabel: 'person@example.com',
      expiresAt: 5_000,
    };
    options = routerOptions({
      mode: 'cloudflare-access',
      cloudflareAccessProvider: {
        authenticate: vi.fn(async () => upstream),
      },
      session: session({
        mode: 'cloudflare-access',
        identityLabel: upstream.identityLabel,
        upstreamExpiresAt: 4_000,
      }),
    });
    vi.mocked(options.authService.refresh).mockReturnValue(
      session({
        mode: 'cloudflare-access',
        identityLabel: upstream.identityLabel,
        upstreamExpiresAt: 5_000,
      }),
    );
    vi.mocked(options.authService.resume).mockReturnValue({
      bootstrap: {
        authenticated: true,
        mode: 'cloudflare-access',
        identityLabel: upstream.identityLabel,
        csrfToken: NEXT_CSRF,
        upstreamExpiresAt: new Date(5_000).toISOString(),
      },
    });

    const response = await privateMutation('/terminal/api/auth/refresh', {});

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ csrfToken: NEXT_CSRF });
    expect(options.authService.refresh).toHaveBeenCalledWith(
      'session-id',
      upstream,
    );
    expect(options.authService.verifyCsrf).toHaveBeenCalledBefore(
      vi.mocked(options.authService.touch),
    );
  });

  it('logs out only after CSRF, touches, clears the cookie, and returns 204', async () => {
    const response = await privateMutation('/terminal/api/auth/logout', {});

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(options.authService.verifyCsrf).toHaveBeenCalledBefore(
      vi.mocked(options.authService.touch),
    );
    expect(options.authService.logout).toHaveBeenCalledWith('session-id');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('changes a local password, revokes the cookie, and never responds with secrets', async () => {
    vi.mocked(options.authService.changePassword).mockResolvedValue(true);
    const response = await privateMutation(
      '/terminal/api/auth/password',
      {
        currentPassword: 'current-private-password',
        newPassword: 'new-private-password',
      },
      'PUT',
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(options.authService.changePassword).toHaveBeenCalledWith(
      'session-id',
      'current-private-password',
      'new-private-password',
    );
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('returns bounded stable errors for invalid CSRF, body, mode, and operation failure', async () => {
    vi.mocked(options.authService.verifyCsrf).mockReturnValueOnce(false);
    const csrf = await privateMutation('/terminal/api/auth/logout', {});
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toEqual({ error: 'csrf_invalid' });

    const large = await privateMutation(
      '/terminal/api/auth/password',
      {
        currentPassword: 'x'.repeat(17 * 1024),
        newPassword: 'new-password',
      },
      'PUT',
    );
    expect(large.status).toBe(400);
    expect(await large.json()).toEqual({ error: 'invalid_request' });

    options = routerOptions({
      mode: 'none',
      session: session({ mode: 'none' }),
    });
    const mode = await privateMutation(
      '/terminal/api/auth/password',
      {
        currentPassword: 'old-password',
        newPassword: 'new-password',
      },
      'PUT',
    );
    expect(mode.status).toBe(409);
    expect(await mode.json()).toEqual({ error: 'invalid_session_state' });

    options = routerOptions();
    vi.mocked(options.authService.changePassword).mockRejectedValue(
      new Error('private credential failure'),
    );
    const failed = await privateMutation(
      '/terminal/api/auth/password',
      {
        currentPassword: 'old-password',
        newPassword: 'new-password',
      },
      'PUT',
    );
    expect(failed.status).toBe(500);
    const failedText = await failed.text();
    expect(JSON.parse(failedText)).toEqual({ error: 'operation_failed' });
    expect(failedText.length).toBeLessThan(100);
    expect(failedText).not.toContain('private');
  });

  it('does not touch activity for mutations rejected by strict body schemas', async () => {
    const logout = await privateMutation('/terminal/api/auth/logout', {
      unexpected: true,
    });

    expect(logout.status).toBe(400);
    expect(await logout.json()).toEqual({ error: 'invalid_request' });
    expect(options.authService.touch).not.toHaveBeenCalled();

    const password = await privateMutation(
      '/terminal/api/auth/password',
      { currentPassword: 'current-password' },
      'PUT',
    );
    expect(password.status).toBe(400);
    expect(await password.json()).toEqual({ error: 'invalid_request' });
    expect(options.authService.touch).not.toHaveBeenCalled();
  });
});

function routerOptions(
  overrides: Partial<AuthRouterOptions> & {
    session?: AuthenticatedSession;
  } = {},
): AuthRouterOptions {
  const current = overrides.session ?? session();
  return {
    mode: 'local',
    publicOrigin: ORIGIN,
    basePath: '/terminal',
    secureCookie: true,
    workspaceBootstrap: {
      ensureForAuthenticatedSession: vi.fn(async () => undefined),
    },
    authService: {
      bootstrap: vi.fn(async (): Promise<AuthBootstrapResult> => ({
        bootstrap: { authenticated: false, mode: 'local' },
      })),
      login: vi.fn(),
      authenticateCookie: vi.fn(() => current),
      resume: vi.fn((): AuthBootstrapResult => ({
        bootstrap: {
          authenticated: true,
          mode: current.mode,
          identityLabel: current.identityLabel,
          csrfToken: NEXT_CSRF,
        },
      })),
      refresh: vi.fn(() => current),
      verifyCsrf: vi.fn((_id, supplied) => supplied === CSRF),
      touch: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(async () => false),
    },
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function session(
  overrides: Partial<AuthenticatedSession> = {},
): AuthenticatedSession {
  return Object.freeze({
    id: 'session-id',
    mode: 'local',
    identityLabel: 'admin',
    createdAt: 0,
    lastSeen: 0,
    idleExpiresAt: 10_000,
    absoluteExpiresAt: 20_000,
    ...overrides,
  });
}

function authenticatedResult(
  mode: AuthenticatedSession['mode'],
  identityLabel: string,
): AuthBootstrapResult {
  return {
    bootstrap: {
      authenticated: true,
      mode,
      identityLabel,
      csrfToken: CSRF,
    },
    cookieValue: COOKIE,
  };
}

async function mutation(path: string, body: unknown, method = 'POST') {
  return await call(path, {
    method,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function privateMutation(path: string, body: unknown, method = 'POST') {
  return await call(path, {
    method,
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-CSRF-Token': CSRF,
      Cookie: `flanterminal_session=${COOKIE}`,
    },
    body: JSON.stringify(body),
  });
}

async function call(path: string, init?: RequestInit) {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  const app = express();
  app.use('/terminal/api', createAuthRouter(options));
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return await fetch(`http://127.0.0.1:${port}${path}`, init);
}
