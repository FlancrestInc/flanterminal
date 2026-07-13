import { access as accessFile, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ActivityTracker } from './activity-tracker.js';
import { AdminService } from './admin-service.js';
import { createApp, type RuntimeMetrics } from './app.js';
import {
  createWebSocketUpgradeAuthenticator,
  type WebSocketUpgradeAuthenticator,
} from './auth-middleware.js';
import { AuthService } from './auth-service.js';
import { BridgeRegistry } from './bridge-registry.js';
import { CleanupEligibilityReader } from './cleanup-eligibility.js';
import { CloudflareAccessProvider } from './cloudflare-access.js';
import { loadOptionalConfigFile } from './config-file.js';
import { loadConfig, type ConfigEnvironment } from './config.js';
import { CredentialStore } from './credential-store.js';
import { CsrfService } from './csrf-service.js';
import { createLifecycleLogger } from './logger.js';
import { NodePtyFactory } from './pty.js';
import { LoginRateLimiter } from './rate-limiter.js';
import { createSecureJsonFile } from './secure-json-file.js';
import { SessionManager, TerminalBridgeFactory } from './session-manager.js';
import { StoredSessionRuntimeSettingsProvider } from './session-runtime-settings.js';
import { SettingsStore } from './settings-store.js';
import {
  StaleSessionCleaner,
  type CleanupStatus,
} from './stale-session-cleaner.js';
import { TabStore } from './tab-store.js';
import { ExecFileCommandRunner, TmuxSessionPreparer } from './tmux.js';
import { TrustedHeaderAuthProvider } from './trusted-header-auth.js';
import { WebSocketAuthIndex } from './websocket-auth-index.js';
import {
  createTerminalWebSocketServer,
  type TerminalWebSocketServer,
} from './websocket.js';
import { WorkspaceBootstrap } from './workspace-bootstrap.js';

import type {
  CleanupResult,
  WorkspaceSettings,
  WorkspaceSettingsConstraints,
} from '@flanterminal/shared';

const TMUX_EXECUTABLE = '/usr/bin/tmux';
const SSH_EXECUTABLE = '/usr/bin/ssh';

export interface LifecycleHttpServer {
  listen(port: number, host: string): unknown;
  close(callback?: (error?: Error) => void): unknown;
  closeAllConnections(): void;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'listening', listener: () => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'listening', listener: () => void): unknown;
}

export interface TeardownScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const nativeTeardownScheduler: TeardownScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type ServerLifecycleOptions = Readonly<{
  httpServer: LifecycleHttpServer;
  websocket: Pick<
    TerminalWebSocketServer,
    'stopAccepting' | 'stopHeartbeat' | 'closeClients' | 'close'
  >;
  cleaner: Readonly<{ shutdown(): Promise<void> }>;
  activity: Readonly<{ shutdown(): Promise<void> }>;
  registry: Readonly<{ closeAll(): Promise<void> }>;
  disposeServices?: () => void;
  durabilityReady: () => boolean;
  closeTimeoutMs: number;
  teardownScheduler?: TeardownScheduler;
}>;

export interface ServerLifecycle {
  start(host: string, port: number): Promise<void>;
  shutdown(): Promise<void>;
  isReady(): boolean;
}

export function createServerLifecycle(
  options: ServerLifecycleOptions,
): ServerLifecycle {
  let state: 'new' | 'starting' | 'running' | 'stopping' | 'stopped' = 'new';
  let listenAttempt: ListenAttempt | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    state = 'stopping';
    listenAttempt?.cancel();
    const operation = performShutdown(options);
    shutdownPromise = operation.then(
      () => {
        state = 'stopped';
      },
      () => {
        state = 'stopped';
        throw new Error('Server shutdown failed');
      },
    );
    return shutdownPromise;
  };

  return {
    isReady: () => {
      if (state !== 'running') return false;
      try {
        return options.durabilityReady() === true;
      } catch {
        return false;
      }
    },
    start(host, port) {
      if (state !== 'new') {
        return Promise.reject(new Error('Server lifecycle unavailable'));
      }
      state = 'starting';
      const attempt = createListenAttempt(options.httpServer, host, port);
      listenAttempt = attempt;
      return (async () => {
        try {
          await attempt.promise;
          if (state !== 'starting') throw new Error('Server startup failed');
          state = 'running';
        } catch {
          await shutdown().catch(() => undefined);
          throw new Error('Server startup failed');
        } finally {
          if (listenAttempt === attempt) listenAttempt = undefined;
        }
      })();
    },
    shutdown,
  };
}

