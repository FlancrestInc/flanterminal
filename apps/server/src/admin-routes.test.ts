import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import type { AdminSnapshot, CleanupResult } from '@flanterminal/shared';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthMiddlewareService } from './auth-middleware.js';
import type { AuthenticatedSession } from './auth-types.js';
import {
  createAdminRouter,
  type AdminRouteLogger,
  type AdminRouteService,
  type AdminRouteSessions,
} from './admin-routes.js';
import {
  InvalidSessionStateError,
  OperationFailedError,
  TabNotFoundError,
} from './session-manager.js';
import { CleanupDisabledError } from './stale-session-cleaner.js';

const PUBLIC_ORIGIN = 'https://terminal.example';
const COOKIE = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);
const TAB_A = '550e8400-e29b-41d4-a716-446655440000';
const TAB_B = '123e4567-e89b-42d3-a456-426614174000';

let server: Server | undefined;
let authority: AuthenticatedSession | undefined;
let authService: {
  authenticateCookie: ReturnType<
    typeof vi.fn<AuthMiddlewareService['authenticateCookie']>
  >;
  verifyCsrf: ReturnType<typeof vi.fn<AuthMiddlewareService['verifyCsrf']>>;
  touch: ReturnType<typeof vi.fn<AuthMiddlewareService['touch']>>;
};
let admin: {
  snapshot: ReturnType<typeof vi.fn<AdminRouteService['snapshot']>>;
  recordLifecycleError: ReturnType<
    typeof vi.fn<AdminRouteService['recordLifecycleError']>
  >;
  clearLifecycleError: ReturnType<
    typeof vi.fn<AdminRouteService['clearLifecycleError']>
  >;
};
let sessions: {
  restartBridge: ReturnType<typeof vi.fn<AdminRouteSessions['restartBridge']>>;
  terminate: ReturnType<typeof vi.fn<AdminRouteSessions['terminate']>>;
  recreate: ReturnType<typeof vi.fn<AdminRouteSessions['recreate']>>;
  restart: ReturnType<typeof vi.fn<AdminRouteSessions['restart']>>;
};
let cleanup: { runNow: ReturnType<typeof vi.fn<() => Promise<CleanupResult>>> };
let logger: {
  info: ReturnType<typeof vi.fn<AdminRouteLogger['info']>>;
  warn: ReturnType<typeof vi.fn<AdminRouteLogger['warn']>>;
  error: ReturnType<typeof vi.fn<AdminRouteLogger['error']>>;
};

