import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TabView,
  WorkspaceSettings,
  WorkspaceSettingsConstraints,
} from '@flanterminal/shared';

import { createApp } from './app.js';
import type { AuthMiddlewareOptions } from './auth-middleware.js';
import type { AuthRouterOptions } from './auth-routes.js';
import type {
  AuthBootstrapResult,
  AuthenticatedSession,
} from './auth-types.js';
import { loadConfig } from './config.js';
import { TabNotFoundError as SessionTabNotFoundError } from './session-manager.js';
import type { SettingsRouterOptions } from './settings-routes.js';
import type { TabRouterOptions } from './tab-routes.js';
import { SessionLimitError } from './tab-store.js';

const PUBLIC_ORIGIN = 'http://localhost:3000';
const COOKIE = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);
const FIXED_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const NOW = '2026-07-12T00:00:00.000Z';

let clientDist: string;
let server: Server | undefined;

beforeEach(async () => {
  clientDist = await mkdtemp(join(tmpdir(), 'flanterminal-app-'));
  await writeFile(join(clientDist, 'index.html'), '<main>terminal app</main>');
  await writeFile(join(clientDist, 'app.js'), 'console.log("app")');
  await writeFile(join(clientDist, '.ssh'), 'private');
  await mkdir(join(clientDist, 'assets'));
  await writeFile(join(clientDist, 'assets', 'manifest'), 'asset manifest');
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(clientDist, { recursive: true, force: true });
});

