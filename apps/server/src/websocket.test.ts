import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import {
  AUTHENTICATION_REQUIRED,
  AUTHENTICATION_REQUIRED_REASON,
  PROTOCOL_VERSION,
  type TabRecord,
} from '@flanterminal/shared';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeRegistry } from './bridge-registry.js';
import { createWebSocketUpgradeAuthenticator } from './auth-middleware.js';
import type { AuthenticatedSession } from './auth-types.js';
import type { PtyProcess } from './pty.js';
import { SessionManager, TerminalBridgeFactory } from './session-manager.js';
import { WebSocketAuthIndex } from './websocket-auth-index.js';
import type { ApplicationSessionAuthority } from './websocket-auth-index.js';
import type {
  WebSocketUpgradeAuthenticator,
  WebSocketUpgradeRequest,
} from './auth-middleware.js';
import {
  createTerminalWebSocketServer,
  type HeartbeatScheduler,
  type TerminalWebSocketServer,
} from './websocket.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_SESSION_ID = '223e4567-e89b-42d3-a456-426614174000';

const openResources: Array<() => Promise<void>> = [];
const inboxes = new WeakMap<
  WebSocket,
  { messages: string[]; waiters: Array<(message: string) => void> }
>();

afterEach(async () => {
  await Promise.allSettled(openResources.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

describe('terminal websocket server', () => {
  it.each([
    ['missing cookie', 'missing', 0],
    ['expired cookie', 'expired', 1],
    ['wrong-mode cookie', 'wrong-mode', 1],
    ['invalid Cloudflare assertion', 'invalid-provider', 1],
    ['mismatched refreshed identity', 'identity-mismatch', 2],
  ] as const)(
    'rejects %s before tab authorization or WebSocket acceptance',
    async (_case, outcome, expectedCookieChecks) => {
      const valid = authenticatedSession();
      const authenticateAuthority = vi.fn<
        () => ReturnType<typeof authenticatedSession> | undefined
      >(() => valid);
      if (outcome === 'expired')
        authenticateAuthority.mockReturnValue(undefined);
      if (outcome === 'wrong-mode')
        authenticateAuthority.mockReturnValue(
          authenticatedSession({ mode: 'local' }),
        );
      if (outcome === 'identity-mismatch')
        authenticateAuthority
          .mockReturnValueOnce(valid)
          .mockReturnValueOnce(
            authenticatedSession({ identityLabel: 'mallory' }),
          );
      const authService = upgradeAuthService({ authenticateAuthority });
      const provider = {
        authenticate: vi.fn(async () => {
          if (outcome === 'invalid-provider') throw new Error('invalid jwt');
          return {
            mode: 'cloudflare-access' as const,
            identityLabel: 'alice',
            expiresAt: 5_000,
          };
        }),
      };
      const authenticator = createWebSocketUpgradeAuthenticator({
        mode: 'cloudflare-access',
        publicOrigin: 'http://app.test',
        authService,
        cloudflareAccessProvider: provider,
      });
      const index = new WebSocketAuthIndex({
        auth: authenticator,
        maxApplicationSessions: 4,
        maxSockets: 8,
      });
      const authorize = vi.fn();
      const connectSession = vi.fn();
      const server = createServer();
      const gateway = createTerminalWebSocketServer({
        server,
        publicOrigin: 'http://app.test',
        basePath: '/',
        sessionManager: { authorize, connect: connectSession },
        registry: new BridgeRegistry(),
        logger: logger(),
        heartbeatIntervalMs: 30_000,
        upgradeAuthenticator: authenticator,
        authIndex: index,
      });
      const port = await listen(server);
      track(server, gateway);

      expect(
        await rejectedStatus(
          port,
          `/ws/sessions/${SESSION_ID}`,
          'http://app.test',
          outcome === 'missing'
            ? {}
            : {
                Cookie: `flanterminal_session=${'a'.repeat(43)}`,
                'Cf-Access-Jwt-Assertion': 'private.jwt.assertion',
              },
        ),
      ).toBe(401);
      expect(authorize).not.toHaveBeenCalled();
      expect(connectSession).not.toHaveBeenCalled();
      expect(authenticateAuthority).toHaveBeenCalledTimes(expectedCookieChecks);
      expect(index.connectedCount()).toBe(0);
    },
  );

  it('reuses bounded cookie parsing and revalidates identity after async upstream auth', async () => {
    const first = authenticatedSession({ identityLabel: 'alice' });
    const refreshed = authenticatedSession({ identityLabel: 'mallory' });
    const authenticateAuthority = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(refreshed);
    const provider = {
      authenticate: vi.fn(async () => ({
        mode: 'cloudflare-access' as const,
        identityLabel: 'alice',
        expiresAt: 5_000,
      })),
    };
    const authenticator = createWebSocketUpgradeAuthenticator({
      mode: 'cloudflare-access',
      publicOrigin: 'http://app.test',
      authService: upgradeAuthService({ authenticateAuthority }),
      cloudflareAccessProvider: provider,
    });
    const request = requestView([
      'Origin',
      'http://app.test',
      'Cookie',
      `flanterminal_session=${'a'.repeat(43)}`,
      'Cf-Access-Jwt-Assertion',
      'private.jwt.value',
    ]);

    await expect(authenticator.authenticate(request)).resolves.toBeUndefined();
    expect(authenticateAuthority).toHaveBeenCalledTimes(2);
    expect(provider.authenticate).toHaveBeenCalledOnce();

    const duplicate = requestView([
      'Cookie',
      `flanterminal_session=${'a'.repeat(43)}; flanterminal_session=${'b'.repeat(43)}`,
    ]);
    await expect(
      authenticator.authenticate(duplicate),
    ).resolves.toBeUndefined();
    expect(authenticateAuthority).toHaveBeenCalledTimes(2);

    const oversized = requestView([
      'Cookie',
      `x=${'x'.repeat(9 * 1024)}; flanterminal_session=${'a'.repeat(43)}`,
    ]);
    await expect(
      authenticator.authenticate(oversized),
    ).resolves.toBeUndefined();
    expect(authenticateAuthority).toHaveBeenCalledTimes(2);
  });

  it('contains invalid upstream provider results without logging assertions', async () => {
    const assertion = 'private.jwt.assertion';
    const log = logger();
    const authenticator = createWebSocketUpgradeAuthenticator({
      mode: 'cloudflare-access',
      publicOrigin: 'http://app.test',
      authService: upgradeAuthService(),
      cloudflareAccessProvider: {
        authenticate: vi.fn(async () => {
          throw new Error(assertion);
        }),
      },
      logger: log,
    });

    await expect(
      authenticator.authenticate(
        requestView([
          'Cookie',
          `flanterminal_session=${'a'.repeat(43)}`,
          'Cf-Access-Jwt-Assertion',
          assertion,
        ]),
      ),
    ).resolves.toBeUndefined();
    expect(
      JSON.stringify([
        log.info.mock.calls,
        log.warn.mock.calls,
        log.error.mock.calls,
      ]),
    ).not.toContain(assertion);
  });

  it('bridges text input, resize, and PTY output over a real ws transport', async () => {
    const harness = await createHarness();
    const client = await connect(harness.url);
    const ready = await nextMessage(client);

    expect(JSON.parse(ready)).toEqual({
      v: PROTOCOL_VERSION,
      type: 'ready',
      sessionId: SESSION_ID,
    });

    client.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'input',
        sessionId: SESSION_ID,
        data: 'echo private\n',
      }),
    );
    client.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'resize',
        sessionId: SESSION_ID,
        cols: 120,
        rows: 40,
      }),
    );

    await vi.waitFor(() => {
      expect(harness.pty.write).toHaveBeenCalledWith('echo private\n');
      expect(harness.pty.resize).toHaveBeenCalledWith(120, 40);
    });

    const outputMessage = nextMessage(client);
    harness.emitData('terminal contents');
    expect(JSON.parse(await outputMessage)).toEqual({
      v: PROTOCOL_VERSION,
      type: 'output',
      sessionId: SESSION_ID,
      data: 'terminal contents',
    });
  });

  it.each([
    ['binary', Buffer.from('{}'), true],
    ['malformed', '{private terminal data', false],
    [
      'wrong-version',
      JSON.stringify({
        v: 2,
        type: 'input',
        sessionId: SESSION_ID,
        data: 'private',
      }),
      false,
    ],
    [
      'wrong-direction',
      JSON.stringify({
        v: 1,
        type: 'output',
        sessionId: SESSION_ID,
        data: 'private',
      }),
      false,
    ],
  ])(
    'closes unsupported %s messages with 1008 without logging payloads',
    async (_name, payload, binary) => {
      const harness = await createHarness();
      const client = await connect(harness.url);
      await nextMessage(client);

      client.send(payload, { binary });

      const [code] = (await once(client, 'close')) as [number, Buffer];
      expect(code).toBe(1008);
      expect(JSON.stringify(harness.logger.mock.calls)).not.toContain(
        'private',
      );
      expect(harness.pty.kill).toHaveBeenCalledOnce();
    },
  );

  it('lets ws enforce the 64 KiB transport limit with close code 1009', async () => {
    const harness = await createHarness();
    const client = await connect(harness.url);
    await nextMessage(client);

    client.send('x'.repeat(65_537));

    const [code] = (await once(client, 'close')) as [number, Buffer];
    expect(code).toBe(1009);
    await vi.waitFor(() => expect(harness.pty.kill).toHaveBeenCalledOnce());
  });

  it('rejects origin and route upgrades before calling the session manager', async () => {
    const connectSession = vi.fn().mockRejectedValue(new Error('must not run'));
    const server = createServer();
    const auth = authHarness();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/terminal',
      sessionManager: { authorize: vi.fn(), connect: connectSession },
      registry: new BridgeRegistry(),
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...auth.options,
    });
    const port = await listen(server);
    track(server, gateway);

    expect(
      await rejectedStatus(
        port,
        `/terminal/ws/sessions/${SESSION_ID}`,
        'http://wrong.test',
      ),
    ).toBe(403);
    expect(
      await rejectedStatus(
        port,
        `/ws/sessions/${SESSION_ID}`,
        'http://app.test',
      ),
    ).toBe(404);
    expect(connectSession).not.toHaveBeenCalled();
    expect(
      auth.options.upgradeAuthenticator.authenticate,
    ).not.toHaveBeenCalled();
    expect(auth.index.connectedCount()).toBe(0);
  });

  it('rejects unknown and stopped sessions before upgrading or connecting', async () => {
    const authorize = vi.fn().mockReturnValue(undefined);
    const connectSession = vi.fn();
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: { authorize, connect: connectSession },
      registry: new BridgeRegistry(),
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...authHarness().options,
    });
    const port = await listen(server);
    track(server, gateway);

    expect(
      await rejectedStatus(
        port,
        `/ws/sessions/${SESSION_ID}`,
        'http://app.test',
      ),
    ).toBe(404);
    expect(authorize).toHaveBeenCalledWith(SESSION_ID);
    expect(connectSession).not.toHaveBeenCalled();
  });

  it('passes the authorization token captured before upgrade to connect', async () => {
    const token = Object.freeze({ sessionId: SESSION_ID, generation: 7 });
    const owner = { pid: 11, close: vi.fn(async () => undefined) };
    const authorize = vi.fn().mockReturnValue(token);
    const connectSession = vi.fn().mockResolvedValue(owner);
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: { authorize, connect: connectSession },
      registry: new BridgeRegistry(),
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...authHarness().options,
    });
    const port = await listen(server);
    track(server, gateway);
    const client = await connect(
      `ws://127.0.0.1:${port}/ws/sessions/${SESSION_ID}`,
    );

    expect(JSON.parse(await nextMessage(client))).toMatchObject({
      type: 'ready',
      sessionId: SESSION_ID,
    });
    expect(connectSession).toHaveBeenCalledWith(token, expect.anything(), {
      cols: 80,
      rows: 24,
    });
  });

  it('sends a bounded protocol error and closes 1011 when session setup fails', async () => {
    const registry = new BridgeRegistry();
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: {
        authorize: vi.fn().mockReturnValue({
          sessionId: SESSION_ID,
          generation: 1,
        }),
        connect: vi.fn().mockRejectedValue(new Error('private failure')),
      },
      registry,
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...authHarness().options,
    });
    const port = await listen(server);
    track(server, gateway);
    const client = await connect(
      `ws://127.0.0.1:${port}/ws/sessions/${SESSION_ID}`,
    );

    expect(JSON.parse(await nextMessage(client))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'error',
      sessionId: SESSION_ID,
      code: 'terminal_unavailable',
    });
    const [code] = (await once(client, 'close')) as [number, Buffer];
    expect(code).toBe(1011);
    expect(registry.get(SESSION_ID)).toBeUndefined();
  });

  it('cleans a bridge and registration exactly once after socket close', async () => {
    const harness = await createHarness();
    const remove = vi.spyOn(harness.registry, 'remove');
    const client = await connect(harness.url);
    await nextMessage(client);

    client.close();
    await once(client, 'close');

    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(harness.pty.kill).toHaveBeenCalledOnce();
    expect(harness.registry.get(SESSION_ID)).toBeUndefined();
  });

  it('terminates a client that misses a pong on the next heartbeat tick', async () => {
    const scheduler = fakeScheduler();
    const harness = await createHarness({ scheduler });
    const client = await connect(harness.url, { autoPong: false });
    await nextMessage(client);

    scheduler.tick();
    expect(client.readyState).toBe(WebSocket.OPEN);
    scheduler.tick();

    await once(client, 'close');
    await vi.waitFor(() => expect(harness.pty.kill).toHaveBeenCalledOnce());
    expect(harness.gateway.connectedCount()).toBe(0);
  });

  it('keeps a browser-compatible client alive when automatic pong is received', async () => {
    const scheduler = fakeScheduler();
    const harness = await createHarness({ scheduler });
    const client = await connect(harness.url);
    await nextMessage(client);

    const ping = once(client, 'ping');
    scheduler.tick();
    await ping;
    await new Promise<void>((resolve) => setImmediate(resolve));
    scheduler.tick();

    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('routes repeated upgrades through exclusive session replacement', async () => {
    const harness = await createHarness();
    const first = await connect(harness.url);
    await nextMessage(first);
    const second = await connect(harness.url);
    await nextMessage(second);

    const [code] = (await once(first, 'close')) as [number, Buffer];
    expect(code).toBe(4001);
    expect(harness.preparer).toHaveBeenCalledTimes(2);
    expect(harness.spawn).toHaveBeenCalledTimes(2);
  });

  it('rejects frames for a different tab before writing to the PTY', async () => {
    const harness = await createHarness();
    const client = await connect(harness.url);
    await nextMessage(client);

    client.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'input',
        sessionId: OTHER_SESSION_ID,
        data: 'must not be written',
      }),
    );

    const [code] = (await once(client, 'close')) as [number, Buffer];
    expect(code).toBe(1008);
    expect(harness.pty.write).not.toHaveBeenCalled();
  });

  it('rejects revocation after authentication and before handleUpgrade', async () => {
    const auth = authHarness();
    const authorize = vi.fn(() => {
      auth.revoke();
      return Object.freeze({ sessionId: SESSION_ID, generation: 1 }) as never;
    });
    const connectSession = vi.fn();
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: { authorize, connect: connectSession },
      registry: new BridgeRegistry(),
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...auth.options,
    });
    const port = await listen(server);
    track(server, gateway);

    expect(
      await rejectedStatus(
        port,
        `/ws/sessions/${SESSION_ID}`,
        'http://app.test',
      ),
    ).toBe(401);
    expect(authorize).toHaveBeenCalledOnce();
    expect(connectSession).not.toHaveBeenCalled();
    expect(auth.index.connectedCount()).toBe(0);
  });

  it('closes 4003 when revoked after socket creation and before index insertion', async () => {
    const auth = authHarness();
    const register = vi
      .spyOn(auth.index, 'registerIfActive')
      .mockImplementation(() => {
        auth.revoke();
        return false;
      });
    const connectSession = vi.fn();
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: {
        authorize: vi.fn(
          () => ({ sessionId: SESSION_ID, generation: 1 }) as never,
        ),
        connect: connectSession,
      },
      registry: new BridgeRegistry(),
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...auth.options,
    });
    const port = await listen(server);
    track(server, gateway);
    const client = await connect(
      `ws://127.0.0.1:${port}/ws/sessions/${SESSION_ID}`,
    );

    const [code, reason] = (await once(client, 'close')) as [number, Buffer];
    expect(code).toBe(AUTHENTICATION_REQUIRED);
    expect(reason.toString()).toBe(AUTHENTICATION_REQUIRED_REASON);
    expect(register).toHaveBeenCalledOnce();
    expect(connectSession).not.toHaveBeenCalled();
    expect(auth.index.connectedCount()).toBe(0);
  });

  it('terminates when an authentication race close throws before index insertion', async () => {
    const nativeTerminate = WebSocket.prototype.terminate;
    const close = vi
      .spyOn(WebSocket.prototype, 'close')
      .mockImplementation(() => {
        throw new Error('contained close failure');
      });
    const terminate = vi
      .spyOn(WebSocket.prototype, 'terminate')
      .mockImplementation(function (this: WebSocket) {
        nativeTerminate.call(this);
      });
    const auth = authHarness();
    vi.spyOn(auth.index, 'registerIfActive').mockImplementation(() => false);
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: {
        authorize: vi.fn(
          () => ({ sessionId: SESSION_ID, generation: 1 }) as never,
        ),
        connect: vi.fn(),
      },
      registry: new BridgeRegistry(),
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...auth.options,
    });
    const port = await listen(server);
    track(server, gateway);
    const client = await connect(
      `ws://127.0.0.1:${port}/ws/sessions/${SESSION_ID}`,
    );

    const [code] = (await once(client, 'close')) as [number, Buffer];
    expect(code).toBe(1006);
    expect(close).toHaveBeenCalled();
    expect(terminate).toHaveBeenCalled();
    expect(auth.index.connectedCount()).toBe(0);
  });

  it('terminates a revoked client after close failure before later PTY output', async () => {
    const harness = await createHarness();
    const client = await connect(harness.url);
    await nextMessage(client);
    const nativeTerminate = WebSocket.prototype.terminate;
    vi.spyOn(WebSocket.prototype, 'close').mockImplementation(() => {
      throw new Error('contained close failure');
    });
    const terminate = vi
      .spyOn(WebSocket.prototype, 'terminate')
      .mockImplementation(function (this: WebSocket) {
        nativeTerminate.call(this);
      });
    const closed = once(client, 'close');

    harness.auth.revoke();
    const [code] = (await closed) as [number, Buffer];
    harness.emitData('revoked private output');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(code).toBe(1006);
    expect(terminate).toHaveBeenCalled();
    expect(inboxes.get(client)?.messages).toEqual([]);
    expect(harness.pty.kill).toHaveBeenCalledOnce();
    expect(harness.gateway.connectedCount()).toBe(0);
  });

  it('closes a late bridge owner and removes it when revoked during pending connect', async () => {
    const pending = deferred<void>();
    const auth = authHarness();
    const registry = new BridgeRegistry();
    const owner = { pid: 11, close: vi.fn(async () => undefined) };
    const remove = vi.spyOn(registry, 'remove');
    const connectSession = vi.fn(async () => {
      await pending.promise;
      await registry.replace(SESSION_ID, owner);
      return owner;
    });
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: {
        authorize: vi.fn(
          () => ({ sessionId: SESSION_ID, generation: 1 }) as never,
        ),
        connect: connectSession,
      },
      registry,
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...auth.options,
    });
    const port = await listen(server);
    track(server, gateway);
    const client = await connect(
      `ws://127.0.0.1:${port}/ws/sessions/${SESSION_ID}`,
    );
    await vi.waitFor(() => expect(connectSession).toHaveBeenCalledOnce());

    auth.revoke();
    const closed = once(client, 'close');
    pending.resolve();
    const [code] = (await closed) as [number, Buffer];

    expect(code).toBe(AUTHENTICATION_REQUIRED);
    await vi.waitFor(() => expect(owner.close).toHaveBeenCalledOnce());
    expect(owner.close).toHaveBeenCalledWith(
      AUTHENTICATION_REQUIRED,
      AUTHENTICATION_REQUIRED_REASON,
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(registry.get(SESSION_ID)).toBeUndefined();
    expect(auth.index.connectedCount()).toBe(0);
  });

  it('cleans a late owner once when socket close races pending connect', async () => {
    const pending = deferred<void>();
    const auth = authHarness();
    const registry = new BridgeRegistry();
    const owner = { pid: 12, close: vi.fn(async () => undefined) };
    const remove = vi.spyOn(registry, 'remove');
    const connectSession = vi.fn(async () => {
      await pending.promise;
      await registry.replace(SESSION_ID, owner);
      return owner;
    });
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: {
        authorize: vi.fn(
          () => ({ sessionId: SESSION_ID, generation: 1 }) as never,
        ),
        connect: connectSession,
      },
      registry,
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...auth.options,
    });
    const port = await listen(server);
    track(server, gateway);
    const client = await connect(
      `ws://127.0.0.1:${port}/ws/sessions/${SESSION_ID}`,
    );
    await vi.waitFor(() => expect(connectSession).toHaveBeenCalledOnce());

    client.close();
    await once(client, 'close');
    pending.resolve();

    await vi.waitFor(() => expect(owner.close).toHaveBeenCalledOnce());
    expect(owner.close).toHaveBeenCalledWith(1001, 'socket_closed');
    expect(remove).toHaveBeenCalledOnce();
    expect(registry.get(SESSION_ID)).toBeUndefined();
    expect(auth.index.connectedCount()).toBe(0);
  });

  it('closes and cleans a late owner once when socket error races pending connect', async () => {
    const pending = deferred<void>();
    const auth = authHarness();
    const registry = new BridgeRegistry();
    const owner = { pid: 13, close: vi.fn(async () => undefined) };
    const remove = vi.spyOn(registry, 'remove');
    let connectedPort: unknown;
    const connectSession = vi.fn(async (...args: unknown[]) => {
      connectedPort = args[1];
      await pending.promise;
      await registry.replace(SESSION_ID, owner);
      return owner;
    });
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: {
        authorize: vi.fn(
          () => ({ sessionId: SESSION_ID, generation: 1 }) as never,
        ),
        connect: connectSession,
      },
      registry,
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      ...auth.options,
    });
    const port = await listen(server);
    track(server, gateway);
    const client = await connect(
      `ws://127.0.0.1:${port}/ws/sessions/${SESSION_ID}`,
    );
    await vi.waitFor(() => expect(connectedPort).toBeDefined());
    const internalSocket = (connectedPort as { socket: WebSocket }).socket;
    const closed = once(client, 'close');

    internalSocket.emit('error', new Error('private socket failure'));
    pending.resolve();
    const [code] = (await closed) as [number, Buffer];

    expect(code).toBe(1011);
    await vi.waitFor(() => expect(owner.close).toHaveBeenCalledOnce());
    expect(owner.close).toHaveBeenCalledWith(1001, 'socket_closed');
    expect(remove).toHaveBeenCalledOnce();
    expect(registry.get(SESSION_ID)).toBeUndefined();
    expect(auth.index.connectedCount()).toBe(0);
    expect(internalSocket.listenerCount('pong')).toBe(0);
    expect(internalSocket.listenerCount('error')).toBe(0);
  });

  it('sweeps authentication expiry on heartbeat and disposes index exactly once', async () => {
    const scheduler = fakeScheduler();
    const auth = authHarness();
    const sweep = vi.spyOn(auth.index, 'sweepExpired');
    const dispose = vi.spyOn(auth.index, 'dispose');
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: {
        authorize: vi.fn(
          () => ({ sessionId: SESSION_ID, generation: 1 }) as never,
        ),
        connect: vi.fn().mockResolvedValue({ close: vi.fn() }),
      },
      registry: new BridgeRegistry(),
      logger: logger(),
      heartbeatIntervalMs: 30_000,
      scheduler,
      ...auth.options,
    });
    await listen(server);
    track(server, gateway);

    scheduler.tick();
    expect(sweep).toHaveBeenCalledOnce();
    await gateway.close();
    await gateway.close();
    expect(dispose).toHaveBeenCalledOnce();
    expect(auth.unsubscribe).toHaveBeenCalledOnce();
    expect(gateway.connectedCount()).toBe(0);
  });

  it('closes authenticated sockets when the HTTP server closes independently', async () => {
    const harness = await createHarness();
    const client = await connect(harness.url);
    await nextMessage(client);
    const closed = once(client, 'close');

    await new Promise<void>((resolve) => harness.server.close(() => resolve()));
    const [code, reason] = (await closed) as [number, Buffer];

    expect(code).toBe(AUTHENTICATION_REQUIRED);
    expect(reason.toString()).toBe(AUTHENTICATION_REQUIRED_REASON);
    expect(harness.gateway.connectedCount()).toBe(0);
    expect(harness.auth.unsubscribe).toHaveBeenCalledOnce();
  });
});