beforeEach(() => {
  authority = authSession();
  authService = {
    authenticateCookie: vi.fn(() => authority),
    verifyCsrf: vi.fn((_id, token) => token === CSRF),
    touch: vi.fn(),
  };
  admin = {
    snapshot: vi.fn(async () => snapshot()),
    recordLifecycleError: vi.fn(),
    clearLifecycleError: vi.fn(),
  };
  sessions = {
    restartBridge: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    recreate: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
  };
  cleanup = { runNow: vi.fn(async () => cleanupResult()) };
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('createAdminRouter', () => {
  it('returns the authenticated authoritative snapshot with no-store', async () => {
    const response = await request('/api/admin');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual(snapshot());
    expect(admin.snapshot).toHaveBeenCalledOnce();
    expect(authService.touch).toHaveBeenCalledWith('session-id', 'http');
  });

  it('rejects unauthenticated reads before snapshot or activity', async () => {
    authority = undefined;

    const response = await request('/api/admin', {}, false);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
    expect(admin.snapshot).not.toHaveBeenCalled();
    expect(authService.touch).not.toHaveBeenCalled();
  });

  it.each([
    ['restart_bridge', 'restartBridge'],
    ['terminate', 'terminate'],
    ['recreate', 'recreate'],
    ['restart_session', 'restart'],
  ] as const)(
    'dispatches the isolated %s lifecycle action',
    async (action, method) => {
      const response = await mutation(`/api/admin/sessions/${TAB_A}`, {
        action,
      });

      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(sessions[method]).toHaveBeenCalledWith(TAB_A);
      expect(totalSessionCalls()).toBe(1);
      expect(admin.clearLifecycleError).toHaveBeenCalledWith(TAB_A);
      expect(admin.recordLifecycleError).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'administration_action_succeeded',
        {
          sessionId: TAB_A,
          category: action,
        },
      );
    },
  );

  it('runs manual cleanup and returns only the bounded cleanup result', async () => {
    const response = await mutation('/api/admin/cleanup', {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(cleanupResult());
    expect(cleanup.runNow).toHaveBeenCalledOnce();
    expect(totalSessionCalls()).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      'administration_cleanup_succeeded',
      { category: 'cleanup_completed' },
    );
  });

  it.each([
    [
      'missing CSRF',
      { Origin: PUBLIC_ORIGIN, 'Content-Type': 'application/json' },
      403,
      'csrf_invalid',
    ],
    [
      'wrong origin',
      {
        Origin: 'https://wrong.example',
        'X-CSRF-Token': CSRF,
        'Content-Type': 'application/json',
      },
      403,
      'origin_forbidden',
    ],
    [
      'non-JSON',
      {
        Origin: PUBLIC_ORIGIN,
        'X-CSRF-Token': CSRF,
        'Content-Type': 'text/plain',
      },
      415,
      'json_required',
    ],
  ])(
    'rejects %s before state changes',
    async (_name, headers, status, code) => {
      const response = await request(`/api/admin/sessions/${TAB_A}`, {
        method: 'POST',
        headers,
        body: '{}',
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code });
      expect(totalSessionCalls()).toBe(0);
      expect(cleanup.runNow).not.toHaveBeenCalled();
    },
  );

  it.each([
    [`/api/admin/sessions/not-a-uuid`, { action: 'terminate' }],
    [`/api/admin/sessions/${TAB_A}`, {}],
    [`/api/admin/sessions/${TAB_A}`, { action: 'terminate', force: true }],
    [`/api/admin/sessions/${TAB_A}`, { action: 'delete' }],
    ['/api/admin/cleanup', { force: true }],
  ])('rejects invalid identifier or strict body for %s', async (path, body) => {
    const response = await mutation(path, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(totalSessionCalls()).toBe(0);
    expect(cleanup.runNow).not.toHaveBeenCalled();
  });

  it('logs a rejected action body as a bounded action failure', async () => {
    const response = await mutation(`/api/admin/sessions/${TAB_A}`, {
      action: 'restart_session',
      commandOutput: 'private terminal contents',
    });

    expect(response.status).toBe(400);
    expect(logger.error).toHaveBeenCalledWith('administration_action_failed', {
      sessionId: TAB_A,
      category: 'invalid_request',
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      'private terminal contents',
    );
  });

  it.each([
    [new TabNotFoundError(), 404, 'tab_not_found', null],
    [
      new InvalidSessionStateError(),
      409,
      'invalid_session_state',
      'invalid_session_state',
    ],
    [new OperationFailedError(), 500, 'operation_failed', 'operation_failed'],
    [
      new Error('tmux stdout /home/webterm/.ssh secret'),
      500,
      'operation_failed',
      'operation_failed',
    ],
  ] as const)(
    'maps lifecycle failures without returning or logging raw errors',
    async (failure, status, code, recorded) => {
      sessions.restart.mockRejectedValueOnce(failure);

      const response = await mutation(`/api/admin/sessions/${TAB_A}`, {
        action: 'restart_session',
      });
      const body = await response.text();

      expect(response.status).toBe(status);
      expect(JSON.parse(body)).toEqual({ error: code });
      expect(body).not.toMatch(/tmux|stdout|home|ssh|secret/i);
      if (recorded === null) {
        expect(admin.recordLifecycleError).not.toHaveBeenCalled();
      } else {
        expect(admin.recordLifecycleError).toHaveBeenCalledWith(
          TAB_A,
          recorded,
        );
      }
      expect(logger.error).toHaveBeenCalledWith(
        'administration_action_failed',
        {
          sessionId: TAB_A,
          category: code,
        },
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(
        /tmux|stdout|home|ssh|secret/i,
      );
    },
  );

  it('maps disabled cleanup to a stable conflict without lifecycle mutation', async () => {
    cleanup.runNow.mockRejectedValueOnce(new CleanupDisabledError());

    const response = await mutation('/api/admin/cleanup', {});

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'cleanup_disabled' });
    expect(admin.recordLifecycleError).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('administration_cleanup_failed', {
      category: 'cleanup_disabled',
    });
  });

  it('keeps an independent session action available after another fails', async () => {
    sessions.terminate.mockRejectedValueOnce(new OperationFailedError());
    const failed = await mutation(`/api/admin/sessions/${TAB_A}`, {
      action: 'terminate',
    });
    const succeeded = await mutation(`/api/admin/sessions/${TAB_B}`, {
      action: 'terminate',
    });

    expect(failed.status).toBe(500);
    expect(succeeded.status).toBe(204);
    expect(sessions.terminate).toHaveBeenNthCalledWith(1, TAB_A);
    expect(sessions.terminate).toHaveBeenNthCalledWith(2, TAB_B);
  });

  it.each([
    `/api/admin/`,
    `/api/Admin`,
    `/api/admin/sessions/${TAB_A}/`,
    `/api/admin/sessions/${TAB_A}%2Frestart`,
  ])('rejects noncanonical route %s before services run', async (path) => {
    const response = await request(path);

    expect([400, 404]).toContain(response.status);
    expect(admin.snapshot).not.toHaveBeenCalled();
    expect(totalSessionCalls()).toBe(0);
  });
});

async function request(
  path: string,
  init: RequestInit = {},
  includeCookie = true,
): Promise<Response> {
  const port = await listen();
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      ...(includeCookie ? { Cookie: `flanterminal_session=${COOKIE}` } : {}),
      ...init.headers,
    },
  });
}