describe('createApp', () => {
  it('reports structured health metrics without configuration secrets', async () => {
    const response = await request('/health');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      activeSessions: 2,
      connectedWebSockets: 3,
      memory: { rss: expect.any(Number), heapUsed: expect.any(Number) },
      uptimeSeconds: expect.any(Number),
    });
    expect(JSON.stringify(body)).not.toContain('/bin/bash');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it.each([
    [true, 200, { status: 'ready', ready: true }],
    [false, 503, { status: 'not_ready', ready: false }],
  ])('maps readiness %s to HTTP %s', async (ready, status, body) => {
    const response = await request('/ready', { ready });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it('serves only strict browser-safe configuration to an authenticated session with no-store', async () => {
    const response = await request('/terminal/api/config', {
      http: httpDependencies(),
      init: { headers: { Cookie: `flanterminal_session=${COOKIE}` } },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      basePath: '/terminal',
      fontSize: 14,
      scrollback: 10_000,
      resizeDebounceMs: 100,
      reconnectMaxSeconds: 15,
    });
  });

  it.each(['/terminal', '/'])(
    'keeps only health, readiness, auth bootstrap, login, and the data-free shell public for %s',
    async (basePath) => {
      const api = apiPath(basePath);
      const http = httpDependencies();
      const publicCases: ReadonlyArray<readonly [string, RequestInit?]> = [
        ['/health'],
        ['/ready'],
        [`${api}/auth/session`],
        [
          `${api}/auth/login`,
          {
            method: 'POST',
            headers: {
              Origin: PUBLIC_ORIGIN,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ username: 'admin', password: 'correct' }),
          },
        ],
        [basePath === '/' ? '/' : `${basePath}/`],
        [withTestBase(basePath, '/app.js')],
      ];

      for (const [path, init] of publicCases) {
        const response = await request(path, {
          basePath,
          http,
          ...(init === undefined ? {} : { init }),
        });
        expect(response.status, path).toBe(200);
      }

      const shell = await request(basePath === '/' ? '/' : `${basePath}/`, {
        basePath,
        http,
      });
      const shellText = await shell.text();
      expect(shellText).toContain('terminal app');
      expect(shellText).not.toContain(CSRF);
      expect(shellText).not.toContain(COOKIE);

      for (const [method, path] of [
        ['GET', `${api}/config`],
        ['GET', `${api}/settings`],
        ['GET', `${api}/tabs`],
        ['POST', `${api}/auth/refresh`],
        ['POST', `${api}/auth/logout`],
        ['PUT', `${api}/auth/password`],
      ] as const) {
        const response = await request(path, {
          basePath,
          http,
          ...(method === 'GET'
            ? {}
            : {
                init: {
                  method,
                  headers: jsonHeaders(),
                  body: '{}',
                },
              }),
        });
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(response.headers.get('cache-control')).toContain('no-store');
      }
    },
  );

  it.each(['/terminal', '/'])(
    'mounts exact strict auth routes and scopes cookies to %s',
    async (basePath) => {
      const api = apiPath(basePath);
      const http = httpDependencies();
      const response = await request(`${api}/auth/login`, {
        basePath,
        publicUrl: 'https://terminal.example',
        http,
        init: {
          method: 'POST',
          headers: {
            Origin: 'https://terminal.example',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ username: 'admin', password: 'correct' }),
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain(`Path=${basePath}`);
      expect(response.headers.get('set-cookie')).toContain('Secure');
      for (const alias of [
        `${api}/Auth/session`,
        `${api}/auth/session/`,
        `${api}/auth//session`,
      ]) {
        expect((await request(alias, { basePath, http })).status, alias).toBe(
          404,
        );
      }
    },
  );

  it('rejects aliases, encodings, and traversal before any route service runs', async () => {
    const metrics = {
      activeSessionCount: vi.fn(() => 2),
      connectedWebSocketCount: vi.fn(() => 3),
    };
    const readiness = { isReady: vi.fn(() => true) };
    const http = httpDependencies();

    for (const path of [
      '/HEALTH',
      '/%68ealth',
      '/terminal/%61pi/auth/session',
      '/terminal/api/%61uth/session',
      '/terminal/api/auth/%73ession',
      '/terminal/api/auth/%2e%2e/session',
      '/terminal/api/auth%2fsession',
      '/TERMINAL/api/auth/session',
    ]) {
      const response = await request(path, { http, metrics, readiness });
      expect(response.status, path).toBe(404);
    }

    expect(metrics.activeSessionCount).not.toHaveBeenCalled();
    expect(metrics.connectedWebSocketCount).not.toHaveBeenCalled();
    expect(readiness.isReady).not.toHaveBeenCalled();
    expect(http.auth.authService.bootstrap).not.toHaveBeenCalled();
    expect(http.auth.authService.authenticateCookie).not.toHaveBeenCalled();
  });

  it.each(['/terminal', '/'])(
    'passes the forwarded client IP to local login only through a configured trusted proxy at %s',
    async (basePath) => {
      const http = httpDependencies();
      const response = await request(`${apiPath(basePath)}/auth/login`, {
        basePath,
        trustProxy: '127.0.0.1/32',
        http,
        init: {
          method: 'POST',
          headers: {
            Origin: PUBLIC_ORIGIN,
            'Content-Type': 'application/json',
            'X-Forwarded-For': '198.51.100.7',
          },
          body: JSON.stringify({ username: 'admin', password: 'correct' }),
        },
      });

      expect(response.status).toBe(200);
      expect(http.auth.authService.login).toHaveBeenCalledWith(
        expect.objectContaining({ address: '198.51.100.7' }),
      );
    },
  );

  it('ignores spoofed forwarding when proxy trust is disabled', async () => {
    const http = httpDependencies();
    const response = await request('/terminal/api/auth/login', {
      trustProxy: false,
      http,
      init: {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.9',
        },
        body: JSON.stringify({ username: 'admin', password: 'correct' }),
      },
    });

    expect(response.status).toBe(200);
    expect(http.auth.authService.login).toHaveBeenCalledWith(
      expect.objectContaining({ address: '127.0.0.1' }),
    );
  });

  it('keeps private data fail-closed when Phase 3 HTTP services are absent', async () => {
    for (const path of [
      '/terminal/api/config',
      '/terminal/api/settings',
      '/terminal/api/tabs',
      '/terminal/api/auth/session',
      '/terminal/api/auth/login',
    ]) {
      const response = await request(path, {
        ...(path.endsWith('/login')
          ? {
              init: {
                method: 'POST',
                headers: jsonHeaders(),
                body: '{}',
              },
            }
          : {}),
      });
      expect(response.status, path).toBe(404);
      expect(await response.text()).not.toContain('terminal app');
    }
  });

  it.each(['/terminal', '/'])(
    'mounts every tab lifecycle command beneath the API base for %s',
    async (basePath) => {
      const api = apiPath(basePath);
      const commands: ReadonlyArray<
        readonly [string, string, BodyInit | undefined, number]
      > = [
        ['GET', `${api}/tabs`, undefined, 200],
        ['POST', `${api}/tabs`, JSON.stringify({ displayName: 'Work' }), 201],
        [
          'PATCH',
          `${api}/tabs/${FIXED_SESSION_ID}`,
          JSON.stringify({ displayName: 'Logs' }),
          200,
        ],
        [
          'PUT',
          `${api}/tabs/order`,
          JSON.stringify({ structureRevision: 0, ids: [FIXED_SESSION_ID] }),
          200,
        ],
        ['DELETE', `${api}/tabs/${FIXED_SESSION_ID}`, 'not-json', 204],
        ['GET', `${api}/tabs/${FIXED_SESSION_ID}/session`, undefined, 200],
        [
          'POST',
          `${api}/tabs/${FIXED_SESSION_ID}/session/terminate`,
          '{}',
          200,
        ],
        ['POST', `${api}/tabs/${FIXED_SESSION_ID}/session/recreate`, '{}', 200],
        ['POST', `${api}/tabs/${FIXED_SESSION_ID}/session/restart`, '{}', 200],
        ['POST', `${api}/tabs/${FIXED_SESSION_ID}/bridge/restart`, '{}', 200],
      ];

      for (const [method, path, body, status] of commands) {
        const response = await request(path, {
          basePath,
          tabs: true,
          init: {
            method,
            ...(method === 'GET'
              ? {}
              : {
                  headers:
                    method === 'DELETE'
                      ? {
                          Origin: PUBLIC_ORIGIN,
                          'X-CSRF-Token': CSRF,
                        }
                      : jsonHeaders(),
                }),
            ...(body === undefined ? {} : { body }),
          },
        });

        expect(response.status, `${method} ${path}`).toBe(status);
      }
    },
  );

  it.each(['/terminal', '/'])(
    'enforces mounted tab security and stable errors for %s',
    async (basePath) => {
      const api = apiPath(basePath);
      const cases: ReadonlyArray<
        readonly [string, RequestInit, number, string, AppTabFailure?]
      > = [
        [
          `${api}/tabs`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          },
          403,
          'origin_forbidden',
        ],
        [
          `${api}/tabs`,
          {
            method: 'POST',
            headers: { Origin: PUBLIC_ORIGIN, 'Content-Type': 'text/plain' },
            body: '{}',
          },
          415,
          'json_required',
        ],
        [
          `${api}/tabs`,
          { method: 'POST', headers: jsonHeaders(), body: '{' },
          400,
          'invalid_request',
        ],
        [
          `${api}/tabs`,
          { method: 'POST', headers: jsonHeaders(), body: '{}' },
          409,
          'session_limit',
          'create_conflict',
        ],
        [
          `${api}/tabs/${FIXED_SESSION_ID}/session/restart`,
          { method: 'POST', headers: jsonHeaders(), body: '{}' },
          500,
          'operation_failed',
          'restart_failure',
        ],
        [
          `${api}/tabs/${FIXED_SESSION_ID}/session`,
          { method: 'GET' },
          404,
          'tab_not_found',
          'view_not_found',
        ],
        [
          `${api}/tabs/${FIXED_SESSION_ID}/session/bridge/restart`,
          { method: 'POST', headers: jsonHeaders(), body: '{}' },
          404,
          'not_found',
        ],
      ];

      for (const [path, init, status, error, tabFailure] of cases) {
        const response = await request(path, {
          basePath,
          tabs: true,
          init,
          ...(tabFailure === undefined ? {} : { tabFailure }),
        });
        expect(response.status, path).toBe(status);
        expect(await response.json()).toEqual({ error });
      }

      for (const [path, statuses] of [
        [`${api}/tabs/%35${FIXED_SESSION_ID.slice(1)}/session`, [404]],
        [`${api}/tabs/${FIXED_SESSION_ID}/session/`, [404]],
        [`${api}/tabs/${FIXED_SESSION_ID.toUpperCase()}/session`, [400]],
        [`${api}/tabs/${FIXED_SESSION_ID}%2F..%2Fother/session`, [404]],
      ] as const) {
        const response = await request(path, { basePath, tabs: true });
        expect(statuses, path).toContain(response.status);
      }
    },
  );

  it('rejects a case-aliased base path before tab routing', async () => {
    const response = await request('/TERMINAL/api/tabs', { tabs: true });

    expect(response.status).toBe(404);
  });

  it.each([
    ['http://localhost:3000', '/terminal'],
    ['https://terminal.example', '/terminal'],
    ['https://terminal.example', '/'],
  ])(
    'sets an asset-local CSP and explicit security headers for %s at %s',
    async (publicUrl, basePath) => {
      const response = await request('/health', { publicUrl, basePath });
      const csp = response.headers.get('content-security-policy') ?? '';

      const directives = parseCsp(csp);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(directives.get('script-src')).toEqual(["'self'"]);
      expect(directives.get('style-src')).toEqual([
        "'self'",
        "'unsafe-inline'",
      ]);
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/\b(?:https?:|wss?:)\s*\*/);
      expect(csp).not.toContain('data:');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.has('strict-transport-security')).toBe(
        publicUrl.startsWith('https:'),
      );
    },
  );

  it.each([
    ['http://localhost:3000', '/terminal'],
    ['https://terminal.example', '/terminal'],
    ['https://terminal.example', '/'],
  ])(
    'allows the explicit WebSocket session prefix for %s at %s',
    async (publicUrl, basePath) => {
      const response = await request('/health', { publicUrl, basePath });
      const directives = parseCsp(
        response.headers.get('content-security-policy') ?? '',
      );
      const websocketProtocol = publicUrl.startsWith('https:') ? 'wss' : 'ws';
      const host = new URL(publicUrl).host;
      const wsPath = withTestBase(basePath, '/ws');
      const websocketSessionPrefix = `${websocketProtocol}://${host}${wsPath}/`;

      expect(directives.get('connect-src')).toEqual([
        "'self'",
        websocketSessionPrefix,
      ]);
      expect(directives.get('connect-src')).not.toContain(
        `${websocketProtocol}://${host}${wsPath}`,
      );
      expect(`${websocketSessionPrefix}sessions/${FIXED_SESSION_ID}`).toBe(
        `${websocketProtocol}://${host}${wsPath}/sessions/${FIXED_SESSION_ID}`,
      );
    },
  );

  it('sets helmet security headers', async () => {
    const response = await request('/health');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBeTruthy();
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('serves static assets and extensionless SPA navigation only under the base', async () => {
    expect((await request('/terminal/app.js')).status).toBe(200);
    expect(
      await (await request('/terminal/dashboard/session')).text(),
    ).toContain('terminal app');
    expect((await request('/terminal/missing.js')).status).toBe(404);
    expect((await request('/outside')).status).toBe(404);
    expect((await request('/terminal/api/unknown')).status).toBe(404);
  });

  it.each(['/terminal', '/terminal/dashboard/session', '/terminal/a/'])(
    'redirects noncanonical workspace path %s to the mounted root',
    async (path) => {
      const response = await request(path, {
        redirect: 'manual',
      });
      expect(response.status).toBe(308);
      expect(response.headers.get('location')).toBe('/terminal/');
    },
  );

  it.each([
    '/terminal/.ssh',
    '/terminal/home/user/id_rsa',
    '/terminal/%2e%2e/.ssh/id_rsa',
    '/terminal/%2Essh',
    '/terminal/private.key',
  ])('never serves sensitive or traversal-like path %s', async (path) => {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('private');
  });

  it('supports static assets and navigation at the root base', async () => {
    expect((await request('/app.js', { basePath: '/' })).status).toBe(200);
    expect(
      await (await request('/sessions', { basePath: '/' })).text(),
    ).toContain('terminal app');
    expect((await request('/missing.css', { basePath: '/' })).status).toBe(404);
  });

  it.each(['/terminal/assets/missing', '/terminal/assets/nested/missing'])(
    'returns JSON 404 for an unknown extensionless asset under a nonroot base: %s',
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({ error: 'not_found' });
    },
  );

  it.each([
    ['/terminal/%61pi/unknown', '/terminal'],
    ['/terminal/%61ssets/missing', '/terminal'],
    ['/terminal/%73tatic/missing', '/terminal'],
    ['/terminal/%77s/unknown', '/terminal'],
    ['/terminal/missing%2ejs', '/terminal'],
    ['/%61pi/unknown', '/'],
    ['/%61ssets/missing', '/'],
    ['/%73tatic/missing', '/'],
    ['/%77s/unknown', '/'],
    ['/missing%2ejs', '/'],
    ['/terminal/%zz', '/terminal'],
    ['/%zz', '/'],
  ])(
    'never serves SPA fallback for encoded non-navigation path %s',
    async (path, basePath) => {
      const response = await request(path, { basePath });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('terminal app');
    },
  );

  it.each([
    ['/terminal/assets%2fmissing', '/terminal'],
    ['/terminal/assets%5cmissing', '/terminal'],
    ['/assets%2fmissing', '/'],
    ['/assets%5cmissing', '/'],
  ])(
    'rejects encoded path separators without double decoding: %s',
    async (path, basePath) => {
      const response = await request(path, { basePath });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('terminal app');
    },
  );

  it.each(['/assets/missing', '/assets/nested/missing'])(
    'returns JSON 404 for an unknown extensionless asset under the root base: %s',
    async (path) => {
      const response = await request(path, { basePath: '/' });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({ error: 'not_found' });
    },
  );

  it('serves an existing extensionless asset before the reserved namespace fallback', async () => {
    const response = await request('/terminal/assets/manifest');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('asset manifest');
  });

  it.each([
    ['/terminal/api/unknown', '/terminal'],
    ['/api/unknown', '/'],
    ['/terminal/static/missing', '/terminal'],
    ['/static/missing', '/'],
    ['/terminal/ws/unknown', '/terminal'],
    ['/ws/unknown', '/'],
  ])(
    'returns JSON 404 for an unknown reserved route: %s',
    async (path, basePath) => {
      const response = await request(path, { basePath });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({ error: 'not_found' });
    },
  );
});

