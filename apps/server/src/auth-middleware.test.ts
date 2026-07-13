import { once } from 'node:events';
import { createServer, request as httpRequest, type Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedSession } from './auth-types.js';
import {
  clearSessionCookie,
  requireAuthentication,
  requireMutationSecurity,
  resolveAuthentication,
  setSessionCookie,
  touchHttpActivity,
  type AuthMiddlewareOptions,
} from './auth-middleware.js';

const COOKIE = 'a'.repeat(43);
const CSRF = 'b'.repeat(43);
const ORIGIN = 'https://terminal.example';
let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('authentication middleware', () => {
  it('authenticates one strict session cookie and touches only after admission', async () => {
    const calls: string[] = [];
    const options = middlewareOptions({
      authenticateCookie: vi.fn((cookie) => {
        calls.push(`authenticate:${cookie}`);
        return session();
      }),
      touch: vi.fn((id, kind) => calls.push(`touch:${id}:${kind}`)),
    });
    const response = await invoke(options, '/private');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ identityLabel: 'admin' });
    expect(calls).toEqual([
      `authenticate:${COOKIE}`,
      `authenticate:${COOKIE}`,
      `authenticate:${COOKIE}`,
      'touch:session-id:http',
    ]);
  });

  it.each([
    ['missing', undefined],
    ['oversized', `flanterminal_session=${'a'.repeat(257)}`],
    ['invalid characters', 'flanterminal_session=abc%2Fdef'],
  ])('rejects a %s cookie without touching', async (_name, cookie) => {
    const options = middlewareOptions();
    const response = await invoke(
      options,
      '/private',
      cookie === undefined ? {} : { Cookie: cookie },
      cookie !== undefined,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
    expect(options.authService.touch).not.toHaveBeenCalled();
  });

  it('rejects duplicate session cookies from separate raw header lines', async () => {
    const options = middlewareOptions();
    const response = await invokeRaw(options, [
      ['Cookie', `flanterminal_session=${COOKIE}`],
      ['Cookie', `flanterminal_session=${COOKIE}`],
    ]);

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'authentication_required',
    });
    expect(options.authService.authenticateCookie).not.toHaveBeenCalled();
  });

  it('ignores opaque unrelated cookies instead of parsing their values', async () => {
    const options = middlewareOptions();
    const response = await invoke(options, '/private', {
      Cookie: `analytics="quoted%20value"; malformed; flanterminal_session=${COOKIE}`,
    });

    expect(response.status).toBe(200);
    expect(options.authService.authenticateCookie).toHaveBeenCalledWith(COOKIE);
  });

  it('requires the current upstream identity to match the bound session', async () => {
    const authenticate = vi.fn(async () => ({
      mode: 'cloudflare-access' as const,
      identityLabel: 'other@example.com',
      expiresAt: 2_000,
    }));
    const options = middlewareOptions(
      {
        authenticateCookie: vi.fn(() =>
          session({
            mode: 'cloudflare-access',
            identityLabel: 'person@example.com',
            upstreamExpiresAt: 1_500,
          }),
        ),
      },
      {
        mode: 'cloudflare-access',
        cloudflareAccessProvider: { authenticate },
      },
    );
    const response = await invoke(options, '/private');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
    expect(authenticate).toHaveBeenCalledOnce();
    expect(options.authService.touch).not.toHaveBeenCalled();
  });

  it.each(['cloudflare-access', 'trusted-header'] as const)(
    'rejects %s authority revoked while upstream validation is pending',
    async (mode) => {
      const identity = {
        mode,
        identityLabel: 'person@example.com',
        ...(mode === 'cloudflare-access' ? { expiresAt: 2_000 } : {}),
      };
      const provider = deferred<typeof identity>();
      const authenticate = vi.fn(() => provider.promise);
      let authority: AuthenticatedSession | undefined = session({
        mode,
        identityLabel: identity.identityLabel,
        ...(identity.expiresAt === undefined
          ? {}
          : { upstreamExpiresAt: identity.expiresAt }),
      });
      const options = middlewareOptions(
        { authenticateCookie: vi.fn(() => authority) },
        {
          mode,
          ...(mode === 'cloudflare-access'
            ? { cloudflareAccessProvider: { authenticate } }
            : { trustedHeaderProvider: { authenticate } }),
        },
      );
      const response = responseStub();
      const next = vi.fn();

      const pending = requireAuthentication(options)(
        requestStub(['Cookie', `flanterminal_session=${COOKIE}`]),
        response,
        next,
      );
      await vi.waitFor(() => expect(authenticate).toHaveBeenCalledOnce());
      authority = undefined;
      provider.resolve(identity);
      await pending;

      expect(response.status).toHaveBeenCalledWith(401);
      expect(response.json).toHaveBeenCalledWith({
        error: 'authentication_required',
      });
      expect(response.locals).not.toHaveProperty('authSession');
      expect(next).not.toHaveBeenCalled();
      expect(options.authService.authenticateCookie).toHaveBeenCalledTimes(2);
    },
  );

  it('checks exact origin and CSRF before mutation activity', async () => {
    const calls: string[] = [];
    const options = middlewareOptions({
      verifyCsrf: vi.fn((_id, token) => {
        calls.push(`csrf:${token}`);
        return token === CSRF;
      }),
      touch: vi.fn(() => calls.push('touch')),
    });
    const wrongOrigin = await invoke(options, '/mutation', {
      Origin: 'https://wrong.example',
      'Content-Type': 'application/json',
      'X-CSRF-Token': CSRF,
    });
    expect(wrongOrigin.status).toBe(403);
    expect(calls).toEqual([]);

    const badCsrf = await invoke(options, '/mutation', {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'wrong',
    });
    expect(badCsrf.status).toBe(403);
    expect(calls).toEqual(['csrf:wrong']);

    calls.length = 0;
    const admitted = await invoke(options, '/mutation', {
      Origin: ORIGIN,
      'Content-Type': 'application/json; charset=utf-8',
      'X-CSRF-Token': CSRF,
    });
    expect(admitted.status).toBe(200);
    expect(calls).toEqual([`csrf:${CSRF}`, 'touch']);
  });

  it('rejects authority revoked while a JSON mutation body is pending', async () => {
    let authority: AuthenticatedSession | undefined = session();
    const touch = vi.fn();
    const options = middlewareOptions({
      authenticateCookie: vi.fn(() => authority),
      touch,
    });
    const bodyPending = deferred<void>();
    const handler = vi.fn(
      (_request: express.Request, response: express.Response) =>
        response.json({ ok: true }),
    );
    const app = express();
    app.post(
      '/slow',
      requireAuthentication(options),
      requireMutationSecurity(options),
      (_request, _response, next) => {
        bodyPending.resolve();
        next();
      },
      express.json({ limit: 16 * 1024, strict: true }),
      touchHttpActivity(options),
      handler,
    );
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const pending = streamedMutation(port);

    await bodyPending.promise;
    authority = undefined;
    pending.request.end('"value"}');
    const response = await pending.response;

    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({
      error: 'authentication_required',
    });
    expect(touch).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates a downstream authentication error exactly once', async () => {
    const marker = new Error('downstream private error');
    const options = middlewareOptions();
    const response = responseStub();
    const errorHandler = vi.fn();

    await dispatchWithErrorHandler(
      requireAuthentication(options),
      requestStub(['Cookie', `flanterminal_session=${COOKIE}`]),
      response,
      marker,
      errorHandler,
    );

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(marker);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(options.logger?.warn).not.toHaveBeenCalled();
    expect(options.logger?.error).not.toHaveBeenCalled();
  });

  it('propagates a downstream activity error exactly once', async () => {
    const marker = new Error('downstream private error');
    const options = middlewareOptions();
    const response = responseStub({ authSession: session() });
    const errorHandler = vi.fn();

    await dispatchWithErrorHandler(
      touchHttpActivity(options),
      requestStub(['Cookie', `flanterminal_session=${COOKIE}`]),
      response,
      marker,
      errorHandler,
    );

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(marker);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(options.logger?.warn).not.toHaveBeenCalled();
    expect(options.logger?.error).not.toHaveBeenCalled();
  });

  it.each(['authentication', 'activity'] as const)(
    'delivers a downstream %s route throw once to the Express error handler',
    async (stage) => {
      const marker = new Error('downstream private error');
      const options = middlewareOptions();
      const errorHandler = vi.fn();

      const response = await invokeThrowingRoute(
        options,
        stage,
        marker,
        errorHandler,
      );

      expect(response.status).toBe(418);
      expect(await response.json()).toEqual({ error: 'propagated' });
      expect(errorHandler).toHaveBeenCalledOnce();
      expect(errorHandler).toHaveBeenCalledWith(marker);
      expect(options.logger?.warn).not.toHaveBeenCalled();
      expect(options.logger?.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'raw-header entry count',
      [
        'Cookie',
        `flanterminal_session=${COOKIE}`,
        ...Array.from({ length: 64 }, (_, index) => [
          `X-Flood-${index}`,
          '',
        ]).flat(),
      ],
    ],
    [
      'total raw-header bytes',
      [
        'Cookie',
        `flanterminal_session=${COOKIE}`,
        'X-Flood',
        'x'.repeat(17 * 1024),
      ],
    ],
    [
      'cookie field-line count',
      Array.from({ length: 9 }, (_, index) => [
        'Cookie',
        index === 0 ? `flanterminal_session=${COOKIE}` : '',
      ]).flat(),
    ],
  ])(
    'rejects excessive %s before cookie authentication',
    async (_name, rawHeaders) => {
      const options = middlewareOptions();

      const resolved = await resolveAuthentication(
        options,
        requestStub(rawHeaders),
      );

      expect(resolved).toBeUndefined();
      expect(options.authService.authenticateCookie).not.toHaveBeenCalled();
    },
  );

  it('sets and clears a path-scoped strict HttpOnly cookie', async () => {
    const app = express();
    app.get('/set', (_request, response) => {
      setSessionCookie(response, COOKIE, '/terminal', true);
      response.end();
    });
    app.get('/clear', (_request, response) => {
      clearSessionCookie(response, '/terminal', true);
      response.end();
    });
    server = createServer(app);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;

    const set = await fetch(`http://127.0.0.1:${port}/set`);
    const cleared = await fetch(`http://127.0.0.1:${port}/clear`);
    expect(set.headers.get('set-cookie')).toBe(
      `flanterminal_session=${COOKIE}; Path=/terminal; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(cleared.headers.get('set-cookie')).toBe(
      'flanterminal_session=; Path=/terminal; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    );
  });
});

function middlewareOptions(
  overrides: Partial<AuthMiddlewareOptions['authService']> = {},
  optionOverrides: Partial<AuthMiddlewareOptions> = {},
): AuthMiddlewareOptions {
  return {
    mode: 'local',
    publicOrigin: ORIGIN,
    authService: {
      authenticateCookie: vi.fn(() => session()),
      verifyCsrf: vi.fn((_id, supplied) => supplied === CSRF),
      touch: vi.fn(),
      ...overrides,
    },
    logger: { warn: vi.fn(), error: vi.fn() },
    ...optionOverrides,
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
    idleExpiresAt: 1_000,
    absoluteExpiresAt: 2_000,
    ...overrides,
  });
}

async function invoke(
  options: AuthMiddlewareOptions,
  path: '/private' | '/mutation',
  headers: Record<string, string> = {},
  includeDefaultCookie = true,
) {
  server = createMiddlewareServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method: path === '/mutation' ? 'POST' : 'GET',
    headers: {
      ...(includeDefaultCookie
        ? { Cookie: `flanterminal_session=${COOKIE}` }
        : {}),
      ...headers,
    },
    ...(path === '/mutation' ? { body: '{}' } : {}),
  });
}

async function invokeRaw(
  options: AuthMiddlewareOptions,
  headers: ReadonlyArray<readonly [string, string]>,
) {
  server = createMiddlewareServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/private',
          headers: {
            Cookie: headers.map(([, value]) => value),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end();
    },
  );
}

async function invokeThrowingRoute(
  options: AuthMiddlewareOptions,
  stage: 'authentication' | 'activity',
  marker: Error,
  errorHandler: (error: unknown) => void,
): Promise<Response> {
  const app = express();
  app.get(
    '/throws',
    requireAuthentication(options),
    ...(stage === 'activity' ? [touchHttpActivity(options)] : []),
    () => {
      throw marker;
    },
  );
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      errorHandler(error);
      response.status(418).json({ error: 'propagated' });
    },
  );
  server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return await fetch(`http://127.0.0.1:${port}/throws`, {
    headers: { Cookie: `flanterminal_session=${COOKIE}` },
  });
}