async function createHarness(
  options: { scheduler?: ReturnType<typeof fakeScheduler> } = {},
) {
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: { exitCode: number }) => void) | undefined;
  const pty: PtyProcess = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener) => {
      onData = listener;
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((listener) => {
      onExit = listener;
      return { dispose: vi.fn() };
    }),
  };
  const registry = new BridgeRegistry();
  const prepare = vi.fn(async () => ({
    executable: '/usr/bin/tmux',
    args: ['attach'],
    cwd: '/tmp',
    env: {},
  }));
  const preparer = {
    prepare,
    exists: vi.fn(async () => true),
    kill: vi.fn(async () => undefined),
    listActiveSessionIds: vi.fn(async () => [SESSION_ID]),
    attachSpec: vi.fn(() => ({
      executable: '/usr/bin/tmux',
      args: ['attach'],
      cwd: '/tmp',
      env: {},
    })),
  };
  const spawn = vi.fn(() => pty);
  const log = logger();
  const record: TabRecord = Object.freeze({
    id: SESSION_ID,
    displayName: 'Terminal 1',
    position: 0,
    createdAt: '2026-07-11T00:00:00.000Z',
    lastActivityAt: '2026-07-11T00:00:00.000Z',
    desiredState: 'active',
  });
  const store = {
    snapshot: vi.fn(() => ({ structureRevision: 0, tabs: [record] })),
    has: vi.fn((id: string) => id === SESSION_ID),
    setDesiredState: vi.fn(async () => record),
    remove: vi.fn(async () => undefined),
  };
  const manager = new SessionManager({
    preparer,
    ptyFactory: { spawn },
    registry,
    bridgeFactory: new TerminalBridgeFactory(log, 1_048_576),
    store,
    activity: { mark: vi.fn() },
  });
  const server = createServer();
  const auth = authHarness();
  const gateway = createTerminalWebSocketServer({
    server,
    publicOrigin: 'http://app.test',
    basePath: '/terminal',
    sessionManager: manager,
    registry,
    logger: log,
    heartbeatIntervalMs: 30_000,
    ...auth.options,
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
  });
  const port = await listen(server);
  track(server, gateway);
  return {
    url: `ws://127.0.0.1:${port}/terminal/ws/sessions/${SESSION_ID}`,
    server,
    gateway,
    registry,
    preparer: prepare,
    spawn,
    pty,
    logger: log.info,
    auth,
    emitData(data: string) {
      onData?.(data);
    },
    emitExit(exitCode: number) {
      onExit?.({ exitCode });
    },
  };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function authorityCapture() {
  return Object.freeze({
    applicationSessionId: 'application-session-id',
    generation: 7,
    expiresAt: 10_000,
  });
}

