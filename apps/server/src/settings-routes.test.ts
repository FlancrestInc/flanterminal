import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';

import {
  MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  type WorkspaceSettings,
  type WorkspaceSettingsConstraints,
} from '@flanterminal/shared';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthEventLogger,
  AuthMiddlewareService,
} from './auth-middleware.js';
import type { AuthenticatedSession } from './auth-types.js';
import type { ReplaceResult } from './secure-json-file.js';
import {
  createSettingsRouter,
  type SettingsRouteStore,
} from './settings-routes.js';

const COOKIE = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);
const ORIGIN = 'https://terminal.example';

const defaults: WorkspaceSettings = {
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
  customTerminalPalette: MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
};

const constraints: WorkspaceSettingsConstraints = {
  limits: {
    fontFamilies: ['jetbrains-mono-nerd', 'system-monospace'],
    fontSize: { min: 10, max: 24, step: 1 },
    lineHeight: { min: 1, max: 1.5, step: 0.05 },
    letterSpacing: { min: 0, max: 2, step: 1 },
    scrollback: { min: 1_000, max: 50_000, step: 1_000 },
    themes: ['dark', 'light'],
    cursorStyles: ['block', 'bar'],
    bellBehaviors: ['none', 'visual'],
    reconnectBehaviors: ['automatic', 'manual'],
    workspaceShortcutModes: ['default', 'disabled'],
    tmuxHistoryLimit: { min: 0, max: 100_000, step: 1_000 },
    staleSessionCleanupHours: { min: 0, max: 168, step: 1 },
  },
  allowedShells: ['/bin/bash', '/bin/zsh'],
};

let server: Server | undefined;
let authority: AuthenticatedSession | undefined;
let current: unknown;
let replaceResult: ReplaceResult;
let store: {
  snapshot: ReturnType<typeof vi.fn<SettingsRouteStore['snapshot']>>;
  replace: ReturnType<typeof vi.fn<SettingsRouteStore['replace']>>;
};
let authService: {
  authenticateCookie: ReturnType<
    typeof vi.fn<AuthMiddlewareService['authenticateCookie']>
  >;
  verifyCsrf: ReturnType<typeof vi.fn<AuthMiddlewareService['verifyCsrf']>>;
  touch: ReturnType<typeof vi.fn<AuthMiddlewareService['touch']>>;
};
let logger: {
  warn: ReturnType<typeof vi.fn<AuthEventLogger['warn']>>;
  error: ReturnType<typeof vi.fn<AuthEventLogger['error']>>;
};

