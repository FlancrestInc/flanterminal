import { EventEmitter } from 'node:events';

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

    expect(httpServer.listen).toHaveBeenCalledWith(
      4321,
      '127.0.0.1',
      expect.any(Function),
    );
    expect(lifecycle.isReady()).toBe(true);
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
    const dispose = registerShutdownSignals({ shutdown }, signals);

    signals.emit('SIGTERM');
    signals.emit('SIGINT');
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());

    dispose();
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    expect(signals.listenerCount('SIGINT')).toBe(0);
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
  const server = {
    listen: vi.fn((_port: number, _host: string, callback: () => void) => {
      callback();
      return server;
    }),
    close: vi.fn((callback?: (error?: Error) => void) => {
      calls.push('http.close');
      callback?.();
      return server;
    }),
    closeAllConnections: vi.fn(),
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