function createMiddlewareServer(options: AuthMiddlewareOptions): Server {
  const app = express();
  app.get(
    '/private',
    requireAuthentication(options),
    touchHttpActivity(options),
    (_request, response) => {
      const authenticated = response.locals.authSession as AuthenticatedSession;
      response.json({ identityLabel: authenticated.identityLabel });
    },
  );
  app.post(
    '/mutation',
    requireAuthentication(options),
    requireMutationSecurity(options),
    touchHttpActivity(options),
    (_request, response) => response.json({ ok: true }),
  );
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      void error;
      response.status(500).json({ error: 'operation_failed' });
    },
  );
  return createServer(app);
}

function requestStub(rawHeaders: string[]): express.Request {
  return {
    rawHeaders,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as express.Request;
}

function responseStub(locals: Record<string, unknown> = {}) {
  const response = {
    locals,
    set: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  response.set.mockReturnValue(response);
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response as unknown as express.Response & {
    set: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

async function dispatchWithErrorHandler(
  middleware: express.RequestHandler,
  request: express.Request,
  response: express.Response,
  marker: Error,
  errorHandler: (error: unknown) => void,
): Promise<void> {
  try {
    await middleware(request, response, () => {
      throw marker;
    });
    await Promise.resolve();
    await Promise.resolve();
  } catch (error) {
    errorHandler(error);
  }
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
          path: '/slow',
          method: 'POST',
          headers: {
            Cookie: `flanterminal_session=${COOKIE}`,
            Origin: ORIGIN,
            'Content-Type': 'application/json',
            'X-CSRF-Token': CSRF,
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
      request.write('{"value":');
    },
  );
  return Object.freeze({ request, response });
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