async function request(
  path: string,
  options: {
    ready?: boolean;
    basePath?: string;
    publicUrl?: string;
    trustProxy?: false | string;
    redirect?: RequestRedirect;
    tabs?: boolean;
    init?: RequestInit;
    tabFailure?: AppTabFailure;
    http?: AppHttpDependencies;
    metrics?: {
      activeSessionCount(): number;
      connectedWebSocketCount(): number;
    };
    readiness?: { isReady(): boolean | Promise<boolean> };
  } = {},
): Promise<Response> {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  const http =
    options.http ??
    (options.tabs === true ? httpDependencies(options.tabFailure) : undefined);
  const app = createApp({
    config: config(
      options.basePath ?? '/terminal',
      options.publicUrl ?? PUBLIC_ORIGIN,
      options.trustProxy ?? false,
    ),
    readiness:
      options.readiness ??
      ({ isReady: vi.fn(() => options.ready ?? true) } as const),
    metrics:
      options.metrics ??
      ({
        activeSessionCount: vi.fn(() => 2),
        connectedWebSocketCount: vi.fn(() => 3),
      } as const),
    clientDist,
    ...(http === undefined ? {} : { http }),
  });
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('listen failed');
  return fetch(`http://127.0.0.1:${address.port}${path}`, {
    ...options.init,
    headers: {
      ...(options.tabs === true
        ? { Cookie: `flanterminal_session=${COOKIE}` }
        : {}),
      ...options.init?.headers,
    },
    ...(options.redirect === undefined ? {} : { redirect: options.redirect }),
  });
}