type ListenAttempt = Readonly<{
  promise: Promise<void>;
  cancel(): void;
}>;

function createListenAttempt(
  server: LifecycleHttpServer,
  host: string,
  port: number,
): ListenAttempt {
  let cancel = (): void => undefined;
  const promise = new Promise<void>((resolveListen, rejectListen) => {
    let settled = false;
    const cleanup = (): void => {
      try {
        server.off('error', onError);
      } catch {
        // Listener disposal is best effort after authority is settled.
      }
      try {
        server.off('listening', onListening);
      } catch {
        // Listener disposal is best effort after authority is settled.
      }
    };
    const onError = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectListen(new Error('Server startup failed'));
    };
    const onListening = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveListen();
    };
    cancel = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectListen(new Error('Server startup failed'));
    };
    try {
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    } catch {
      cancel();
    }
  });
  return Object.freeze({ promise, cancel: () => cancel() });
}

async function performShutdown(options: ServerLifecycleOptions): Promise<void> {
  await performBoundedTeardown(
    options,
    options.closeTimeoutMs,
    options.teardownScheduler ?? nativeTeardownScheduler,
  );
}

function runCleanup(operation: () => void, errors: unknown[]): void {
  try {
    operation();
  } catch (error) {
    errors.push(error);
  }
}

function startAsyncCleanup(
  operation: () => Promise<void> | undefined,
  errors: unknown[],
): Promise<void> {
  try {
    return Promise.resolve(operation()).catch((error: unknown) => {
      errors.push(error);
    });
  } catch (error) {
    errors.push(error);
    return Promise.resolve();
  }
}

function beginHttpClose(server: LifecycleHttpServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    let settled = false;
    try {
      server.close((error) => {
        if (settled) return;
        settled = true;
        if (error === undefined) resolveClose();
        else rejectClose(new Error('HTTP server close failed'));
      });
    } catch {
      if (!settled) {
        settled = true;
        rejectClose(new Error('HTTP server close failed'));
      }
    }
  });
}

type TeardownResources = Readonly<{
  httpServer?: LifecycleHttpServer;
  websocket?: Pick<
    TerminalWebSocketServer,
    'stopAccepting' | 'stopHeartbeat' | 'closeClients' | 'close'
  >;
  cleaner?: Readonly<{ shutdown(): Promise<void> }>;
  activity?: Readonly<{ shutdown(): Promise<void> }>;
  registry?: Readonly<{ closeAll(): Promise<void> }>;
  disposeServices?: () => void;
}>;