beforeEach(() => {
  authority = session();
  current = structuredClone(defaults);
  replaceResult = { state: 'committed' };
  store = {
    snapshot: vi.fn(() => current as WorkspaceSettings),
    replace: vi.fn(async (candidate: WorkspaceSettings) => {
      if (replaceResult.state !== 'not_committed') {
        current = structuredClone(candidate);
      }
      return replaceResult;
    }),
  };
  authService = {
    authenticateCookie: vi.fn(() => authority),
    verifyCsrf: vi.fn(
      (_id: string, token: string | undefined) => token === CSRF,
    ),
    touch: vi.fn(),
  };
  logger = { warn: vi.fn(), error: vi.fn() };
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('createSettingsRouter', () => {
  it('returns the validated authoritative settings document with no-store', async () => {
    const response = await request('/api/settings');

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({
      settings: defaults,
      limits: constraints.limits,
      allowedShells: constraints.allowedShells,
    });
    expect(store.snapshot).toHaveBeenCalledOnce();
    expect(authService.touch).toHaveBeenCalledWith('session-id', 'http');
  });

  it('rejects an unauthenticated read before store access or activity', async () => {
    authority = undefined;

    const response = await request('/api/settings', {}, false);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
    expect(store.snapshot).not.toHaveBeenCalled();
    expect(authService.touch).not.toHaveBeenCalled();
  });

  it('validates, touches, replaces, and returns the newly authoritative document', async () => {
    const calls: string[] = [];
    authService.touch.mockImplementation(() => calls.push('touch'));
    store.replace.mockImplementation(async (candidate: WorkspaceSettings) => {
      calls.push(`replace:${candidate.theme}`);
      current = structuredClone(candidate);
      return { state: 'committed' };
    });
    const next = { ...defaults, theme: 'light' as const };

    const response = await mutation({ settings: next });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      settings: next,
      limits: constraints.limits,
      allowedShells: constraints.allowedShells,
    });
    expect(calls).toEqual(['touch', 'replace:light']);
    expect(store.replace).toHaveBeenCalledWith(next);
  });

  it.each([
    ['missing settings', {}],
    ['unknown mutation field', { settings: defaults, secret: true }],
    ['unknown setting field', { settings: { ...defaults, secret: true } }],
    ['out of range setting', { settings: { ...defaults, fontSize: 25 } }],
    ['misaligned setting', { settings: { ...defaults, scrollback: 10_001 } }],
    [
      'disallowed shell',
      { settings: { ...defaults, defaultShell: '/bin/fish' } },
    ],
  ])('rejects %s before touch or replacement', async (_name, body) => {
    const response = await mutation(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(authService.touch).not.toHaveBeenCalled();
    expect(store.replace).not.toHaveBeenCalled();
  });

  it.each(['{', 'null', '[]', '"value"'])(
    'rejects malformed or non-object JSON %s with a bounded error',
    async (body) => {
      const response = await request('/api/settings', {
        method: 'PUT',
        headers: mutationHeaders(),
        body,
      });
      const responseBody = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(responseBody)).toEqual({ error: 'invalid_request' });
      expect(responseBody.length).toBeLessThan(100);
      expect(authService.touch).not.toHaveBeenCalled();
      expect(store.replace).not.toHaveBeenCalled();
    },
  );

  it('bounds a rejected replacement without leaking through HTTP or logs', async () => {
    const privateMessage = 'private secret at /home/admin/settings.json';
    store.replace.mockRejectedValueOnce(new Error(privateMessage));

    const response = await mutation({ settings: defaults });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'operation_failed' });
    expect(body).not.toContain('private');
    expect(body).not.toContain('secret');
    expect(body).not.toContain('/home');
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith('settings_route_failed', {
      category: 'operation_failed',
    });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
      privateMessage,
    );
  });

  it('rejects a body over 16 KiB before touch or replacement', async () => {
    const response = await mutation({
      settings: defaults,
      padding: 'x'.repeat(17 * 1024),
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(body)).toEqual({ error: 'invalid_request' });
    expect(body.length).toBeLessThan(100);
    expect(authService.touch).not.toHaveBeenCalled();
    expect(store.replace).not.toHaveBeenCalled();
  });

  it('requires JSON, exact origin, and a valid CSRF token before activity', async () => {
    const noJson = await request('/api/settings', {
      method: 'PUT',
      headers: {
        Cookie: `flanterminal_session=${COOKIE}`,
        Origin: ORIGIN,
        'X-CSRF-Token': CSRF,
        'Content-Type': 'text/plain',
      },
      body: '{}',
    });
    const wrongOrigin = await request('/api/settings', {
      method: 'PUT',
      headers: { ...mutationHeaders(), Origin: 'https://wrong.example' },
      body: JSON.stringify({ settings: defaults }),
    });
    const badCsrf = await request('/api/settings', {
      method: 'PUT',
      headers: { ...mutationHeaders(), 'X-CSRF-Token': 'wrong' },
      body: JSON.stringify({ settings: defaults }),
    });

    expect(noJson.status).toBe(415);
    expect(wrongOrigin.status).toBe(403);
    expect(badCsrf.status).toBe(403);
    expect(store.replace).not.toHaveBeenCalled();
    expect(authService.touch).not.toHaveBeenCalled();
  });

  it.each([
    ['not_committed', 500, 'operation_failed', 'dark'],
    ['committed_durability_uncertain', 500, 'durability_uncertain', 'light'],
  ] as const)(
    'maps %s and preserves the authoritative document',
    async (state, status, error, authoritativeTheme) => {
      replaceResult = { state };
      const response = await mutation({
        settings: { ...defaults, theme: 'light' },
      });

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect((current as WorkspaceSettings).theme).toBe(authoritativeTheme);

      const readable = await request('/api/settings');
      expect(readable.status).toBe(200);
      expect((await readable.json()).settings.theme).toBe(authoritativeTheme);
    },
  );

  it('rejects authority revoked while the mutation body is pending', async () => {
    const port = await listen();
    const pending = streamedMutation(port);

    await vi.waitFor(() =>
      expect(authService.authenticateCookie).toHaveBeenCalledTimes(2),
    );
    authority = undefined;
    pending.request.end(JSON.stringify({ settings: defaults }).slice(1));
    const response = await pending.response;

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'authentication_required',
    });
    expect(store.replace).not.toHaveBeenCalled();
    expect(authService.touch).not.toHaveBeenCalled();
  });

  it('bounds invalid authoritative state and does not touch', async () => {
    current = { ...defaults, secret: '/home/private/key' };

    const response = await request('/api/settings');
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({ error: 'operation_failed' });
    expect(body).not.toContain('secret');
    expect(body).not.toContain('/home');
    expect(authService.touch).not.toHaveBeenCalled();
  });

  it.each(['/api/settings/', '/api/Settings', '/api/settings/extra'])(
    'rejects non-exact route %s without store or activity',
    async (path) => {
      const response = await request(path);

      expect(response.status).toBe(404);
      expect(store.snapshot).not.toHaveBeenCalled();
      expect(authService.touch).not.toHaveBeenCalled();
    },
  );
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

async function mutation(body: unknown): Promise<Response> {
  return request('/api/settings', {
    method: 'PUT',
    headers: mutationHeaders(),
    body: JSON.stringify(body),
  });
}

function mutationHeaders(): Record<string, string> {
  return {
    Cookie: `flanterminal_session=${COOKIE}`,
    Origin: ORIGIN,
    'X-CSRF-Token': CSRF,
    'Content-Type': 'application/json',
  };
}

async function listen(): Promise<number> {
  if (server === undefined) {
    const app = express();
    app.use(
      '/api',
      createSettingsRouter({
        mode: 'local',
        publicOrigin: ORIGIN,
        authService,
        store,
        constraints,
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

function session(): AuthenticatedSession {
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
          path: '/api/settings',
          method: 'PUT',
          headers: mutationHeaders(),
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
