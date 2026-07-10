import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import { FIXED_SESSION_ID, PROTOCOL_VERSION } from '@flanterminal/shared';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BridgeRegistry } from './bridge-registry.js';
import type { PtyProcess } from './pty.js';
import { SessionManager, TerminalBridgeFactory } from './session-manager.js';
import {
  createTerminalWebSocketServer,
  type HeartbeatScheduler,
  type TerminalWebSocketServer,
} from './websocket.js';

const openResources: Array<() => Promise<void>> = [];
const inboxes = new WeakMap<
  WebSocket,
  { messages: string[]; waiters: Array<(message: string) => void> }
>();

afterEach(async () => {
  await Promise.allSettled(openResources.splice(0).map((close) => close()));
});

describe('terminal websocket server', () => {
  it('bridges text input, resize, and PTY output over a real ws transport', async () => {
    const harness = await createHarness();
    const client = await connect(harness.url);
    const ready = await nextMessage(client);

    expect(JSON.parse(ready)).toEqual({
      v: PROTOCOL_VERSION,
      type: 'ready',
      sessionId: FIXED_SESSION_ID,
    });

    client.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'input',
        sessionId: FIXED_SESSION_ID,
        data: 'echo private\n',
      }),
    );
    client.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'resize',
        sessionId: FIXED_SESSION_ID,
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
      sessionId: FIXED_SESSION_ID,
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
        sessionId: FIXED_SESSION_ID,
        data: 'private',
      }),
      false,
    ],
    [
      'wrong-direction',
      JSON.stringify({
        v: 1,
        type: 'output',
        sessionId: FIXED_SESSION_ID,
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
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/terminal',
      sessionManager: { connect: connectSession },
      registry: new BridgeRegistry(),
      logger: logger(),
      heartbeatIntervalMs: 30_000,
    });
    const port = await listen(server);
    track(server, gateway);

    expect(
      await rejectedStatus(
        port,
        '/terminal/ws/sessions/phase-1-main',
        'http://wrong.test',
      ),
    ).toBe(403);
    expect(
      await rejectedStatus(
        port,
        '/ws/sessions/phase-1-main',
        'http://app.test',
      ),
    ).toBe(404);
    expect(connectSession).not.toHaveBeenCalled();
  });

  it('sends a bounded protocol error and closes 1011 when session setup fails', async () => {
    const registry = new BridgeRegistry();
    const server = createServer();
    const gateway = createTerminalWebSocketServer({
      server,
      publicOrigin: 'http://app.test',
      basePath: '/',
      sessionManager: {
        connect: vi.fn().mockRejectedValue(new Error('private failure')),
      },
      registry,
      logger: logger(),
      heartbeatIntervalMs: 30_000,
    });
    const port = await listen(server);
    track(server, gateway);
    const client = await connect(
      `ws://127.0.0.1:${port}/ws/sessions/${FIXED_SESSION_ID}`,
    );

    expect(JSON.parse(await nextMessage(client))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'error',
      sessionId: FIXED_SESSION_ID,
      code: 'terminal_unavailable',
    });
    const [code] = (await once(client, 'close')) as [number, Buffer];
    expect(code).toBe(1011);
    expect(registry.get(FIXED_SESSION_ID)).toBeUndefined();
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
    expect(harness.registry.get(FIXED_SESSION_ID)).toBeUndefined();
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
  const preparer = vi.fn(async () => ({
    executable: '/usr/bin/tmux',
    args: ['attach'],
    cwd: '/tmp',
    env: {},
  }));
  const spawn = vi.fn(() => pty);
  const log = logger();
  const manager = new SessionManager({
    preparer: { prepare: preparer },
    ptyFactory: { spawn },
    registry,
    bridgeFactory: new TerminalBridgeFactory(log, 1_048_576),
  });
  const server = createServer();
  const gateway = createTerminalWebSocketServer({
    server,
    publicOrigin: 'http://app.test',
    basePath: '/terminal',
    sessionManager: manager,
    registry,
    logger: log,
    heartbeatIntervalMs: 30_000,
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
  });
  const port = await listen(server);
  track(server, gateway);
  return {
    url: `ws://127.0.0.1:${port}/terminal/ws/sessions/${FIXED_SESSION_ID}`,
    server,
    gateway,
    registry,
    preparer,
    spawn,
    pty,
    logger: log.info,
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
): Promise<number> {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin });
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