async function performBoundedTeardown(
  resources: TeardownResources,
  timeoutMs: number,
  scheduler: TeardownScheduler,
): Promise<void> {
  const errors: unknown[] = [];
  runCleanup(() => resources.websocket?.stopAccepting(), errors);
  const httpClose =
    resources.httpServer === undefined
      ? Promise.resolve()
      : startAsyncCleanup(() => beginHttpClose(resources.httpServer!), errors);

  let deadlineReached = false;
  let timer: unknown;
  let resolveDeadline = (): void => undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    resolveDeadline = () => resolve('deadline');
  });
  const reachDeadline = (): void => {
    if (deadlineReached) return;
    deadlineReached = true;
    runCleanup(() => resources.httpServer?.closeAllConnections(), errors);
    resolveDeadline();
  };
  try {
    timer = scheduler.setTimeout(reachDeadline, timeoutMs);
  } catch (error) {
    errors.push(error);
    reachDeadline();
  }

  const phases: readonly (() => Promise<void>)[] = [
    () => {
      const durability: Promise<void>[] = [];
      if (resources.cleaner !== undefined) {
        durability.push(
          startAsyncCleanup(() => resources.cleaner!.shutdown(), errors),
        );
      }
      runCleanup(() => resources.websocket?.stopHeartbeat(), errors);
      if (resources.activity !== undefined) {
        durability.push(
          startAsyncCleanup(() => resources.activity!.shutdown(), errors),
        );
      }
      return Promise.all(durability).then(() => undefined);
    },
    () => {
      runCleanup(() => resources.websocket?.closeClients(), errors);
      return resources.registry === undefined
        ? Promise.resolve()
        : startAsyncCleanup(() => resources.registry!.closeAll(), errors);
    },
    () =>
      resources.websocket === undefined
        ? Promise.resolve()
        : startAsyncCleanup(() => resources.websocket!.close(), errors),
    () => {
      runCleanup(() => resources.disposeServices?.(), errors);
      return Promise.resolve();
    },
  ];

  let nextPhase = 0;
  for (; nextPhase < phases.length && !deadlineReached; nextPhase += 1) {
    const outcome = await Promise.race([
      phases[nextPhase]!().then(() => 'completed' as const),
      deadline,
    ]);
    if (outcome === 'deadline') {
      nextPhase += 1;
      break;
    }
  }

  if (!deadlineReached) {
    await Promise.race([httpClose.then(() => 'completed' as const), deadline]);
  }

  if (deadlineReached) {
    for (; nextPhase < phases.length; nextPhase += 1) {
      void phases[nextPhase]!();
    }
    errors.push(new Error('Teardown deadline exceeded'));
  } else if (timer !== undefined) {
    runCleanup(() => scheduler.clearTimeout(timer), errors);
  }
  if (errors.length > 0) throw new Error('Server shutdown failed');
}

export type SignalSource = Readonly<{
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}>;

export type ShutdownSignalOptions = Readonly<{
  signals?: SignalSource;
  logger?: Readonly<{
    error(event: string, metadata: Readonly<Record<string, unknown>>): void;
  }>;
  process?: { exitCode?: number };
}>;

