import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';

import { MIDNIGHT_ELECTRIC_TERMINAL_PALETTE } from '@flanterminal/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  createProductionRuntime,
  createProductionRuntimeMetrics,
  createServerLifecycle,
  defaultWorkspaceSettings,
  initializeProductionAuthentication,
  registerShutdownSignals,
  type ProductionRuntimeFactory,
  verifyRuntimeExecutables,
  workspaceSettingsConstraints,
} from './index.js';
import { loadConfig } from './config.js';

describe('production workspace appearance settings', () => {
  it('publishes the configured appearance options and defaults', () => {
    const config = loadConfig({ AUTH_MODE: 'none' });

    const constraints = workspaceSettingsConstraints(config);
    const defaults = defaultWorkspaceSettings(config);

    expect(constraints.limits.fontFamilies).toEqual([
      'jetbrains-mono-nerd',
      'system-monospace',
      'dejavu-sans-mono',
      'noto-sans-mono',
      'liberation-mono',
      'courier',
    ]);
    expect(constraints.limits.themes).toEqual([
      'dark',
      'light',
      'ubuntu',
      'midnight-electric',
      'aurora-night',
      'carbon-violet',
      'custom',
    ]);
    expect(defaults).toMatchObject({
      fontFamily: 'dejavu-sans-mono',
      theme: 'midnight-electric',
    });
    expect(defaults.customTerminalPalette).toEqual(
      MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
    );
  });
});