type AppTabFailure = 'create_conflict' | 'restart_failure' | 'view_not_found';

function tabDependencies(
  failure?: AppTabFailure,
): Omit<TabRouterOptions, keyof AuthMiddlewareOptions> {
  return {
    store: {
      create: vi.fn(async (displayName) => {
        if (failure === 'create_conflict') throw new SessionLimitError();
        return tabRecord(displayName ?? 'Terminal 1');
      }),
      rename: vi.fn(async (_id, displayName) => tabRecord(displayName)),
      reorder: vi.fn(async () => ({
        structureRevision: 1,
        tabs: [tabRecord()],
      })),
    },
    sessions: {
      collectionView: vi.fn(async () => ({
        structureRevision: 0,
        tabs: [appTabView()],
      })),
      view: vi.fn(async () => {
        if (failure === 'view_not_found') throw new SessionTabNotFoundError();
        return appTabView();
      }),
      terminate: vi.fn(async () => appTabView('stopped')),
      recreate: vi.fn(async () => appTabView()),
      restart: vi.fn(async () => {
        if (failure === 'restart_failure') throw new Error('private output');
        return appTabView();
      }),
      restartBridge: vi.fn(async () => appTabView()),
      closeTab: vi.fn(async () => undefined),
    },
  };
}

function tabRecord(displayName = 'Terminal 1') {
  return {
    id: FIXED_SESSION_ID,
    displayName,
    position: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    desiredState: 'active' as const,
  };
}