export function registerShutdownSignals(
  lifecycle: Pick<ServerLifecycle, 'shutdown'>,
  options: ShutdownSignalOptions = {},
): () => void {
  const signals = options.signals ?? process;
  const logger = options.logger ?? { error: () => undefined };
  const processPort = options.process ?? process;
  let requested = false;
  const shutdown = (): void => {
    if (requested) return;
    requested = true;
    void lifecycle.shutdown().catch(() => {
      logger.error('shutdown_failed', { category: 'cleanup_failed' });
      processPort.exitCode = 1;
    });
  };
  try {
    signals.on('SIGTERM', shutdown);
    signals.on('SIGINT', shutdown);
  } catch (error) {
    try {
      signals.off('SIGTERM', shutdown);
    } catch {
      // Preserve the registration failure.
    }
    try {
      signals.off('SIGINT', shutdown);
    } catch {
      // Preserve the registration failure.
    }
    throw error;
  }
  return () => {
    try {
      signals.off('SIGTERM', shutdown);
    } catch {
      // Best-effort disposal still attempts the second signal.
    }
    try {
      signals.off('SIGINT', shutdown);
    } catch {
      // Signal disposal must remain bounded and idempotent.
    }
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

export type ProductionServices = Readonly<{
  activity: Readonly<{ shutdown(): Promise<void> }>;
  registry: Readonly<{ closeAll(): Promise<void> }>;
  dispose(): void;
  durabilityReady(): boolean;
  bindLifecycle?: (lifecycle: ServerLifecycle) => void;
  runtimeReady?: () => boolean;
}>;

export type ProductionRuntimeContext = Readonly<{
  environment: ConfigEnvironment;
  config: ReturnType<typeof loadConfig>;
  logger: ReturnType<typeof createLifecycleLogger>;
  settings?: unknown;
  authentication?: unknown;
  tabs?: unknown;
  services?: ProductionServices;
  httpServer?: LifecycleHttpServer;
  websocket?: TerminalWebSocketServer;
  cleaner?: Readonly<{ shutdown(): Promise<void> }>;
}>;

export interface ProductionRuntimeFactory {
  loadOptionalConfigFile(
    path: string | undefined,
  ): Promise<Readonly<Record<string, unknown>>>;
  loadConfig(
    environment: ConfigEnvironment,
    fileValues: Readonly<Record<string, unknown>>,
  ): ReturnType<typeof loadConfig>;
  createLogger(
    config: ReturnType<typeof loadConfig>,
  ): ReturnType<typeof createLifecycleLogger>;
  initializeSettings(context: ProductionRuntimeContext): Promise<unknown>;
  initializeAuthentication(context: ProductionRuntimeContext): Promise<unknown>;
  initializeTabs(context: ProductionRuntimeContext): Promise<unknown>;
  verifyRuntimeExecutables(context: ProductionRuntimeContext): Promise<void>;
  createServices(context: ProductionRuntimeContext): ProductionServices;
  createHttp(context: ProductionRuntimeContext): LifecycleHttpServer;
  createWebsocket(context: ProductionRuntimeContext): TerminalWebSocketServer;
  createCleaner(
    context: ProductionRuntimeContext,
  ): Readonly<{ shutdown(): Promise<void> }>;
  registerShutdownSignals(
    lifecycle: Pick<ServerLifecycle, 'shutdown'>,
    context: ProductionRuntimeContext,
  ): () => void;
}

export type ProductionRuntime = Readonly<{
  config: ReturnType<typeof loadConfig>;
  lifecycle: ServerLifecycle;
}>;

export async function createProductionRuntime(
  environment: ConfigEnvironment = process.env,
  factory: ProductionRuntimeFactory = defaultProductionRuntimeFactory,
): Promise<ProductionRuntime> {
  let config: ReturnType<typeof loadConfig> | undefined;
  let logger: ReturnType<typeof createLifecycleLogger> | undefined;
  let settings: unknown;
  let authentication: unknown;
  let tabs: unknown;
  let services: ProductionServices | undefined;
  let httpServer: LifecycleHttpServer | undefined;
  let websocket: TerminalWebSocketServer | undefined;
  let cleaner: Readonly<{ shutdown(): Promise<void> }> | undefined;
  let lifecycle: ServerLifecycle | undefined;
  let disposeSignals: (() => void) | undefined;
  let disposedSignals = false;

  const context = (): ProductionRuntimeContext =>
    ({
      environment,
      ...(config === undefined ? {} : { config }),
      ...(logger === undefined ? {} : { logger }),
      ...(settings === undefined ? {} : { settings }),
      ...(authentication === undefined ? {} : { authentication }),
      ...(tabs === undefined ? {} : { tabs }),
      ...(services === undefined ? {} : { services }),
      ...(httpServer === undefined ? {} : { httpServer }),
      ...(websocket === undefined ? {} : { websocket }),
      ...(cleaner === undefined ? {} : { cleaner }),
    }) as ProductionRuntimeContext;

  const disposeSignalRegistration = (): void => {
    if (disposedSignals) return;
    disposedSignals = true;
    try {
      disposeSignals?.();
    } catch {
      // Signal disposal cannot prevent resource shutdown.
    }
  };

  try {
    const fileValues = await factory.loadOptionalConfigFile(
      environment.APP_CONFIG_FILE,
    );
    config = factory.loadConfig(environment, fileValues);
    logger = factory.createLogger(config);
    settings = await factory.initializeSettings(context());
    authentication = await factory.initializeAuthentication(context());
    tabs = await factory.initializeTabs(context());
    await factory.verifyRuntimeExecutables(context());
    services = factory.createServices(context());
    httpServer = factory.createHttp(context());
    websocket = factory.createWebsocket(context());
    cleaner = factory.createCleaner(context());
    lifecycle = createServerLifecycle({
      httpServer,
      websocket,
      cleaner,
      activity: services.activity,
      registry: services.registry,
      disposeServices: services.dispose,
      durabilityReady: services.durabilityReady,
      closeTimeoutMs: 5_000,
    });
    services.bindLifecycle?.(lifecycle);
    await lifecycle.start(config.bindHost, config.port);
    const ownedLifecycle = lifecycle;
    const publicLifecycle: ServerLifecycle = {
      start: (host, port) => ownedLifecycle.start(host, port),
      isReady: () => ownedLifecycle.isReady(),
      shutdown() {
        disposeSignalRegistration();
        return ownedLifecycle.shutdown();
      },
    };
    disposeSignals = factory.registerShutdownSignals(
      publicLifecycle,
      context(),
    );
    try {
      logger.info('server_started', {
        bindHost: config.bindHost,
        port: config.port,
        basePath: config.basePath,
      });
    } catch {
      // Observability is not an ownership boundary.
    }
    return Object.freeze({ config, lifecycle: publicLifecycle });
  } catch (error) {
    disposeSignalRegistration();
    if (lifecycle !== undefined) {
      await lifecycle.shutdown().catch(() => undefined);
    } else {
      await rollbackProductionResources({
        ...(httpServer === undefined ? {} : { httpServer }),
        ...(websocket === undefined ? {} : { websocket }),
        ...(cleaner === undefined ? {} : { cleaner }),
        ...(services === undefined ? {} : { services }),
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function rollbackProductionResources(resources: {
  httpServer?: LifecycleHttpServer;
  websocket?: TerminalWebSocketServer;
  cleaner?: Readonly<{ shutdown(): Promise<void> }>;
  services?: ProductionServices;
}): Promise<void> {
  await performBoundedTeardown(
    {
      ...(resources.httpServer === undefined
        ? {}
        : { httpServer: resources.httpServer }),
      ...(resources.websocket === undefined
        ? {}
        : { websocket: resources.websocket }),
      ...(resources.cleaner === undefined
        ? {}
        : { cleaner: resources.cleaner }),
      ...(resources.services === undefined
        ? {}
        : {
            activity: resources.services.activity,
            registry: resources.services.registry,
            disposeServices: resources.services.dispose,
          }),
    },
    5_000,
    nativeTeardownScheduler,
  );
}

type SettingsStage = Readonly<{
  store: SettingsStore;
  constraints: WorkspaceSettingsConstraints;
}>;

export type ProductionAuthentication = Readonly<{
  authService: AuthService;
  cloudflareAccessProvider?: CloudflareAccessProvider;
  trustedHeaderProvider?: TrustedHeaderAuthProvider;
}>;
type AuthenticationStage = ProductionAuthentication;

export type ProductionAuthenticationDependencies = Readonly<{
  createCredentialStore?: (
    config: ReturnType<typeof loadConfig>,
  ) => CredentialStore;
  createCloudflareAccessProvider?: (
    config: ReturnType<typeof loadConfig>,
  ) => CloudflareAccessProvider;
  createTrustedHeaderProvider?: (
    config: ReturnType<typeof loadConfig>,
  ) => TrustedHeaderAuthProvider;
}>;

type TabsStage = Readonly<{ store: TabStore }>;

type ServicesStage = ProductionServices &
  Readonly<{
    registry: BridgeRegistry;
    activity: ActivityTracker;
    sessionManager: SessionManager;
    eligibility: CleanupEligibilityReader;
    websocketAuthIndex: WebSocketAuthIndex;
    websocketAuthenticator: WebSocketUpgradeAuthenticator;
    workspaceBootstrap: WorkspaceBootstrap;
    adminService: AdminService;
    cleanupPort: DeferredCleanupPort;
  }>;

function workspaceSettingsConstraints(
  config: ReturnType<typeof loadConfig>,
): WorkspaceSettingsConstraints {
  return Object.freeze({
    limits: Object.freeze({
      fontFamilies: Object.freeze([
        'jetbrains-mono-nerd' as const,
        'system-monospace' as const,
      ]),
      fontSize: Object.freeze({ min: 8, max: config.maxFontSize, step: 1 }),
      lineHeight: Object.freeze({ min: 1, max: 2, step: 0.05 }),
      letterSpacing: Object.freeze({ min: 0, max: 4, step: 1 }),
      scrollback: Object.freeze({
        min: 0,
        max: config.maxXtermScrollback,
        step: 1,
      }),
      themes: Object.freeze([
        'dark' as const,
        'light' as const,
        'ubuntu' as const,
      ]),
      cursorStyles: Object.freeze([
        'block' as const,
        'underline' as const,
        'bar' as const,
      ]),
      bellBehaviors: Object.freeze([
        'none' as const,
        'visual' as const,
        'sound' as const,
      ]),
      reconnectBehaviors: Object.freeze([
        'automatic' as const,
        'manual' as const,
      ]),
      workspaceShortcutModes: Object.freeze([
        'default' as const,
        'disabled' as const,
      ]),
      tmuxHistoryLimit: Object.freeze({
        min: 0,
        max: config.maxTmuxHistoryLimit,
        step: 1,
      }),
      staleSessionCleanupHours: Object.freeze({
        min: 0,
        max: config.maxStaleSessionCleanupHours,
        step: 1,
      }),
    }),
    allowedShells: Object.freeze([...config.allowedShells]),
  });
}

function defaultWorkspaceSettings(
  config: ReturnType<typeof loadConfig>,
): WorkspaceSettings {
  return Object.freeze({
    version: 1,
    fontFamily: 'jetbrains-mono-nerd',
    fontSize: Math.min(config.defaultFontSize, config.maxFontSize),
    lineHeight: 1.2,
    letterSpacing: 0,
    scrollback: Math.min(config.xtermScrollback, config.maxXtermScrollback),
    theme: 'dark',
    cursorStyle: 'block',
    cursorBlink: true,
    bellBehavior: 'visual',
    reconnectBehavior: 'automatic',
    automaticTabCreation: true,
    workspaceShortcuts: 'default',
    defaultShell: config.defaultShell,
    tmuxHistoryLimit: Math.min(
      config.tmuxHistoryLimit,
      config.maxTmuxHistoryLimit,
    ),
    staleSessionCleanupHours: 0,
  });
}

function asSettingsStage(value: unknown): SettingsStage {
  return value as SettingsStage;
}

function asAuthenticationStage(value: unknown): AuthenticationStage {
  return value as AuthenticationStage;
}

function asTabsStage(value: unknown): TabsStage {
  return value as TabsStage;
}

function asServicesStage(value: ProductionServices | undefined): ServicesStage {
  return value as ServicesStage;
}

function required(value: string | undefined): string {
  if (value === undefined) throw new Error('Invalid authentication config');
  return value;
}

function requiredProxyRanges(
  value: ReturnType<typeof loadConfig>['trustProxy'],
): readonly string[] {
  if (!Array.isArray(value)) throw new Error('Invalid authentication config');
  return value;
}

export async function initializeProductionAuthentication(
  config: ReturnType<typeof loadConfig>,
  dependencies: ProductionAuthenticationDependencies = {},
): Promise<ProductionAuthentication> {
  const credentialStore =
    config.authMode === 'local'
      ? (dependencies.createCredentialStore?.(config) ??
        new CredentialStore({
          dataDir: config.dataDir,
          secureFile: createSecureJsonFile(),
        }))
      : undefined;
  if (credentialStore !== undefined) {
    await credentialStore.initializeLocal(
      config.localAuthUsername,
      config.localAuthPasswordFile,
      config.bcryptCost,
    );
  }
  const authService = new AuthService({
    mode: config.authMode,
    clock: Date.now,
    credentialStore:
      credentialStore !== undefined
        ? credentialStore
        : Object.freeze({
            verify: () => false,
            replacePassword: async () =>
              Object.freeze({ state: 'not_committed' as const }),
          }),
    csrfService: new CsrfService(),
    rateLimiter: new LoginRateLimiter({
      clock: Date.now,
      global: { capacity: 20, refillPerSecond: 1 / 3 },
      address: { capacity: 5, refillPerSecond: 1 / 12 },
      maxAddresses: 256,
    }),
    idleDurationMs: config.authIdleMinutes * 60_000,
    absoluteDurationMs: config.authAbsoluteHours * 60 * 60_000,
    maxSessions: config.authSessionMaxCount,
  });
  const cloudflareAccessProvider =
    config.authMode === 'cloudflare-access'
      ? (dependencies.createCloudflareAccessProvider?.(config) ??
        new CloudflareAccessProvider({
          teamOrigin: required(config.cloudflareTeamDomain),
          audience: required(config.cloudflareAccessAud),
        }))
      : undefined;
  const trustedHeaderProvider =
    config.authMode === 'trusted-header'
      ? (dependencies.createTrustedHeaderProvider?.(config) ??
        new TrustedHeaderAuthProvider({
          trustProxy: requiredProxyRanges(config.trustProxy),
          identityHeader: config.trustedAuthHeader,
          publicOrigin: config.publicOrigin,
        }))
      : undefined;
  return Object.freeze({
    authService,
    ...(cloudflareAccessProvider === undefined
      ? {}
      : { cloudflareAccessProvider }),
    ...(trustedHeaderProvider === undefined ? {} : { trustedHeaderProvider }),
  });
}

export function createProductionRuntimeMetrics(sources: {
  registry: Readonly<{ registeredCount(): number }>;
  sockets: Readonly<{ connectedCount(): number }>;
}): RuntimeMetrics {
  return Object.freeze({
    activeSessionCount: () => sources.registry.registeredCount(),
    connectedWebSocketCount: () => sources.sockets.connectedCount(),
  });
}

class DeferredCleanupPort {
  private target: StaleSessionCleaner | undefined;

  bind(target: StaleSessionCleaner): void {
    if (this.target !== undefined) throw new Error('Cleanup already bound');
    this.target = target;
  }

  status(): CleanupStatus {
    if (this.target === undefined) {
      return Object.freeze({
        enabled: false,
        running: false,
        lastRunAt: null,
        dependencyFailure: 'settings_unavailable',
      });
    }
    return this.target.status();
  }

  runNow(): Promise<CleanupResult> {
    return this.target === undefined
      ? Promise.reject(new Error('Cleanup unavailable'))
      : this.target.runNow();
  }
}

const defaultProductionRuntimeFactory: ProductionRuntimeFactory = {
  loadOptionalConfigFile,
  loadConfig,
  createLogger: (config) => createLifecycleLogger(config.logLevel),
  async initializeSettings(context) {
    const { config, logger } = context;
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    const constraints = workspaceSettingsConstraints(config);
    const store = new SettingsStore({
      dataDir: config.dataDir,
      defaults: defaultWorkspaceSettings(config),
      constraints,
      secureFile: createSecureJsonFile(),
      onDurabilityEvent: (event) => logger.warn(event.type),
    });
    await store.initialize();
    return Object.freeze({ store, constraints });
  },
  async initializeAuthentication(context) {
    return await initializeProductionAuthentication(context.config);
  },
  async initializeTabs(context) {
    const { config, logger } = context;
    const store = new TabStore({
      dataDir: config.dataDir,
      sessionMaxCount: config.sessionMaxCount,
      onDurabilityEvent: (event) => logger.warn(event.type),
    });
    await store.initialize();
    return Object.freeze({ store });
  },
  async verifyRuntimeExecutables(context) {
    await verifyRuntimeExecutables([
      ...context.config.allowedShells,
      TMUX_EXECUTABLE,
      SSH_EXECUTABLE,
    ]);
  },
  createServices(context) {
    const { config, environment, logger } = context;
    const settings = asSettingsStage(context.settings);
    const authentication = asAuthenticationStage(context.authentication);
    const tabs = asTabsStage(context.tabs);
    const registry = new BridgeRegistry();
    const activity = new ActivityTracker({ store: tabs.store });
    const preparer = new TmuxSessionPreparer(
      { executable: TMUX_EXECUTABLE, homeDir: config.homeDir },
      new ExecFileCommandRunner(),
    );
    const runtimeSettings = new StoredSessionRuntimeSettingsProvider({
      store: settings.store,
      constraints: settings.constraints,
      verifiedShells: config.allowedShells,
    });
    const websocketAuthenticator = createWebSocketUpgradeAuthenticator({
      mode: config.authMode,
      publicOrigin: config.publicOrigin,
      authService: authentication.authService,
      ...(authentication.cloudflareAccessProvider === undefined
        ? {}
        : {
            cloudflareAccessProvider: authentication.cloudflareAccessProvider,
          }),
      ...(authentication.trustedHeaderProvider === undefined
        ? {}
        : { trustedHeaderProvider: authentication.trustedHeaderProvider }),
      logger,
    });
    const websocketAuthIndex = new WebSocketAuthIndex({
      auth: websocketAuthenticator,
      maxApplicationSessions: config.authSessionMaxCount,
      maxSockets: Math.min(1_024, config.authSessionMaxCount * 20),
    });
    const eligibility = new CleanupEligibilityReader({
      tabs: tabs.store,
      activity,
      sockets: websocketAuthIndex,
      bridges: registry,
      runtime: preparer,
    });
    const sessionManager = new SessionManager({
      preparer,
      ptyFactory: new NodePtyFactory(undefined, environment),
      registry,
      bridgeFactory: new TerminalBridgeFactory(
        logger,
        config.wsMaxBufferBytes,
        activity,
      ),
      store: tabs.store,
      activity,
      runtimeSettings,
      cleanupEligibility: eligibility,
    });
    const workspaceBootstrap = new WorkspaceBootstrap({
      settingsStore: settings.store,
      tabStore: tabs.store,
    });
    const cleanupPort = new DeferredCleanupPort();
    const adminService = new AdminService({
      tabs: tabs.store,
      runtime: preparer,
      bridges: registry,
      sockets: websocketAuthIndex,
      eligibility,
      cleanupSettings: settings.store,
      cleanup: cleanupPort,
      maxSessions: config.sessionMaxCount,
    });
    let lifecycle: ServerLifecycle | undefined;
    return {
      registry,
      activity,
      sessionManager,
      eligibility,
      websocketAuthIndex,
      websocketAuthenticator,
      workspaceBootstrap,
      adminService,
      cleanupPort,
      dispose: () => websocketAuthIndex.dispose(),
      durabilityReady: () =>
        tabs.store.durabilityReady() && settings.store.durabilityReady(),
      bindLifecycle: (value: ServerLifecycle) => {
        if (lifecycle !== undefined) throw new Error('Lifecycle already bound');
        lifecycle = value;
      },
      runtimeReady: () => lifecycle?.isReady() ?? false,
    };
  },
  createHttp(context) {
    const settings = asSettingsStage(context.settings);
    const authentication = asAuthenticationStage(context.authentication);
    const tabs = asTabsStage(context.tabs);
    const services = asServicesStage(context.services);
    const app = createApp({
      config: context.config,
      readiness: { isReady: () => services.runtimeReady?.() ?? false },
      metrics: createProductionRuntimeMetrics({
        registry: services.registry,
        sockets: services.websocketAuthIndex,
      }),
      clientDist: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../client/dist',
      ),
      http: {
        auth: {
          mode: context.config.authMode,
          authService: authentication.authService,
          workspaceBootstrap: services.workspaceBootstrap,
          ...(authentication.cloudflareAccessProvider === undefined
            ? {}
            : {
                cloudflareAccessProvider:
                  authentication.cloudflareAccessProvider,
              }),
          ...(authentication.trustedHeaderProvider === undefined
            ? {}
            : {
                trustedHeaderProvider: authentication.trustedHeaderProvider,
              }),
          logger: context.logger,
        },
        settings: {
          store: settings.store,
          constraints: settings.constraints,
        },
        tabs: { store: tabs.store, sessions: services.sessionManager },
        admin: {
          admin: services.adminService,
          sessions: services.sessionManager,
          cleanup: services.cleanupPort,
          logger: context.logger,
        },
      },
    });
    return createServer(app);
  },
  createWebsocket(context) {
    const server = context.httpServer as ReturnType<typeof createServer>;
    const services = asServicesStage(context.services);
    return createTerminalWebSocketServer({
      server,
      publicOrigin: context.config.publicOrigin,
      basePath: context.config.basePath,
      sessionManager: services.sessionManager,
      registry: services.registry,
      logger: context.logger,
      heartbeatIntervalMs: context.config.wsHeartbeatSeconds * 1_000,
      upgradeAuthenticator: services.websocketAuthenticator,
      authIndex: services.websocketAuthIndex,
    });
  },
  createCleaner(context) {
    const settings = asSettingsStage(context.settings);
    const tabs = asTabsStage(context.tabs);
    const services = asServicesStage(context.services);
    const cleaner = new StaleSessionCleaner({
      settings: settings.store,
      tabs: tabs.store,
      eligibility: services.eligibility,
      sessions: services.sessionManager,
      maxSessions: context.config.sessionMaxCount,
      intervalMs: context.config.sessionCleanupIntervalMinutes * 60_000,
    });
    services.cleanupPort.bind(cleaner);
    return cleaner;
  },
  registerShutdownSignals: (lifecycle, context) =>
    registerShutdownSignals(lifecycle, { logger: context.logger }),
};

export async function startProductionServer(
  environment: ConfigEnvironment = process.env,
): Promise<ServerLifecycle> {
  return (await createProductionRuntime(environment)).lifecycle;
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
