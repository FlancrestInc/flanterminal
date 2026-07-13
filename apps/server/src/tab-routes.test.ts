import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';

import type { TabView } from '@flanterminal/shared';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthMiddlewareService } from './auth-middleware.js';
import type { AuthenticatedSession } from './auth-types.js';
import {
  InvalidSessionStateError,
  OperationFailedError,
  TabNotFoundError as SessionTabNotFoundError,
} from './session-manager.js';
import {
  OrderConflictError,
  SessionLimitError,
  TabNotFoundError as StoreTabNotFoundError,
} from './tab-store.js';

const FIXED_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
import {
  createTabRouter,
  type TabRouteSessions,
  type TabRouteStore,
} from './tab-routes.js';

const PUBLIC_ORIGIN = 'https://terminal.example';
const COOKIE = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);
const SECOND_ID = '123e4567-e89b-42d3-a456-426614174000';
const NOW = '2026-07-11T12:00:00.000Z';

let server: Server | undefined;
let authority: AuthenticatedSession | undefined;
let authService: {
  authenticateCookie: ReturnType<
    typeof vi.fn<AuthMiddlewareService['authenticateCookie']>
  >;
  verifyCsrf: ReturnType<typeof vi.fn<AuthMiddlewareService['verifyCsrf']>>;
  touch: ReturnType<typeof vi.fn<AuthMiddlewareService['touch']>>;
};
let store: {
  create: ReturnType<typeof vi.fn<TabRouteStore['create']>>;
  rename: ReturnType<typeof vi.fn<TabRouteStore['rename']>>;
  reorder: ReturnType<typeof vi.fn<TabRouteStore['reorder']>>;
};
let sessions: {
  collectionView: ReturnType<typeof vi.fn<TabRouteSessions['collectionView']>>;
  view: ReturnType<typeof vi.fn<TabRouteSessions['view']>>;
  terminate: ReturnType<typeof vi.fn<TabRouteSessions['terminate']>>;
  recreate: ReturnType<typeof vi.fn<TabRouteSessions['recreate']>>;
  restart: ReturnType<typeof vi.fn<TabRouteSessions['restart']>>;
  restartBridge: ReturnType<typeof vi.fn<TabRouteSessions['restartBridge']>>;
  closeTab: ReturnType<typeof vi.fn<TabRouteSessions['closeTab']>>;
};

