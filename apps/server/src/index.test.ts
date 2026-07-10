import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  createServerLifecycle,
  registerShutdownSignals,
  verifyRuntimeExecutables,
} from './index.js';

describe('server lifecycle', () => {
  it('listens on the configured host and port and exposes readiness', async () => {
    const httpServer = fakeHttpServer();
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      registry: { closeAll: vi.fn(async () => undefined) },
      closeTimeoutMs: 100,
    });

    expect(lifecycle.isReady()).toBe(false);
    await lifecycle.start('127.0.0.1', 4321);

    expect(httpServer.listen).toHaveBeenCalledWith(4321, '127.0.0.1');
    expect(lifecycle.isReady()).toBe(true);
  });

  it('rejects a real listen collision promptly and rolls back all initialized resources', async () => {
    const occupied = createServer();
    occupied.listen(0, '127.0.0.1');
    await once(occupied, 'listening');
    const address = occupied.address();
    if (address === null || typeof address === 'string')
      throw new Error('listen failed');
    const httpServer = createServer();
    const websocket = fakeWebsocket();
    const registry = { closeAll: vi.fn(async () => undefined) };
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket,
      registry,
      closeTimeoutMs: 100,
    });

    await expect(lifecycle.start('127.0.0.1', address.port)).rejects.toThrow(
      'Server startup failed',
    );

    expect(lifecycle.isReady()).toBe(false);
    expect(websocket.stopAccepting).toHaveBeenCalledOnce();
    expect(websocket.stopHeartbeat).toHaveBeenCalledOnce();
    expect(websocket.closeClients).toHaveBeenCalledOnce();
    expect(registry.closeAll).toHaveBeenCalledOnce();
    expect(
      httpServer.listeners('error').map((listener) => listener.name),
    ).not.toContain('onError');
    expect(
      httpServer.listeners('listening').map((listener) => listener.name),
    ).not.toContain('onListening');
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  });

  it('shuts down once in order and continues cleanup after errors', async () => {
    const calls: string[] = [];
    const httpServer = fakeHttpServer(calls);
    const websocket = fakeWebsocket(calls);
    const registry = {
      closeAll: vi.fn(async () => {
        calls.push('registry.closeAll');
        throw new Error('private close failure');
      }),
    };
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket,
      registry,
      closeTimeoutMs: 100,
    });

    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();
    await expect(first).rejects.toThrow('Server shutdown failed');
    await expect(second).rejects.toThrow('Server shutdown failed');

    expect(calls).toEqual([
      'ws.stopAccepting',
      'ws.stopHeartbeat',
      'ws.closeClients',
      'registry.closeAll',
      'http.close',
    ]);
    expect(registry.closeAll).toHaveBeenCalledOnce();
    expect(lifecycle.isReady()).toBe(false);
  });

  it('bounds HTTP close and force-closes lingering connections', async () => {
    vi.useFakeTimers();
    const httpServer = fakeHttpServer();
    httpServer.close.mockImplementation(() => httpServer);
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      registry: { closeAll: vi.fn(async () => undefined) },
      closeTimeoutMs: 25,
    });

    const shutdown = lifecycle.shutdown();
    const rejected = expect(shutdown).rejects.toThrow('Server shutdown failed');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(httpServer.closeAllConnections).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('routes repeated termination signals through one shutdown', async () => {
    const signals = new EventEmitter();
    const shutdown = vi.fn(async () => undefined);
    const dispose = registerShutdownSignals({ shutdown }, { signals });

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());

    dispose();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('logs a bounded signal shutdown failure and sets a failing exit code', async () => {
    const signals = new EventEmitter();
    const shutdown = vi.fn(async () => {
      throw new Error('secret cleanup detail');
    });
    const logger = { error: vi.fn() };
    const processPort: { exitCode?: number } = {};
    registerShutdownSignals(
      { shutdown },
      { signals, logger, process: processPort },
    );

    signals.emit('SIGTERM');

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith('shutdown_failed', {
      category: 'cleanup_failed',
    });
    expect(processPort.exitCode).toBe(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });

  it('checks shell, tmux, and ssh executability without exposing paths', async () => {
    const access = vi.fn(async (path: string) => {
      if (path.endsWith('ssh')) throw new Error(`missing ${path} PATH=private`);
    });

    await expect(
      verifyRuntimeExecutables(
        ['/bin/bash', '/usr/bin/tmux', '/usr/bin/ssh'],
        access,
      ),
    ).rejects.toThrow('Runtime dependency unavailable');
    expect(access).toHaveBeenCalledTimes(3);
    await expect(
      verifyRuntimeExecutables(
        ['/bin/bash', '/usr/bin/tmux', '/usr/bin/ssh'],
        access,
      ),
    ).rejects.not.toThrow('/usr/bin/ssh');
  });
});

function fakeHttpServer(calls: string[] = []) {
  const events = new EventEmitter();
  const server = {
    listen: vi.fn(() => {
      queueMicrotask(() => events.emit('listening'));
      return server;
    }),
    close: vi.fn((callback?: (error?: Error) => void) => {
      calls.push('http.close');
      callback?.();
      return server;
    }),
    closeAllConnections: vi.fn(),
    once: events.once.bind(events),
    off: events.off.bind(events),
  };
  return server;
}

function fakeWebsocket(calls: string[] = []) {
  return {
    connectedCount: vi.fn(() => 0),
    stopAccepting: vi.fn(() => calls.push('ws.stopAccepting')),
    stopHeartbeat: vi.fn(() => calls.push('ws.stopHeartbeat')),
    closeClients: vi.fn(() => calls.push('ws.closeClients')),
    close: vi.fn(async () => undefined),
  };
}
