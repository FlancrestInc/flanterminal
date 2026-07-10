import { access as accessFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FIXED_SESSION_ID } from '@flanterminal/shared';

import { createApp } from './app.js';
import { BridgeRegistry } from './bridge-registry.js';
import { loadConfig, type ConfigEnvironment } from './config.js';
import { createLifecycleLogger } from './logger.js';
import { NodePtyFactory } from './pty.js';
import { SessionManager, TerminalBridgeFactory } from './session-manager.js';
import { ExecFileCommandRunner, TmuxSessionPreparer } from './tmux.js';
import {
  createTerminalWebSocketServer,
  type TerminalWebSocketServer,
} from './websocket.js';

const TMUX_EXECUTABLE = '/usr/bin/tmux';
const SSH_EXECUTABLE = '/usr/bin/ssh';

export interface LifecycleHttpServer {
  listen(port: number, host: string, callback: () => void): unknown;
  close(callback?: (error?: Error) => void): unknown;
  closeAllConnections(): void;
}

export type ServerLifecycleOptions = Readonly<{
  httpServer: LifecycleHttpServer;
  websocket: Pick<
    TerminalWebSocketServer,
    'stopAccepting' | 'stopHeartbeat' | 'closeClients'
  >;
  registry: Readonly<{ closeAll(): Promise<void> }>;
  closeTimeoutMs: number;
}>;

export interface ServerLifecycle {
  start(host: string, port: number): Promise<void>;
  shutdown(): Promise<void>;
  isReady(): boolean;
}

export function createServerLifecycle(
  options: ServerLifecycleOptions,
): ServerLifecycle {
  let ready = false;
  let shutdownPromise: Promise<void> | undefined;

  return {
    isReady: () => ready,
    async start(host, port) {
      await new Promise<void>((resolveStart) => {
        options.httpServer.listen(port, host, resolveStart);
      });
      ready = true;
    },
    shutdown() {
      if (shutdownPromise !== undefined) return shutdownPromise;
      ready = false;
      shutdownPromise = performShutdown(options);
      return shutdownPromise;
    },
  };
}

async function performShutdown(options: ServerLifecycleOptions): Promise<void> {
  const errors: unknown[] = [];
  runCleanup(() => options.websocket.stopAccepting(), errors);
  runCleanup(() => options.websocket.stopHeartbeat(), errors);
  runCleanup(() => options.websocket.closeClients(), errors);
  await runAsyncCleanup(() => options.registry.closeAll(), errors);
  await runAsyncCleanup(
    () => closeHttpServer(options.httpServer, options.closeTimeoutMs),
    errors,
  );
  if (errors.length > 0) throw new Error('Server shutdown failed');
}

function runCleanup(operation: () => void, errors: unknown[]): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}

async function runAsyncCleanup(
  operation: () => Promise<void>,
  errors: unknown[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

function closeHttpServer(
  server: LifecycleHttpServer,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.closeAllConnections();
      rejectClose(new Error('HTTP server close timed out'));
    }, timeoutMs);
    server.close((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error === undefined) resolveClose();
      else rejectClose(new Error('HTTP server close failed'));
    });
  });
}

export type SignalSource = Readonly<{
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}>;

export function registerShutdownSignals(
  lifecycle: Pick<ServerLifecycle, 'shutdown'>,
  signals: SignalSource = process,
): () => void {
  let requested = false;
  const shutdown = (): void => {
    if (requested) return;
    requested = true;
    void lifecycle.shutdown().catch(() => undefined);
  };
  signals.on('SIGTERM', shutdown);
  signals.on('SIGINT', shutdown);
  return () => {
    signals.off('SIGTERM', shutdown);
    signals.off('SIGINT', shutdown);
  };
}

export async function verifyRuntimeExecutables(
  paths: readonly string[],
  access: (path: string, mode: number) => Promise<void> = (path, mode) =>
    accessFile(path, mode),
): Promise<void> {
  try {
    await Promise.all(paths.map((path) => access(path, constants.X_OK)));
  } catch {
    throw new Error('Runtime dependency unavailable');
  }
}

export async function startProductionServer(
  environment: ConfigEnvironment = process.env,
): Promise<ServerLifecycle> {
  const config = loadConfig(environment);
  const logger = createLifecycleLogger(config.logLevel);
  await verifyRuntimeExecutables([
    config.defaultShell,
    TMUX_EXECUTABLE,
    SSH_EXECUTABLE,
  ]);

  const registry = new BridgeRegistry();
  const runner = new ExecFileCommandRunner();
  const preparer = new TmuxSessionPreparer(
    {
      executable: TMUX_EXECUTABLE,
      shell: config.defaultShell,
      homeDir: config.homeDir,
      historyLimit: config.tmuxHistoryLimit,
    },
    runner,
  );
  const sessionManager = new SessionManager({
    preparer,
    ptyFactory: new NodePtyFactory(undefined, environment),
    registry,
    bridgeFactory: new TerminalBridgeFactory(logger, config.wsMaxBufferBytes),
  });

  const runtime: {
    websocket?: TerminalWebSocketServer;
    lifecycle?: ServerLifecycle;
  } = {};
  const clientDist = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../client/dist',
  );
  const app = createApp({
    config,
    readiness: { isReady: () => runtime.lifecycle?.isReady() ?? false },
    metrics: {
      activeSessionCount: () =>
        registry.get(FIXED_SESSION_ID) === undefined ? 0 : 1,
      connectedWebSocketCount: () => runtime.websocket?.connectedCount() ?? 0,
    },
    clientDist,
  });
  const httpServer = createServer(app);
  const websocket = createTerminalWebSocketServer({
    server: httpServer,
    publicOrigin: config.publicOrigin,
    basePath: config.basePath,
    sessionManager,
    registry,
    logger,
    heartbeatIntervalMs: config.wsHeartbeatSeconds * 1000,
  });
  runtime.websocket = websocket;
  const lifecycle = createServerLifecycle({
    httpServer,
    websocket,
    registry,
    closeTimeoutMs: 5000,
  });
  runtime.lifecycle = lifecycle;
  await lifecycle.start(config.bindHost, config.port);
  registerShutdownSignals(lifecycle);
  logger.info('server_started', {
    bindHost: config.bindHost,
    port: config.port,
    basePath: config.basePath,
  });
  return lifecycle;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void startProductionServer().catch(() => {
    process.stderr.write('Server startup failed\n');
    process.exitCode = 1;
  });
}