function authHarness(
  overrides: {
    authenticate?: (
      request: WebSocketUpgradeRequest,
    ) => Promise<ApplicationSessionAuthority | undefined>;
    touchInput?: (authority: ApplicationSessionAuthority) => boolean;
  } = {},
) {
  const authority = authorityCapture();
  let active = true;
  let revoked: ((id: string) => void) | undefined;
  const unsubscribe = vi.fn();
  const isActive = vi.fn(
    (capture: typeof authority) =>
      active &&
      capture.applicationSessionId === authority.applicationSessionId &&
      capture.generation === authority.generation,
  );
  const touchInput =
    overrides.touchInput ??
    vi.fn((capture: typeof authority): boolean => isActive(capture));
  const authenticator: WebSocketUpgradeAuthenticator = {
    authenticate: overrides.authenticate ?? vi.fn(async () => authority),
    isActive,
    touchInput,
    sweepExpired: vi.fn(),
    onRevoked: vi.fn((listener: (id: string) => void) => {
      revoked = listener;
      return unsubscribe;
    }),
  };
  const index = new WebSocketAuthIndex({
    auth: authenticator,
    maxApplicationSessions: 8,
    maxSockets: 16,
  });
  return {
    options: { upgradeAuthenticator: authenticator, authIndex: index },
    index,
    unsubscribe,
    revoke() {
      active = false;
      revoked?.(authority.applicationSessionId);
    },
  };
}