beforeEach(() => {
  authority = authSession();
  authService = {
    authenticateCookie: vi.fn(() => authority),
    verifyCsrf: vi.fn((_id, token) => token === CSRF),
    touch: vi.fn(),
  };
  store = {
    create: vi.fn(async () => record(FIXED_SESSION_ID, 'Terminal 1', 0)),
    rename: vi.fn(async (_id, name) => record(FIXED_SESSION_ID, name, 0)),
    reorder: vi.fn(async () => ({ structureRevision: 2, tabs: [] })),
  };
  sessions = {
    collectionView: vi.fn(async () => collection()),
    view: vi.fn(async (id) => view(id)),
    terminate: vi.fn(async (id) => view(id, 'stopped')),
    recreate: vi.fn(async (id) => view(id)),
    restart: vi.fn(async (id) => view(id)),
    restartBridge: vi.fn(async (id) => view(id)),
    closeTab: vi.fn(async () => undefined),
  };
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('createTabRouter', () => {
  it('rejects an unauthenticated collection read before services or activity', async () => {
    authority = undefined;

    const response = await request('/api/tabs', {}, false);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
    expect(sessions.collectionView).not.toHaveBeenCalled();
    expect(authService.touch).not.toHaveBeenCalled();
  });

  it('rejects an invalid CSRF mutation before services or activity', async () => {
    const response = await request('/api/tabs', {
      method: 'POST',
      headers: { ...jsonHeaders(), 'X-CSRF-Token': 'wrong' },
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'csrf_invalid' });
    expect(totalMutationCalls()).toBe(0);
    expect(authService.touch).not.toHaveBeenCalled();
  });

  it('touches authenticated activity for every accepted read and mutation', async () => {
    const operations: ReadonlyArray<
      readonly [string, RequestInit | undefined, number]
    > = [
      ['/api/tabs', undefined, 200],
      [`/api/tabs/${FIXED_SESSION_ID}/session`, undefined, 200],
      ['/api/tabs', mutationInit('POST', {}), 201],
      [
        '/api/tabs/order',
        mutationInit('PUT', {
          structureRevision: 1,
          ids: [SECOND_ID, FIXED_SESSION_ID],
        }),
        200,
      ],
      [
        `/api/tabs/${FIXED_SESSION_ID}`,
        mutationInit('PATCH', { displayName: 'Logs' }),
        200,
      ],
      [
        `/api/tabs/${FIXED_SESSION_ID}`,
        { method: 'DELETE', headers: mutationHeaders(false) },
        204,
      ],
      [
        `/api/tabs/${FIXED_SESSION_ID}/session/terminate`,
        mutationInit('POST', {}),
        200,
      ],
      [
        `/api/tabs/${FIXED_SESSION_ID}/session/recreate`,
        mutationInit('POST', {}),
        200,
      ],
      [
        `/api/tabs/${FIXED_SESSION_ID}/session/restart`,
        mutationInit('POST', {}),
        200,
      ],
      [
        `/api/tabs/${FIXED_SESSION_ID}/bridge/restart`,
        mutationInit('POST', {}),
        200,
      ],
    ];

    for (const [path, init, expectedStatus] of operations) {
      const response = await request(path, init);
      expect(response.status).toBe(expectedStatus);
    }

    expect(authService.touch).toHaveBeenCalledTimes(operations.length);
    expect(authService.touch).toHaveBeenCalledWith('session-id', 'http');
  });

  it('returns the authoritative collection with no-store', async () => {
    const response = await request('/api/tabs');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual(collection());
    expect(sessions.collectionView).toHaveBeenCalledOnce();
  });

  it('creates metadata before returning the session view', async () => {
    const calls: string[] = [];
    store.create.mockImplementation(async (name) => {
      calls.push(`create:${name}`);
      return record(FIXED_SESSION_ID, name ?? 'Terminal 1', 0);
    });
    sessions.view.mockImplementation(async (id) => {
      calls.push(`view:${id}`);
      return view(id, 'running', 'Work');
    });

    const response = await mutation('/api/tabs', 'POST', {
      displayName: 'Work',
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual(
      view(FIXED_SESSION_ID, 'running', 'Work'),
    );
    expect(calls).toEqual([`create:Work`, `view:${FIXED_SESSION_ID}`]);
  });

  it('allows an empty create body and passes undefined', async () => {
    const response = await mutation('/api/tabs', 'POST', {});

    expect(response.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith(undefined);
  });

  it('renames metadata before returning the current session view', async () => {
    const response = await mutation(`/api/tabs/${FIXED_SESSION_ID}`, 'PATCH', {
      displayName: 'Logs',
    });

    expect(response.status).toBe(200);
    expect(store.rename).toHaveBeenCalledWith(FIXED_SESSION_ID, 'Logs');
    expect(sessions.view).toHaveBeenCalledWith(FIXED_SESSION_ID);
  });

  it('reorders metadata then returns the authoritative collection view', async () => {
    const response = await mutation('/api/tabs/order', 'PUT', {
      structureRevision: 1,
      ids: [SECOND_ID, FIXED_SESSION_ID],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(collection());
    expect(store.reorder).toHaveBeenCalledWith(1, [
      SECOND_ID,
      FIXED_SESSION_ID,
    ]);
    expect(sessions.collectionView).toHaveBeenCalledOnce();
  });

  it('closes a tab with a bodyless 204 and does not require JSON', async () => {
    const response = await request(`/api/tabs/${FIXED_SESSION_ID}`, {
      method: 'DELETE',
      headers: mutationHeaders(false),
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(sessions.closeTab).toHaveBeenCalledWith(FIXED_SESSION_ID);
    expect(authService.touch).toHaveBeenCalledOnce();
  });

  it('rejects authority revoked while a mutation body is pending', async () => {
    const port = await listen();
    const pending = streamedMutation(port);

    await vi.waitFor(() =>
      expect(authService.authenticateCookie).toHaveBeenCalledTimes(2),
    );
    authority = undefined;
    pending.request.end('}');
    const response = await pending.response;

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'authentication_required',
    });
    expect(store.create).not.toHaveBeenCalled();
    expect(authService.touch).not.toHaveBeenCalled();
  });

  it('returns one tab session view with no-store', async () => {
    const response = await request(`/api/tabs/${FIXED_SESSION_ID}/session`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual(view(FIXED_SESSION_ID));
    expect(sessions.view).toHaveBeenCalledWith(FIXED_SESSION_ID);
  });

  it.each([
    ['terminate', 'terminate', 'stopped'],
    ['recreate', 'recreate', 'running'],
    ['restart', 'restart', 'running'],
  ] as const)(
    'dispatches session %s with an exact empty body',
    async (path, method, state) => {
      const response = await mutation(
        `/api/tabs/${FIXED_SESSION_ID}/session/${path}`,
        'POST',
        {},
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(view(FIXED_SESSION_ID, state));
      expect(sessions[method]).toHaveBeenCalledWith(FIXED_SESSION_ID);
    },
  );

  it('restarts a bridge at the tab-level route', async () => {
    const response = await mutation(
      `/api/tabs/${FIXED_SESSION_ID}/bridge/restart`,
      'POST',
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view(FIXED_SESSION_ID));
    expect(sessions.restartBridge).toHaveBeenCalledWith(FIXED_SESSION_ID);
  });

  it('does not accept the obsolete session bridge route', async () => {
    const response = await mutation(
      `/api/tabs/${FIXED_SESSION_ID}/session/bridge/restart`,
      'POST',
      {},
    );

    expect(response.status).toBe(404);
    expect(sessions.restartBridge).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/api/tabs', { unexpected: true }],
    [
      'PATCH',
      `/api/tabs/${FIXED_SESSION_ID}`,
      { displayName: 'x', nested: {} },
    ],
    ['PUT', '/api/tabs/order', { structureRevision: '1', ids: [] }],
    ['POST', `/api/tabs/${FIXED_SESSION_ID}/session/restart`, { force: true }],
  ])('rejects strict invalid %s %s bodies', async (method, path, body) => {
    const response = await mutation(path, method, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(totalMutationCalls()).toBe(0);
  });

  it.each(['{', 'null', '[]', '"value"'])(
    'rejects malformed or non-object JSON %s',
    async (body) => {
      const response = await request('/api/tabs', {
        method: 'POST',
        headers: jsonHeaders(),
        body,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
      expect(store.create).not.toHaveBeenCalled();
    },
  );

  it('rejects JSON larger than 16 KiB with a stable bounded response', async () => {
    const response = await request('/api/tabs', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ displayName: 'x'.repeat(17 * 1024) }),
    });

    const responseBody = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(responseBody)).toEqual({ error: 'invalid_request' });
    expect(responseBody.length).toBeLessThan(100);
    expect(store.create).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an unsupported JSON charset',
      { 'Content-Type': 'application/json; charset=iso-8859-1' },
      '{}',
    ],
    [
      'an unsupported content encoding',
      { 'Content-Type': 'application/json', 'Content-Encoding': 'compress' },
      '{}',
    ],
    [
      'a corrupt Brotli body',
      { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
      'not-brotli-private-input',
    ],
  ])(
    'bounds and rejects %s as an invalid request',
    async (_name, headers, body) => {
      const response = await request('/api/tabs', {
        method: 'POST',
        headers: {
          Origin: PUBLIC_ORIGIN,
          'X-CSRF-Token': CSRF,
          ...headers,
        },
        body,
      });
      const responseBody = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(responseBody)).toEqual({ error: 'invalid_request' });
      expect(responseBody.length).toBeLessThan(100);
      expect(responseBody).not.toContain('iso-8859-1');
      expect(responseBody).not.toContain('brotli');
      expect(responseBody).not.toContain('private');
      expect(store.create).not.toHaveBeenCalled();
    },
  );

  it('requires exact application/json while accepting a charset', async () => {
    const rejected = await request('/api/tabs', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        'X-CSRF-Token': CSRF,
        'Content-Type': 'text/plain',
      },
      body: '{}',
    });
    const accepted = await request('/api/tabs', {
      method: 'POST',
      headers: {
        Origin: PUBLIC_ORIGIN,
        'X-CSRF-Token': CSRF,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: '{}',
    });

    expect(rejected.status).toBe(415);
    expect(await rejected.json()).toEqual({ error: 'json_required' });
    expect(accepted.status).toBe(201);
  });

  it.each([
    undefined,
    'https://wrong.example',
    `${PUBLIC_ORIGIN}, ${PUBLIC_ORIGIN}`,
  ])(
    'rejects missing, wrong, or combined Origin before body parsing: %s',
    async (origin) => {
      const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
      if (origin !== undefined) headers.Origin = origin;
      const response = await request('/api/tabs', {
        method: 'POST',
        headers,
        body: 'not-json',
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'origin_forbidden' });
      expect(store.create).not.toHaveBeenCalled();
    },
  );

  it('rejects multiple Origin header lines before services run', async () => {
    const response = await rawRequest('/api/tabs');

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: 'origin_forbidden' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it.each([
    '550E8400-E29B-41D4-A716-446655440000',
    `${FIXED_SESSION_ID}%2Frestart`,
    `${FIXED_SESSION_ID}%5Crestart`,
    `%35${FIXED_SESSION_ID.slice(1)}`,
    '..',
    '%2e%2e',
    `.${FIXED_SESSION_ID}`,
  ])(
    'rejects noncanonical tab identifier %s without service calls',
    async (id) => {
      const response = await request(`/api/tabs/${id}/session`);

      expect([400, 404]).toContain(response.status);
      expect(sessions.view).not.toHaveBeenCalled();
    },
  );

  it.each([
    `/api/tabs/${FIXED_SESSION_ID}/session/`,
    `/api/TABS/${FIXED_SESSION_ID}/session`,
    `/API/tabs/${FIXED_SESSION_ID}/session`,
  ])(
    'rejects noncanonical route alias %s without service calls',
    async (path) => {
      const response = await request(path);

      expect(response.status).toBe(404);
      expect(sessions.view).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new StoreTabNotFoundError(), 404, 'tab_not_found'],
    [new SessionTabNotFoundError(), 404, 'tab_not_found'],
    [new SessionLimitError(), 409, 'session_limit'],
    [new OrderConflictError(), 409, 'order_conflict'],
    [new InvalidSessionStateError(), 409, 'invalid_session_state'],
    [new OperationFailedError(view(FIXED_SESSION_ID)), 500, 'operation_failed'],
    [new Error('secret /home/user output'), 500, 'operation_failed'],
    [
      Object.assign(new Error('upstream secret'), { status: 400 }),
      500,
      'operation_failed',
    ],
    [
      Object.assign(new Error('spoofed parser failure'), {
        type: 'entity.parse.failed',
        code: 'Z_DATA_ERROR',
        status: 400,
      }),
      500,
      'operation_failed',
    ],
  ] as const)(
    'maps service rejection to stable HTTP errors',
    async (error, status, code) => {
      sessions.restart.mockRejectedValueOnce(error);
      const response = await mutation(
        `/api/tabs/${FIXED_SESSION_ID}/session/restart`,
        'POST',
        {},
      );
      const body = await response.text();

      expect(response.status).toBe(status);
      expect(JSON.parse(body)).toEqual({ error: code });
      expect(body).not.toContain('secret');
      expect(body).not.toContain('/home');
      expect(body).not.toContain('bridgePid');
      expect(body.length).toBeLessThan(100);
    },
  );

  it('returns a JSON 404 for unknown API paths', async () => {
    const response = await request('/api/tabs/no/such/operation');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
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

async function mutation(
  path: string,
  method: string,
  body: unknown,
): Promise<Response> {
  return request(path, {
    ...mutationInit(method, body),
  });
}

function mutationInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  };
}

function jsonHeaders(): Record<string, string> {
  return mutationHeaders(true);
}

function mutationHeaders(includeJson: boolean): Record<string, string> {
  return {
    Origin: PUBLIC_ORIGIN,
    'X-CSRF-Token': CSRF,
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function rawRequest(
  path: string,
): Promise<{ status: number; body: string }> {
  const port = await listen();
  return new Promise((resolve, reject) => {
    const request = globalThis.process.getBuiltinModule('node:http').request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        Origin: [PUBLIC_ORIGIN, PUBLIC_ORIGIN],
        Cookie: `flanterminal_session=${COOKIE}`,
        'X-CSRF-Token': CSRF,
        'Content-Type': 'application/json',
      },
    });
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    request.on('error', reject);
    request.end('{}');
  });
}

async function listen(): Promise<number> {
  if (server === undefined) {
    const app = express();
    app.use(
      '/api',
      createTabRouter({
        mode: 'local',
        publicOrigin: PUBLIC_ORIGIN,
        authService,
        logger: { warn: vi.fn(), error: vi.fn() },
        store,
        sessions,
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
  if (address === null || typeof address === 'string') {
    throw new Error('listen failed');
  }
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

function streamedMutation(port: number): Readonly<{
  request: ReturnType<typeof httpRequest>;
  response: Promise<{ status: number; body: string }>;
}> {
  let request!: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/api/tabs',
          method: 'POST',
          headers: {
            Cookie: `flanterminal_session=${COOKIE}`,
            ...jsonHeaders(),
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      request.on('error', reject);
      request.write('{');
    },
  );
  return Object.freeze({ request, response });
}

function record(id: string, displayName: string, position: number) {
  return {
    id,
    displayName,
    position,
    createdAt: NOW,
    lastActivityAt: NOW,
    desiredState: 'active' as const,
  };
}

function view(
  id: string,
  state: TabView['session']['state'] = 'running',
  displayName = 'Terminal 1',
): TabView {
  return {
    ...record(id, displayName, id === FIXED_SESSION_ID ? 0 : 1),
    session: { state, attached: false, bridgePid: null },
  };
}

function collection() {
  return {
    structureRevision: 1,
    tabs: [view(FIXED_SESSION_ID), view(SECOND_ID)],
  };
}

function totalMutationCalls(): number {
  return (
    store.create.mock.calls.length +
    store.rename.mock.calls.length +
    store.reorder.mock.calls.length +
    sessions.terminate.mock.calls.length +
    sessions.recreate.mock.calls.length +
    sessions.restart.mock.calls.length +
    sessions.restartBridge.mock.calls.length +
    sessions.closeTab.mock.calls.length
  );
}