function appTabView(state: TabView['session']['state'] = 'running'): TabView {
  return {
    ...tabRecord(),
    session: { state, attached: false, bridgePid: null },
  };
}

function apiPath(basePath: string): string {
  return basePath === '/' ? '/api' : `${basePath}/api`;
}

function jsonHeaders(): Record<string, string> {
  return {
    Origin: PUBLIC_ORIGIN,
    'X-CSRF-Token': CSRF,
    'Content-Type': 'application/json',
  };
}

type AppHttpDependencies = Readonly<{
  auth: Omit<AuthRouterOptions, 'basePath' | 'publicOrigin' | 'secureCookie'>;
  settings: Omit<SettingsRouterOptions, keyof AuthMiddlewareOptions>;
  tabs: Omit<TabRouterOptions, keyof AuthMiddlewareOptions>;
}>;

function httpDependencies(failure?: AppTabFailure): AppHttpDependencies {
  const session = authenticatedSession();
  const authService: AuthRouterOptions['authService'] = {
    authenticateCookie: vi.fn((raw) => (raw === COOKIE ? session : undefined)),
    verifyCsrf: vi.fn((_id, supplied) => supplied === CSRF),
    touch: vi.fn(),
    bootstrap: vi.fn(async (): Promise<AuthBootstrapResult> => ({
      bootstrap: { authenticated: false, mode: 'local' as const },
    })),
    login: vi.fn(async (): Promise<AuthBootstrapResult> => ({
      bootstrap: {
        authenticated: true,
        mode: 'local' as const,
        identityLabel: 'admin',
        csrfToken: CSRF,
      },
      cookieValue: COOKIE,
    })),
    resume: vi.fn(() => ({
      bootstrap: {
        authenticated: true,
        mode: 'local' as const,
        identityLabel: 'admin',
        csrfToken: CSRF,
      },
    })),
    refresh: vi.fn(() => session),
    logout: vi.fn(),
    changePassword: vi.fn(async () => true),
  };
  return {
    auth: {
      mode: 'local',
      authService,
      logger: { warn: vi.fn(), error: vi.fn() },
    },
    settings: {
      store: {
        snapshot: vi.fn(() => DEFAULT_SETTINGS),
        replace: vi.fn(async () => ({ state: 'committed' as const })),
      },
      constraints: SETTINGS_CONSTRAINTS,
    },
    tabs: tabDependencies(failure),
  };
}