function authenticatedSession(overrides: Partial<AuthenticatedSession> = {}) {
  return Object.freeze({
    id: 'application-session-id',
    mode: 'cloudflare-access' as const,
    identityLabel: 'alice',
    createdAt: 0,
    lastSeen: 0,
    idleExpiresAt: 4_000,
    absoluteExpiresAt: 10_000,
    upstreamExpiresAt: 5_000,
    generation: 7,
    ...overrides,
  });
}

function upgradeAuthService(overrides: Record<string, unknown> = {}) {
  const current = authenticatedSession();
  return {
    authenticateCookie: vi.fn(() => current),
    authenticateAuthority: vi.fn(() => current),
    isActiveAuthority: vi.fn(() => true),
    touchAuthority: vi.fn(() => true),
    verifyCsrf: vi.fn(() => true),
    touch: vi.fn(),
    sweepExpired: vi.fn(),
    onRevoked: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

function requestView(rawHeaders: string[]) {
  const headers: Record<string, string> = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    headers[rawHeaders[index]!.toLowerCase()] = rawHeaders[index + 1]!;
  }
  return {
    rawHeaders,
    headers,
    headersDistinct: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, [value]]),
    ),
    socket: { remoteAddress: '127.0.0.1' as string | undefined },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeScheduler() {
  let callback: (() => void) | undefined;
  const scheduler: HeartbeatScheduler & { tick(): void } = {
    setInterval(next) {
      callback = next;
      return 1;
    },
    clearInterval: vi.fn(),
    tick() {
      callback?.();
    },
  };
  return scheduler;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('listen failed');
  return address.port;
}

function connect(
  url: string,
  options: { autoPong?: boolean } = {},
): Promise<WebSocket> {
  const client = new WebSocket(url, {
    origin: 'http://app.test',
    autoPong: options.autoPong,
  });
  const inbox = {
    messages: [] as string[],
    waiters: [] as Array<(message: string) => void>,
  };
  inboxes.set(client, inbox);
  client.on('message', (data) => {
    const message = data.toString();
    const waiter = inbox.waiters.shift();
    if (waiter === undefined) inbox.messages.push(message);
    else waiter(message);
  });
  return once(client, 'open').then(() => client);
}

function nextMessage(client: WebSocket): Promise<string> {
  const inbox = inboxes.get(client);
  if (inbox === undefined) throw new Error('client inbox missing');
  const message = inbox.messages.shift();
  if (message !== undefined) return Promise.resolve(message);
  return new Promise((resolve) => inbox.waiters.push(resolve));
}

async function rejectedStatus(
  port: number,
  path: string,
  origin: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin,
    headers,
  });
  return new Promise((resolve, reject) => {
    client.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    client.once('error', reject);
  });
}

function track(server: Server, gateway: TerminalWebSocketServer): void {
  openResources.push(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}