describe('server lifecycle', () => {
  it('allows one pending start attempt and rejects a concurrent start stably', async () => {
    const httpServer = fakeHttpServer();
    httpServer.listen.mockImplementation(() => httpServer);
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => true,
      closeTimeoutMs: 100,
    });

    const first = lifecycle.start('127.0.0.1', 4321);
    await expect(lifecycle.start('127.0.0.1', 4321)).rejects.toThrow(
      'Server lifecycle unavailable',
    );
    const shutdown = lifecycle.shutdown();

    await expect(first).rejects.toThrow('Server startup failed');
    await shutdown;
    expect(lifecycle.isReady()).toBe(false);
  });

  it('cancels a pending listen when shutdown starts and ignores late listening', async () => {
    const httpServer = fakeHttpServer();
    httpServer.listen.mockImplementation(() => httpServer);
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => true,
      closeTimeoutMs: 100,
    });

    const start = lifecycle.start('127.0.0.1', 4321);
    const shutdown = lifecycle.shutdown();
    httpServer.events.emit('listening');

    await expect(start).rejects.toThrow('Server startup failed');
    await shutdown;
    expect(lifecycle.isReady()).toBe(false);
    expect(httpServer.events.listenerCount('error')).toBe(0);
    expect(httpServer.events.listenerCount('listening')).toBe(0);
  });

  it('keeps a failed start stopped when a late listening event races the error', async () => {
    const httpServer = fakeHttpServer();
    httpServer.listen.mockImplementation(() => {
      queueMicrotask(() => {
        httpServer.events.emit('error', new Error('private listen failure'));
        httpServer.events.emit('listening');
      });
      return httpServer;
    });
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => true,
      closeTimeoutMs: 100,
    });

    await expect(lifecycle.start('127.0.0.1', 4321)).rejects.toThrow(
      'Server startup failed',
    );

    expect(lifecycle.isReady()).toBe(false);
    expect(httpServer.events.listenerCount('error')).toBe(0);
    expect(httpServer.events.listenerCount('listening')).toBe(0);
  });

  it('rejects a start attempt after shutdown without reopening the listener', async () => {
    const httpServer = fakeHttpServer();
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => true,
      closeTimeoutMs: 100,
    });

    await lifecycle.shutdown();

    await expect(lifecycle.start('127.0.0.1', 4321)).rejects.toThrow(
      'Server lifecycle unavailable',
    );
    expect(httpServer.listen).not.toHaveBeenCalled();
  });

  it('rejects a second start after reaching running state', async () => {
    const httpServer = fakeHttpServer();
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => true,
      closeTimeoutMs: 100,
    });

    await lifecycle.start('127.0.0.1', 4321);

    await expect(lifecycle.start('127.0.0.1', 4321)).rejects.toThrow(
      'Server lifecycle unavailable',
    );
    expect(httpServer.listen).toHaveBeenCalledOnce();
    await lifecycle.shutdown();
  });

  it('listens on the configured host and port and exposes readiness', async () => {
    const httpServer = fakeHttpServer();
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => true,
      closeTimeoutMs: 100,
    });

    expect(lifecycle.isReady()).toBe(false);
    await lifecycle.start('127.0.0.1', 4321);

    expect(httpServer.listen).toHaveBeenCalledWith(4321, '127.0.0.1');
    expect(lifecycle.isReady()).toBe(true);
  });

  it('reports not ready when either tab or settings durability is degraded', async () => {
    const httpServer = fakeHttpServer();
    let durable = true;
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => durable,
      closeTimeoutMs: 100,
    });

    await lifecycle.start('127.0.0.1', 4321);
    expect(lifecycle.isReady()).toBe(true);
    durable = false;
    expect(lifecycle.isReady()).toBe(false);
  });

  it('fails readiness closed when a durability probe throws', async () => {
    const lifecycle = createServerLifecycle({
      httpServer: fakeHttpServer(),
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => {
        throw new Error('private durability failure');
      },
      closeTimeoutMs: 100,
    });

    await lifecycle.start('127.0.0.1', 4321);

    expect(lifecycle.isReady()).toBe(false);
    await lifecycle.shutdown();
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
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry,
      durabilityReady: () => true,
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
    const activity = fakeActivity(calls);
    const cleaner = fakeCleaner(calls);
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket,
      activity,
      cleaner,
      disposeServices: vi.fn(() => calls.push('services.dispose')),
      registry,
      durabilityReady: () => true,
      closeTimeoutMs: 100,
    });

    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();
    await expect(first).rejects.toThrow('Server shutdown failed');
    await expect(second).rejects.toThrow('Server shutdown failed');

    expect(calls).toEqual([
      'ws.stopAccepting',
      'http.close',
      'cleaner.shutdown',
      'ws.stopHeartbeat',
      'activity.shutdown',
      'ws.closeClients',
      'registry.closeAll',
      'ws.close',
      'services.dispose',
    ]);
    expect(registry.closeAll).toHaveBeenCalledOnce();
    expect(activity.shutdown).toHaveBeenCalledOnce();
    expect(cleaner.shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.isReady()).toBe(false);
  });

  it('waits for each teardown phase to complete before starting the next phase', async () => {
    const calls: string[] = [];
    const cleanerClose = deferred<void>();
    const activityClose = deferred<void>();
    const registryClose = deferred<void>();
    const websocketClose = deferred<void>();
    const httpServer = fakeHttpServer(calls);
    httpServer.close.mockImplementation(() => {
      calls.push('http.close');
      return httpServer;
    });
    const websocket = fakeWebsocket(calls);
    websocket.close.mockImplementation(() => {
      calls.push('ws.close');
      return websocketClose.promise;
    });
    const cleaner = fakeCleaner(calls);
    cleaner.shutdown.mockImplementation(() => {
      calls.push('cleaner.shutdown');
      return cleanerClose.promise;
    });
    const activity = fakeActivity(calls);
    activity.shutdown.mockImplementation(() => {
      calls.push('activity.shutdown');
      return activityClose.promise;
    });
    const registry = {
      closeAll: vi.fn(() => {
        calls.push('registry.closeAll');
        return registryClose.promise;
      }),
    };
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket,
      activity,
      cleaner,
      registry,
      disposeServices: vi.fn(() => calls.push('services.dispose')),
      durabilityReady: () => true,
      closeTimeoutMs: 1_000,
    });

    let settled = false;
    const shutdown = lifecycle.shutdown().finally(() => {
      settled = true;
    });
    expect(calls).toEqual([
      'ws.stopAccepting',
      'http.close',
      'cleaner.shutdown',
      'ws.stopHeartbeat',
      'activity.shutdown',
    ]);

    cleanerClose.resolve();
    await Promise.resolve();
    expect(websocket.closeClients).not.toHaveBeenCalled();

    activityClose.resolve();
    await vi.waitFor(() =>
      expect(websocket.closeClients).toHaveBeenCalledOnce(),
    );
    expect(calls).toContain('registry.closeAll');
    expect(websocket.close).not.toHaveBeenCalled();

    registryClose.resolve();
    await vi.waitFor(() => expect(websocket.close).toHaveBeenCalledOnce());
    expect(calls).not.toContain('services.dispose');

    websocketClose.resolve();
    await vi.waitFor(() => expect(calls).toContain('services.dispose'));
    expect(settled).toBe(false);

    httpServer.close.mock.calls[0]?.[0]?.();
    await shutdown;
    expect(calls).toEqual([
      'ws.stopAccepting',
      'http.close',
      'cleaner.shutdown',
      'ws.stopHeartbeat',
      'activity.shutdown',
      'ws.closeClients',
      'registry.closeAll',
      'ws.close',
      'services.dispose',
    ]);
  });

  it('bounds HTTP close and force-closes lingering connections', async () => {
    vi.useFakeTimers();
    const httpServer = fakeHttpServer();
    httpServer.close.mockImplementation(() => httpServer);
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => true,
      closeTimeoutMs: 25,
    });

    const shutdown = lifecycle.shutdown();
    const rejected = expect(shutdown).rejects.toThrow('Server shutdown failed');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(httpServer.closeAllConnections).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('settles bounded shutdown when force-closing connections throws', async () => {
    vi.useFakeTimers();
    const httpServer = fakeHttpServer();
    httpServer.close.mockImplementation(() => httpServer);
    httpServer.closeAllConnections.mockImplementation(() => {
      throw new Error('private force-close failure');
    });
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket: fakeWebsocket(),
      activity: fakeActivity(),
      cleaner: fakeCleaner(),
      registry: { closeAll: vi.fn(async () => undefined) },
      durabilityReady: () => true,
      closeTimeoutMs: 25,
    });

    const shutdown = lifecycle.shutdown().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);
    await expect(shutdown).resolves.toMatchObject({
      message: 'Server shutdown failed',
    });
    vi.useRealTimers();
  });

  it.each(['cleaner', 'activity', 'registry', 'websocket'] as const)(
    'uses one total teardown deadline when %s cleanup never settles',
    async (owner) => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const httpServer = fakeHttpServer(calls);
      httpServer.close.mockImplementation(() => httpServer);
      const websocket = fakeWebsocket(calls);
      const activity = fakeActivity(calls);
      const cleaner = fakeCleaner(calls);
      const registry = {
        closeAll: vi.fn(async () => {
          calls.push('registry.closeAll');
        }),
      };
      const disposeServices = vi.fn(() => calls.push('services.dispose'));
      if (owner === 'cleaner')
        cleaner.shutdown.mockImplementation(neverSettles);
      if (owner === 'activity')
        activity.shutdown.mockImplementation(neverSettles);
      if (owner === 'registry')
        registry.closeAll.mockImplementation(neverSettles);
      if (owner === 'websocket')
        websocket.close.mockImplementation(neverSettles);
      const lifecycle = createServerLifecycle({
        httpServer,
        websocket,
        activity,
        cleaner,
        registry,
        disposeServices,
        durabilityReady: () => true,
        closeTimeoutMs: 25,
      });

      const outcome = lifecycle.shutdown().catch((error: unknown) => error);
      expect(vi.getTimerCount()).toBe(1);
      if (owner === 'cleaner' || owner === 'activity') {
        expect(websocket.closeClients).not.toHaveBeenCalled();
        expect(registry.closeAll).not.toHaveBeenCalled();
        expect(websocket.close).not.toHaveBeenCalled();
        expect(disposeServices).not.toHaveBeenCalled();
      }
      if (owner === 'registry') {
        expect(websocket.close).not.toHaveBeenCalled();
        expect(disposeServices).not.toHaveBeenCalled();
      }
      if (owner === 'websocket') {
        expect(disposeServices).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(25);

      await expect(outcome).resolves.toMatchObject({
        message: 'Server shutdown failed',
      });
      expect(httpServer.closeAllConnections).toHaveBeenCalledOnce();
      expect(httpServer.close).toHaveBeenCalledOnce();
      expect(calls).toEqual(
        expect.arrayContaining([
          'ws.stopAccepting',
          'ws.stopHeartbeat',
          'ws.closeClients',
          'services.dispose',
        ]),
      );
      expect(cleaner.shutdown).toHaveBeenCalledOnce();
      expect(activity.shutdown).toHaveBeenCalledOnce();
      expect(registry.closeAll).toHaveBeenCalledOnce();
      expect(websocket.close).toHaveBeenCalledOnce();
      expect(disposeServices).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    },
  );

  it('settles after the deadline without awaiting downstream best-effort work', async () => {
    vi.useFakeTimers();
    const cleanerClose = deferred<void>();
    const registryClose = deferred<void>();
    const websocketClose = deferred<void>();
    const httpServer = fakeHttpServer();
    httpServer.close.mockImplementation(() => httpServer);
    const cleaner = fakeCleaner();
    cleaner.shutdown.mockImplementation(() => cleanerClose.promise);
    const registry = { closeAll: vi.fn(() => registryClose.promise) };
    const websocket = fakeWebsocket();
    websocket.close.mockImplementation(() => websocketClose.promise);
    const disposeServices = vi.fn();
    const lifecycle = createServerLifecycle({
      httpServer,
      websocket,
      activity: fakeActivity(),
      cleaner,
      registry,
      disposeServices,
      durabilityReady: () => true,
      closeTimeoutMs: 25,
    });

    const outcome = lifecycle.shutdown().catch((error: unknown) => error);
    expect(registry.closeAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);

    await expect(outcome).resolves.toMatchObject({
      message: 'Server shutdown failed',
    });
    expect(cleaner.shutdown).toHaveBeenCalledOnce();
    expect(registry.closeAll).toHaveBeenCalledOnce();
    expect(websocket.close).toHaveBeenCalledOnce();
    expect(disposeServices).toHaveBeenCalledOnce();

    cleanerClose.reject(new Error('late cleaner failure'));
    registryClose.reject(new Error('late registry failure'));
    websocketClose.reject(new Error('late websocket failure'));
    await Promise.resolve();
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

  it('rolls back a partial signal registration when the second listener fails', () => {
    const signals = new EventEmitter();
    const source = {
      on: vi.fn((signal: 'SIGTERM' | 'SIGINT', listener: () => void) => {
        if (signal === 'SIGINT') throw new Error('registration failed');
        signals.on(signal, listener);
      }),
      off: vi.fn((signal: 'SIGTERM' | 'SIGINT', listener: () => void) => {
        signals.off(signal, listener);
      }),
    };

    expect(() =>
      registerShutdownSignals(
        { shutdown: vi.fn(async () => undefined) },
        {
          signals: source,
        },
      ),
    ).toThrow('registration failed');
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

describe('production composition', () => {
  it('reports active runtime bridges instead of retained stopped tab metadata', () => {
    const retainedStoppedTabs = Array.from({ length: 7 }, (_, position) => ({
      id: `stopped-${position}`,
      desiredState: 'stopped' as const,
    }));
    const registry = { registeredCount: vi.fn(() => 2) };
    const sockets = { connectedCount: vi.fn(() => 3) };

    const metrics = createProductionRuntimeMetrics({
      registry,
      sockets,
    });

    expect(retainedStoppedTabs).toHaveLength(7);
    expect(metrics.activeSessionCount()).toBe(2);
    expect(metrics.connectedWebSocketCount()).toBe(3);
    expect(registry.registeredCount).toHaveBeenCalledOnce();
    expect(sockets.connectedCount).toHaveBeenCalledOnce();
  });

  it('constructs Cloudflare authentication without creating or exposing local setup', async () => {
    const createCredentialStore = vi.fn();
    const createCloudflareAccessProvider = vi.fn(() => ({}) as never);
    const config = loadConfig({
      AUTH_MODE: 'cloudflare-access',
      CLOUDFLARE_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
      CLOUDFLARE_ACCESS_AUD: 'test-audience',
    });

    const authentication = await initializeProductionAuthentication(config, {
      createCredentialStore,
      createCloudflareAccessProvider,
    });

    expect(createCredentialStore).not.toHaveBeenCalled();
    expect(createCloudflareAccessProvider).toHaveBeenCalledOnce();
    expect(authentication.cloudflareAccessProvider).toBeDefined();
    await expect(
      authentication.authService.setup({
        password: 'not-used-password',
        address: '192.0.2.1',
      }),
    ).rejects.toThrow('Authentication operation failed');
  });

  it('starts fresh local credentials uninitialized after two-argument initialization', async () => {
    const initialized = false;
    const initializeLocal = vi.fn(async () => undefined);
    const config = loadConfig({ AUTH_MODE: 'local' });

    const authentication = await initializeProductionAuthentication(config, {
      createCredentialStore: () => ({
        initializeLocal,
        isInitialized: () => initialized,
        enroll: vi.fn(async () => ({ outcome: 'not_committed' as const })),
        verify: vi.fn(async () => false),
        replacePassword: vi.fn(async () => ({
          state: 'not_committed' as const,
        })),
      }),
    });

    expect(initializeLocal).toHaveBeenCalledWith(
      config.localAuthUsername,
      config.bcryptCost,
    );
    await expect(
      authentication.authService.bootstrap({ type: 'none' }),
    ).resolves.toMatchObject({
      bootstrap: {
        authenticated: false,
        mode: 'local',
        setupRequired: true,
        username: config.localAuthUsername,
      },
    });
  });

  it('retains existing local credential authority loaded during initialization', async () => {
    let initialized = false;
    const initializeLocal = vi.fn(async () => {
      initialized = true;
    });
    const verify = vi.fn(async () => true);
    const config = loadConfig({
      AUTH_MODE: 'local',
      LOCAL_AUTH_USERNAME: 'existing-admin',
    });

    const authentication = await initializeProductionAuthentication(config, {
      createCredentialStore: () => ({
        initializeLocal,
        isInitialized: () => initialized,
        enroll: vi.fn(async () => ({
          outcome: 'already_initialized' as const,
        })),
        verify,
        replacePassword: vi.fn(async () => ({ state: 'committed' as const })),
      }),
    });
    const result = await authentication.authService.login({
      username: 'existing-admin',
      password: 'existing-password',
      address: '192.0.2.2',
    });

    expect(initializeLocal).toHaveBeenCalledWith('existing-admin', 12);
    expect(verify).toHaveBeenCalledWith('existing-admin', 'existing-password');
    expect(result.bootstrap).toMatchObject({
      authenticated: true,
      mode: 'local',
      identityLabel: 'existing-admin',
    });
  });

  it('logs only the durability category when local enrollment commitment is uncertain', async () => {
    const error = vi.fn();
    const config = loadConfig({ AUTH_MODE: 'local' });
    const authentication = await initializeProductionAuthentication(config, {
      logger: { error },
      createCredentialStore: () => ({
        initializeLocal: vi.fn(async () => undefined),
        isInitialized: () => false,
        enroll: vi.fn(async () => ({
          outcome: 'enrolled' as const,
          persistence: 'committed_durability_uncertain' as const,
        })),
        verify: vi.fn(async () => false),
        replacePassword: vi.fn(async () => ({
          state: 'not_committed' as const,
        })),
      }),
    });

    await expect(
      authentication.authService.setup({
        password: 'new-admin-password',
        address: '192.0.2.3',
      }),
    ).resolves.toMatchObject({ bootstrap: { authenticated: true } });
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith('authentication_activity_failed', {
      category: 'durability_uncertain',
    });
  });

  it('propagates local credential initialization failure before composition can listen', async () => {
    const primary = new Error('local credential bootstrap failed');
    const initializeLocal = vi.fn(async () => {
      throw primary;
    });
    const config = loadConfig({ AUTH_MODE: 'local' });

    await expect(
      initializeProductionAuthentication(config, {
        createCredentialStore: () => ({
          initializeLocal,
          isInitialized: () => false,
          enroll: vi.fn(async () => ({ outcome: 'not_committed' as const })),
          verify: vi.fn(async () => false),
          replacePassword: vi.fn(async () => ({
            state: 'not_committed' as const,
          })),
        }),
      }),
    ).rejects.toBe(primary);

    expect(initializeLocal).toHaveBeenCalledWith(
      config.localAuthUsername,
      config.bcryptCost,
    );
  });

  it('initializes every production boundary in dependency order before listen', async () => {
    const calls: string[] = [];
    const factory = fakeProductionFactory(calls);

    const runtime = await createProductionRuntime(
      { APP_CONFIG_FILE: '/config.json', AUTH_MODE: 'none' },
      factory,
    );

    expect(calls).toEqual([
      'config-file',
      'config',
      'settings',
      'authentication',
      'tabs',
      'executables',
      'services',
      'http',
      'websocket',
      'cleaner',
      'listen',
      'signals',
      'started',
    ]);
    await runtime.lifecycle.shutdown();
  });

  it('fails a local credential bootstrap before opening the listener', async () => {
    const calls: string[] = [];
    const primary = new Error('bounded credential bootstrap failure');
    const factory = fakeProductionFactory(calls, {
      failAt: 'authentication',
      failure: primary,
    });

    await expect(
      createProductionRuntime({ AUTH_MODE: 'local' }, factory),
    ).rejects.toBe(primary);

    expect(calls).not.toContain('listen');
    expect(calls).not.toContain('signals');
  });

  it.each([
    'settings',
    'authentication',
    'tabs',
    'executables',
    'services',
    'http',
    'websocket',
    'cleaner',
    'listen',
    'signals',
  ] as const)(
    'rolls back owned resources after a %s startup failure and preserves the primary error',
    async (failAt) => {
      const calls: string[] = [];
      const primary = new Error(`primary ${failAt}`);
      const factory = fakeProductionFactory(calls, {
        failAt,
        failure: primary,
      });

      const rejection = expect(
        createProductionRuntime({ AUTH_MODE: 'none' }, factory),
      ).rejects;
      if (failAt === 'listen') {
        await rejection.toThrow('Server startup failed');
      } else {
        await rejection.toBe(primary);
      }

      expect(
        calls.filter((call) => call === 'signals.dispose').length,
      ).toBeLessThanOrEqual(1);
      expect(
        calls.filter((call) => call === 'cleaner.shutdown').length,
      ).toBeLessThanOrEqual(1);
      expect(
        calls.filter((call) => call === 'ws.stopAccepting').length,
      ).toBeLessThanOrEqual(1);
      expect(
        calls.filter((call) => call === 'activity.shutdown').length,
      ).toBeLessThanOrEqual(1);
      expect(
        calls.filter((call) => call === 'registry.closeAll').length,
      ).toBeLessThanOrEqual(1);
      const completed = (stage: ProductionStage): boolean =>
        productionStageOrder.indexOf(failAt) >
        productionStageOrder.indexOf(stage);
      if (completed('websocket')) {
        expect(calls).toContain('ws.stopAccepting');
        expect(calls).toContain('ws.closeClients');
      }
      if (completed('cleaner')) expect(calls).toContain('cleaner.shutdown');
      if (completed('services')) {
        expect(calls).toContain('activity.shutdown');
        expect(calls).toContain('registry.closeAll');
      }
      if (completed('http')) expect(calls).toContain('http.close');
      if (completed('signals')) expect(calls).toContain('signals.dispose');
    },
  );

  it('uses combined tab and settings durability after successful startup', async () => {
    let tabsReady = true;
    let settingsReady = true;
    const factory = fakeProductionFactory([], {
      durabilityReady: () => tabsReady && settingsReady,
    });
    const runtime = await createProductionRuntime(
      { AUTH_MODE: 'none' },
      factory,
    );

    expect(runtime.lifecycle.isReady()).toBe(true);
    settingsReady = false;
    expect(runtime.lifecycle.isReady()).toBe(false);
    settingsReady = true;
    tabsReady = false;
    expect(runtime.lifecycle.isReady()).toBe(false);
    await runtime.lifecycle.shutdown();
  });

  it.each([
    ['cleaner', 'registry'],
    ['signals', 'cleaner'],
  ] as const)(
    'bounds %s startup rollback when %s cleanup never settles and preserves the primary error',
    async (failAt, hangCleanup) => {
      vi.useFakeTimers();
      const calls: string[] = [];
      const primary = new Error(`primary ${failAt}`);
      const factory = fakeProductionFactory(calls, {
        failAt,
        failure: primary,
        hangCleanup,
      });

      const outcome = createProductionRuntime(
        { AUTH_MODE: 'none' },
        factory,
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(outcome).resolves.toBe(primary);
      expect(calls).toContain('http.close');
      expect(calls).toContain('services.dispose');
      vi.useRealTimers();
    },
  );

  it('uses ordered teardown phases during startup rollback and preserves the primary error', async () => {
    const calls: string[] = [];
    const primary = new Error('primary cleaner');
    const activityClose = deferred<void>();
    const registryClose = deferred<void>();
    const websocketClose = deferred<void>();
    const httpClose = deferred<void>();
    const factory = fakeProductionFactory(calls, {
      failAt: 'cleaner',
      failure: primary,
      cleanupGates: {
        activity: activityClose.promise,
        registry: registryClose.promise,
        websocket: websocketClose.promise,
        http: httpClose.promise,
      },
    });

    let settled = false;
    const outcome = createProductionRuntime({ AUTH_MODE: 'none' }, factory)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(calls).toContain('activity.shutdown'));
    expect(calls).not.toContain('ws.closeClients');

    activityClose.resolve();
    await vi.waitFor(() => expect(calls).toContain('registry.closeAll'));
    expect(calls).toContain('ws.closeClients');
    expect(calls).not.toContain('ws.close');

    registryClose.resolve();
    await vi.waitFor(() => expect(calls).toContain('ws.close'));
    expect(calls).not.toContain('services.dispose');

    websocketClose.resolve();
    await vi.waitFor(() => expect(calls).toContain('services.dispose'));
    expect(settled).toBe(false);

    httpClose.resolve();
    await expect(outcome).resolves.toBe(primary);
  });
});

function fakeHttpServer(calls: string[] = []) {
  const events = new EventEmitter();
  const server = {
    events,
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
    close: vi.fn(async () => {
      calls.push('ws.close');
    }),
  };
}

function fakeActivity(calls: string[] = []) {
  return {
    shutdown: vi.fn(async () => {
      calls.push('activity.shutdown');
    }),
  };
}

function fakeCleaner(calls: string[] = []) {
  return {
    shutdown: vi.fn(async () => {
      calls.push('cleaner.shutdown');
    }),
  };
}

function neverSettles(): Promise<never> {
  return new Promise(() => undefined);
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

type ProductionStage =
  | 'settings'
  | 'authentication'
  | 'tabs'
  | 'executables'
  | 'services'
  | 'http'
  | 'websocket'
  | 'cleaner'
  | 'listen'
  | 'signals';

const productionStageOrder: readonly ProductionStage[] = [
  'settings',
  'authentication',
  'tabs',
  'executables',
  'services',
  'http',
  'websocket',
  'cleaner',
  'listen',
  'signals',
];

function fakeProductionFactory(
  calls: string[],
  options: {
    failAt?: ProductionStage;
    failure?: Error;
    durabilityReady?: () => boolean;
    hangCleanup?: 'cleaner' | 'activity' | 'registry' | 'websocket';
    cleanupGates?: Partial<
      Record<'activity' | 'registry' | 'websocket' | 'http', Promise<void>>
    >;
  } = {},
): ProductionRuntimeFactory {
  const fail = (stage: ProductionStage): void => {
    if (options.failAt === stage) throw options.failure;
  };
  const httpServer = fakeHttpServer(calls);
  if (options.cleanupGates?.http !== undefined) {
    httpServer.close.mockImplementation(
      (callback?: (error?: Error) => void) => {
        calls.push('http.close');
        void options.cleanupGates!.http!.then(() => callback?.());
        return httpServer;
      },
    );
  }
  httpServer.listen.mockImplementation(() => {
    calls.push('listen');
    fail('listen');
    queueMicrotask(() => httpServer.events.emit('listening'));
    return httpServer;
  });
  const websocket = fakeWebsocket(calls);
  const activity = fakeActivity(calls);
  const cleaner = fakeCleaner(calls);
  const registry = {
    closeAll: vi.fn(async () => {
      calls.push('registry.closeAll');
    }),
  };
  if (options.cleanupGates?.activity !== undefined) {
    activity.shutdown.mockImplementation(() => {
      calls.push('activity.shutdown');
      return options.cleanupGates!.activity!;
    });
  }
  if (options.cleanupGates?.registry !== undefined) {
    registry.closeAll.mockImplementation(() => {
      calls.push('registry.closeAll');
      return options.cleanupGates!.registry!;
    });
  }
  if (options.cleanupGates?.websocket !== undefined) {
    websocket.close.mockImplementation(() => {
      calls.push('ws.close');
      return options.cleanupGates!.websocket!;
    });
  }
  if (options.hangCleanup === 'cleaner') {
    cleaner.shutdown.mockImplementation(neverSettles);
  }
  if (options.hangCleanup === 'activity') {
    activity.shutdown.mockImplementation(neverSettles);
  }
  if (options.hangCleanup === 'registry') {
    registry.closeAll.mockImplementation(neverSettles);
  }
  if (options.hangCleanup === 'websocket') {
    websocket.close.mockImplementation(neverSettles);
  }
  return {
    async loadOptionalConfigFile() {
      calls.push('config-file');
      return {};
    },
    loadConfig() {
      calls.push('config');
      return {
        bindHost: '127.0.0.1',
        port: 3000,
        basePath: '/',
      } as never;
    },
    createLogger: () => ({
      info(event: string) {
        if (event === 'server_started') calls.push('started');
      },
      warn: vi.fn(),
      error: vi.fn(),
    }),
    async initializeSettings() {
      calls.push('settings');
      fail('settings');
      return {};
    },
    async initializeAuthentication() {
      calls.push('authentication');
      fail('authentication');
      return {};
    },
    async initializeTabs() {
      calls.push('tabs');
      fail('tabs');
      return {};
    },
    async verifyRuntimeExecutables() {
      calls.push('executables');
      fail('executables');
    },
    createServices() {
      calls.push('services');
      fail('services');
      return {
        activity,
        registry,
        dispose: vi.fn(() => calls.push('services.dispose')),
        durabilityReady: options.durabilityReady ?? (() => true),
      };
    },
    createHttp() {
      calls.push('http');
      fail('http');
      return httpServer;
    },
    createWebsocket() {
      calls.push('websocket');
      fail('websocket');
      return websocket;
    },
    createCleaner() {
      calls.push('cleaner');
      fail('cleaner');
      return cleaner;
    },
    registerShutdownSignals() {
      calls.push('signals');
      fail('signals');
      return () => calls.push('signals.dispose');
    },
  };
}