function authenticatedSession(): AuthenticatedSession {
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

const DEFAULT_SETTINGS: WorkspaceSettings = {
  version: 1,
  fontFamily: 'jetbrains-mono-nerd',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  scrollback: 10_000,
  theme: 'dark',
  cursorStyle: 'block',
  cursorBlink: true,
  bellBehavior: 'visual',
  reconnectBehavior: 'automatic',
  automaticTabCreation: true,
  workspaceShortcuts: 'default',
  defaultShell: '/bin/bash',
  tmuxHistoryLimit: 50_000,
  staleSessionCleanupHours: 24,
};

const SETTINGS_CONSTRAINTS: WorkspaceSettingsConstraints = {
  limits: {
    fontFamilies: ['jetbrains-mono-nerd'],
    fontSize: { min: 10, max: 24, step: 1 },
    lineHeight: { min: 1, max: 1.5, step: 0.05 },
    letterSpacing: { min: 0, max: 2, step: 1 },
    scrollback: { min: 1_000, max: 50_000, step: 1_000 },
    themes: ['dark'],
    cursorStyles: ['block'],
    bellBehaviors: ['none', 'visual'],
    reconnectBehaviors: ['automatic', 'manual'],
    workspaceShortcutModes: ['default', 'disabled'],
    tmuxHistoryLimit: { min: 0, max: 100_000, step: 1_000 },
    staleSessionCleanupHours: { min: 0, max: 168, step: 1 },
  },
  allowedShells: ['/bin/bash'],
};

function withTestBase(basePath: string, path: string): string {
  return basePath === '/' ? path : `${basePath}${path}`;
}

function parseCsp(value: string): Map<string, string[]> {
  return new Map(
    value.split(';').map((directive) => {
      const [name = '', ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

function config(
  basePath: string,
  publicUrl = PUBLIC_ORIGIN,
  trustProxy: false | string = false,
) {
  return loadConfig({
    APP_BASE_PATH: basePath,
    APP_PUBLIC_URL: publicUrl,
    TRUST_PROXY: trustProxy === false ? 'false' : trustProxy,
    DEFAULT_SHELL: '/bin/bash',
    HOME_DIR: '/home/secret',
  });
}