function mutation(path: string, body: unknown): Promise<Response> {
  return request(path, {
    method: 'POST',
    headers: {
      Origin: PUBLIC_ORIGIN,
      'X-CSRF-Token': CSRF,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function listen(): Promise<number> {
  if (server === undefined) {
    const app = express();
    app.use(
      '/api',
      createAdminRouter({
        mode: 'local',
        publicOrigin: PUBLIC_ORIGIN,
        authService,
        admin,
        sessions,
        cleanup,
        logger,
      }),
    );
    app.use('/api', (_request, response) =>
      response.status(404).json({ error: 'not_found' }),
    );
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error();
  return address.port;
}

function authSession(): AuthenticatedSession {
  return Object.freeze({
    id: 'session-id',
    mode: 'local',
    identityLabel: 'admin',
    createdAt: 0,
    lastSeen: 0,
    idleExpiresAt: 1_000,
    absoluteExpiresAt: 2_000,
  });
}

function snapshot(): AdminSnapshot {
  return Object.freeze({
    generatedAt: '2026-07-12T18:00:00.000Z',
    uptimeSeconds: 100,
    memory: Object.freeze({ rss: 1000, heapUsed: 500 }),
    totals: Object.freeze({
      tabs: 0,
      runningSessions: 0,
      bridges: 0,
      webSockets: 0,
    }),
    cleanup: Object.freeze({ enabled: true, running: false, lastRunAt: null }),
    sessions: Object.freeze([]),
  });
}

function cleanupResult(): CleanupResult {
  return Object.freeze({
    disabled: false,
    examined: 2,
    terminated: 1,
    skipped: 1,
    failed: 0,
    startedAt: '2026-07-12T18:00:00.000Z',
    finishedAt: '2026-07-12T18:00:01.000Z',
  });
}

function totalSessionCalls(): number {
  return (
    sessions.restartBridge.mock.calls.length +
    sessions.terminate.mock.calls.length +
    sessions.recreate.mock.calls.length +
    sessions.restart.mock.calls.length
  );
}
