import {
  BRIDGE_RESTART,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  SESSION_RESTARTING,
  SESSION_STOPPED,
  isSessionId,
  type DesiredState,
  type TabCollection,
  type TabCollectionResponse,
  type TabRecord,
  type TabView,
} from '@flanterminal/shared';

import type { BridgeRegistry } from './bridge-registry.js';
import {
  sameEligibilityGeneration,
  type CleanupSkipReason,
  type EligibilityRequest,
  type EligibilitySnapshot,
} from './cleanup-eligibility.js';
import type { LifecycleLogger } from './logger.js';
import type { PtyFactory, PtyProcess, TerminalDimensions } from './pty.js';
import {
  TerminalBridge,
  type BridgeOwner,
  type SocketPort,
} from './terminal-bridge.js';
import type { AttachSpec, SessionPreparer } from './tmux.js';
import type {
  SessionRuntimeSettings,
  SessionRuntimeSettingsProvider,
} from './session-runtime-settings.js';

export type ManagedBridgeOptions = Readonly<{
  sessionId: string;
  socket: SocketPort;
  pty: PtyProcess;
}>;

export interface ManagedBridgeFactory {
  /** Takes ownership of the PTY immediately, including when creation throws. */
  create(options: ManagedBridgeOptions): BridgeOwner;
}

export interface ActivityMarker {
  mark(id: string): void;
}

export interface CleanupEligibilityReaderPort {
  read(request: EligibilityRequest): Promise<EligibilitySnapshot>;
}

export type CleanupTerminationResult =
  'terminated' | `skipped:${CleanupSkipReason}`;

export class TerminalBridgeFactory implements ManagedBridgeFactory {
  constructor(
    private readonly logger: LifecycleLogger,
    private readonly maxBufferedBytes: number,
    private readonly activity?: ActivityMarker,
  ) {}

  create(options: ManagedBridgeOptions): BridgeOwner {
    return new TerminalBridge({
      ...options,
      logger: this.logger,
      maxBufferedBytes: this.maxBufferedBytes,
      ...(this.activity === undefined
        ? {}
        : { onActivity: (id: string) => this.activity?.mark(id) }),
      authenticatedInput: options.socket.authenticatedInput,
    });
  }
}

export type ConnectRequest = Readonly<{
  sessionId: string;
  socket: SocketPort;
  dimensions: TerminalDimensions;
}>;

export interface SessionTabStore {
  snapshot(): TabCollection;
  has(id: string): boolean;
  setDesiredState(id: string, state: DesiredState): Promise<TabRecord>;
  remove(id: string): Promise<void>;
}

export interface SessionRuntimeController extends SessionPreparer {
  exists(sessionId: string): Promise<boolean>;
  kill(sessionId: string): Promise<void>;
  listActiveSessionIds(): Promise<string[]>;
  attachSpec(sessionId: string, settings?: SessionRuntimeSettings): AttachSpec;
}

export type SessionManagerOptions = Readonly<{
  preparer: SessionPreparer | SessionRuntimeController;
  ptyFactory: PtyFactory;
  registry: BridgeRegistry;
  bridgeFactory: ManagedBridgeFactory;
  store?: SessionTabStore;
  activity?: ActivityMarker;
  runtimeSettings?: SessionRuntimeSettingsProvider;
  cleanupEligibility?: CleanupEligibilityReaderPort;
}>;

const ATTACH_TOKEN_BRAND = Symbol('AttachToken');
const MAX_RUNTIME_SHELL_BYTES = 4_096;
const MAX_RUNTIME_HISTORY_LIMIT = 1_000_000;
const unsafeRuntimeShellCharacterPattern = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Cf}]/u;

export type AttachToken = Readonly<{
  sessionId: string;
  generation: number;
  [ATTACH_TOKEN_BRAND]: true;
}>;

export type TabCollectionView = TabCollectionResponse;

export type SessionManagerErrorCode =
  | 'invalid_connection'
  | 'stale_attach'
  | 'tab_not_found'
  | 'invalid_session_state'
  | 'operation_failed';

export class SessionManagerError extends Error {
  constructor(
    readonly code: SessionManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidConnectionError extends SessionManagerError {
  constructor() {
    super('invalid_connection', 'Invalid terminal connection');
  }
}

export class StaleAttachError extends SessionManagerError {
  constructor() {
    super('stale_attach', 'Attach authorization expired');
  }
}

export class TabNotFoundError extends SessionManagerError {
  constructor() {
    super('tab_not_found', 'Tab not found');
  }
}

export class InvalidSessionStateError extends SessionManagerError {
  constructor() {
    super('invalid_session_state', 'Invalid session state');
  }
}

export class OperationFailedError extends SessionManagerError {
  constructor(readonly view?: TabView) {
    super('operation_failed', 'Session operation failed');
  }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);

    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class SessionManager {
  private readonly mutex = new KeyedMutex();
  private readonly generations = new Map<string, number>();
  private generationClock = 0;
  private readonly issuedTokens = new WeakSet<object>();
  private readonly compatibilityMode: boolean;

  constructor(private readonly options: SessionManagerOptions) {
    // Task 7 wires the store and activity tracker into production. Until then,
    // omitting both preserves only the Phase 1 request-shaped connect call.
    this.compatibilityMode =
      options.store === undefined && options.activity === undefined;
  }

  authorize(id: string): AttachToken | undefined {
    const store = this.options.store;
    if (store === undefined || !isSessionId(id)) return undefined;
    try {
      if (!store.has(id)) return undefined;
      const record = findRecord(store.snapshot(), id);
      if (record?.desiredState !== 'active') return undefined;
      const token = Object.freeze({
        sessionId: id,
        generation: this.ensureGeneration(id),
        [ATTACH_TOKEN_BRAND]: true as const,
      });
      this.issuedTokens.add(token);
      return token;
    } catch {
      return undefined;
    }
  }

  connect(request: ConnectRequest): Promise<BridgeOwner>;
  connect(
    token: AttachToken,
    socket: SocketPort,
    dimensions: TerminalDimensions,
  ): Promise<BridgeOwner>;
  connect(
    tokenOrRequest: AttachToken | ConnectRequest,
    socket?: SocketPort,
    dimensions?: TerminalDimensions,
  ): Promise<BridgeOwner> {
    if (socket === undefined || dimensions === undefined) {
      if (!this.compatibilityMode || !isValidLegacyRequest(tokenOrRequest)) {
        return Promise.reject(new InvalidConnectionError());
      }
      return this.connectLegacy(tokenOrRequest);
    }

    if (!isValidDimensions(dimensions) || !this.isIssuedToken(tokenOrRequest)) {
      return Promise.reject(
        !isValidDimensions(dimensions)
          ? new InvalidConnectionError()
          : new StaleAttachError(),
      );
    }

    const token = tokenOrRequest;
    return this.mutex.runExclusive(token.sessionId, async () => {
      const dependencies = this.requirePhaseTwo();
      const record = this.currentRecord(token.sessionId);
      if (
        record === undefined ||
        record.desiredState !== 'active' ||
        token.generation !== this.generations.get(token.sessionId)
      ) {
        throw new StaleAttachError();
      }
      return this.attach(
        token.sessionId,
        socket,
        dimensions,
        dependencies.runtime,
        true,
        this.captureRuntimeSettings(),
      );
    });
  }

  terminate(id: string): Promise<TabView> {
    return this.mutex.runExclusive(id, () => this.terminateLocked(id));
  }

  terminateIfStale(
    id: string,
    captured: EligibilitySnapshot,
  ): Promise<CleanupTerminationResult> {
    return this.mutex.runExclusive<CleanupTerminationResult>(id, async () => {
      if (!isValidEligibilityCapture(id, captured)) return 'skipped:invalid';
      if (!captured.eligible) return `skipped:${captured.reason ?? 'invalid'}`;
      const reader = this.options.cleanupEligibility;
      if (reader === undefined) return 'skipped:dependency_error';

      let fresh: EligibilitySnapshot;
      try {
        fresh = await reader.read({
          id,
          thresholdMs: captured.thresholdMs,
          cutoffMs: captured.cutoffMs,
        });
      } catch {
        return 'skipped:dependency_error';
      }
      if (!isValidEligibilityCapture(id, fresh))
        return 'skipped:dependency_error';
      if (!fresh.eligible) return `skipped:${fresh.reason ?? 'invalid'}`;
      if (!sameEligibilityGeneration(captured, fresh)) return 'skipped:changed';

      await this.terminateLocked(id);
      return 'terminated';
    });
  }

  recreate(id: string): Promise<TabView> {
    return this.mutex.runExclusive(id, async () => {
      const dependencies = this.requireLifecycleTab(id);
      if (this.requireCurrentRecord(id).desiredState !== 'stopped') {
        throw new InvalidSessionStateError();
      }
      const settings = this.captureRuntimeSettings();

      let exists: boolean;
      try {
        exists = await dependencies.runtime.exists(id);
      } catch {
        throw new InvalidSessionStateError();
      }
      if (exists) throw new InvalidSessionStateError();

      this.incrementGeneration(id);
      try {
        await dependencies.runtime.prepare(id, settings);
        await dependencies.store.setDesiredState(id, 'active');
      } catch {
        await ignoreFailure(() => dependencies.runtime.kill(id));
        throw new OperationFailedError();
      }
      this.incrementGeneration(id);
      this.mark(id);
      return this.viewFromRecord(
        this.requireCurrentRecord(id),
        await this.probeHealth(id),
      );
    });
  }

  restart(id: string): Promise<TabView> {
    return this.mutex.runExclusive(id, async () => {
      const dependencies = this.requireLifecycleTab(id);
      const settings = this.captureRuntimeSettings();
      this.incrementGeneration(id);
      try {
        await dependencies.store.setDesiredState(id, 'stopped');
      } catch {
        throw new OperationFailedError();
      }

      const stopFailed = await this.stopRuntime(
        id,
        SESSION_RESTARTING,
        'session_restarting',
        dependencies.runtime,
      );
      if (stopFailed) {
        this.mark(id);
        throw new OperationFailedError(await this.viewBestEffort(id));
      }

      try {
        await dependencies.runtime.prepare(id, settings);
        await dependencies.store.setDesiredState(id, 'active');
      } catch {
        await ignoreFailure(() => dependencies.runtime.kill(id));
        this.mark(id);
        throw new OperationFailedError(await this.viewBestEffort(id));
      }
      this.incrementGeneration(id);
      this.mark(id);
      return this.viewFromRecord(
        this.requireCurrentRecord(id),
        await this.probeHealth(id),
      );
    });
  }

  restartBridge(id: string): Promise<TabView> {
    return this.mutex.runExclusive(id, async () => {
      this.requireLifecycleTab(id);
      try {
        await this.options.registry.close(id, BRIDGE_RESTART, 'bridge_restart');
      } catch {
        throw new OperationFailedError();
      }
      this.mark(id);
      return this.viewFromRecord(
        this.requireCurrentRecord(id),
        await this.probeHealth(id),
      );
    });
  }

  closeTab(id: string): Promise<void> {
    return this.mutex.runExclusive(id, async () => {
      const dependencies = this.requireLifecycleTab(id);
      this.incrementGeneration(id);
      try {
        await dependencies.store.setDesiredState(id, 'stopped');
      } catch {
        throw new OperationFailedError();
      }
      this.mark(id);

      const failure = await this.stopRuntime(
        id,
        SESSION_STOPPED,
        'session_stopped',
        dependencies.runtime,
      );
      if (failure) {
        throw new OperationFailedError(await this.viewBestEffort(id));
      }
      try {
        await dependencies.store.remove(id);
      } catch {
        throw new OperationFailedError(await this.viewBestEffort(id));
      }
      this.generations.delete(id);
    });
  }

  async view(id: string): Promise<TabView> {
    const dependencies = this.requireLifecycleTab(id);
    const record = this.requireCurrentRecord(id);
    return this.viewFromRecord(
      record,
      await this.probeHealth(id, dependencies.runtime),
    );
  }

  async collectionView(): Promise<TabCollectionView> {
    const { store, runtime } = this.requirePhaseTwo();
    let snapshot: TabCollection;
    try {
      snapshot = store.snapshot();
    } catch {
      throw new OperationFailedError();
    }
    const registryEntries = this.options.registry.entries();
    let active: ReadonlySet<string> | undefined;
    try {
      active = new Set(await runtime.listActiveSessionIds());
    } catch {
      active = undefined;
    }
    const bridges = new Map(
      registryEntries.map((entry) => [entry.sessionId, entry] as const),
    );
    return immutableCollection({
      structureRevision: snapshot.structureRevision,
      tabs: snapshot.tabs.map((record) => {
        const bridge = bridges.get(record.id);
        return this.viewFromRecord(record, {
          state:
            active === undefined
              ? 'unknown'
              : active.has(record.id)
                ? 'running'
                : 'stopped',
          attached: bridge !== undefined,
          bridgePid: bridge?.pid ?? null,
        });
      }),
    });
  }

  private async connectLegacy(request: ConnectRequest): Promise<BridgeOwner> {
    return this.mutex.runExclusive(request.sessionId, () =>
      this.attach(
        request.sessionId,
        request.socket,
        request.dimensions,
        this.options.preparer,
        false,
      ),
    );
  }

  private async attach(
    id: string,
    socket: SocketPort,
    dimensions: TerminalDimensions,
    preparer: SessionPreparer,
    markActivity: boolean,
    settings?: SessionRuntimeSettings,
  ): Promise<BridgeOwner> {
    try {
      const spec = await preparer.prepare(id, settings);
      await this.options.registry.close(id);
      const pty = this.options.ptyFactory.spawn(spec, dimensions);
      const bridge = this.options.bridgeFactory.create({
        sessionId: id,
        socket,
        pty,
      });
      await this.options.registry.replace(id, bridge);
      if (markActivity) this.mark(id);
      return bridge;
    } catch (error) {
      if (error instanceof SessionManagerError) throw error;
      throw new OperationFailedError();
    }
  }

  private async stopRuntime(
    id: string,
    code: number,
    reason: string,
    runtime: SessionRuntimeController,
  ): Promise<boolean> {
    let failed = false;
    try {
      await this.options.registry.close(id, code, reason);
    } catch {
      failed = true;
    }
    try {
      await runtime.kill(id);
    } catch {
      failed = true;
    }
    return failed;
  }

  private async terminateLocked(id: string): Promise<TabView> {
    const dependencies = this.requireLifecycleTab(id);
    const current = this.requireCurrentRecord(id);
    if (current.desiredState === 'stopped') {
      try {
        if (
          !(await dependencies.runtime.exists(id)) &&
          this.options.registry.get(id) === undefined
        ) {
          return this.viewFromRecord(current, {
            state: 'stopped',
            attached: false,
            bridgePid: null,
          });
        }
      } catch {
        // An indeterminate stopped runtime is retried through normal cleanup.
      }
    }
    this.incrementGeneration(id);
    try {
      await dependencies.store.setDesiredState(id, 'stopped');
    } catch {
      throw new OperationFailedError();
    }
    this.mark(id);

    const failure = await this.stopRuntime(
      id,
      SESSION_STOPPED,
      'session_stopped',
      dependencies.runtime,
    );
    if (failure) {
      throw new OperationFailedError(await this.viewBestEffort(id));
    }
    return this.viewFromRecord(
      this.requireCurrentRecord(id),
      await this.probeHealth(id),
    );
  }

  private requirePhaseTwo(): {
    store: SessionTabStore;
    runtime: SessionRuntimeController;
  } {
    const store = this.options.store;
    const runtime = asRuntimeController(this.options.preparer);
    if (
      store === undefined ||
      this.options.activity === undefined ||
      !runtime
    ) {
      throw new OperationFailedError();
    }
    return { store, runtime };
  }

  private requireLifecycleTab(id: string): {
    store: SessionTabStore;
    runtime: SessionRuntimeController;
  } {
    const dependencies = this.requirePhaseTwo();
    if (!isSessionId(id)) {
      throw new TabNotFoundError();
    }
    try {
      if (!dependencies.store.has(id)) throw new TabNotFoundError();
    } catch (error) {
      if (error instanceof TabNotFoundError) throw error;
      throw new OperationFailedError();
    }
    return dependencies;
  }

  private currentRecord(id: string): TabRecord | undefined {
    const store = this.options.store;
    if (store === undefined) return undefined;
    try {
      if (!store.has(id)) return undefined;
      return findRecord(store.snapshot(), id);
    } catch {
      throw new OperationFailedError();
    }
  }

  private requireCurrentRecord(id: string): TabRecord {
    const record = this.currentRecord(id);
    if (record === undefined) throw new TabNotFoundError();
    return record;
  }

  private async probeHealth(
    id: string,
    runtime = this.requirePhaseTwo().runtime,
  ): Promise<TabView['session']> {
    const bridge = this.options.registry
      .entries()
      .find((entry) => entry.sessionId === id);
    let state: TabView['session']['state'];
    try {
      state = (await runtime.exists(id)) ? 'running' : 'stopped';
    } catch {
      state = 'unknown';
    }
    return Object.freeze({
      state,
      attached: bridge !== undefined,
      bridgePid: bridge?.pid ?? null,
    });
  }

  private async viewBestEffort(id: string): Promise<TabView | undefined> {
    try {
      return this.viewFromRecord(
        this.requireCurrentRecord(id),
        await this.probeHealth(id),
      );
    } catch {
      return undefined;
    }
  }

  private viewFromRecord(
    record: TabRecord,
    session: TabView['session'],
  ): TabView {
    return Object.freeze({
      ...record,
      session: Object.freeze({ ...session }),
    });
  }

  private ensureGeneration(id: string): number {
    const current = this.generations.get(id);
    if (current !== undefined) return current;
    const generation = this.nextGeneration();
    this.generations.set(id, generation);
    return generation;
  }

  private incrementGeneration(id: string): void {
    this.generations.set(id, this.nextGeneration());
  }

  private nextGeneration(): number {
    this.generationClock += 1;
    return this.generationClock;
  }

  private isIssuedToken(value: unknown): value is AttachToken {
    return (
      typeof value === 'object' &&
      value !== null &&
      this.issuedTokens.has(value) &&
      Reflect.get(value, ATTACH_TOKEN_BRAND) === true
    );
  }

  private mark(id: string): void {
    try {
      this.options.activity?.mark(id);
    } catch {
      // Activity is best-effort and must not change lifecycle outcomes.
    }
  }

  private captureRuntimeSettings(): SessionRuntimeSettings {
    try {
      const settings = this.options.runtimeSettings?.current();
      if (!isValidRuntimeSettings(settings)) throw new Error();
      return Object.freeze({
        shell: settings.shell,
        historyLimit: settings.historyLimit,
      });
    } catch {
      throw new OperationFailedError();
    }
  }
}

function isValidRuntimeSettings(
  settings: SessionRuntimeSettings | undefined,
): settings is SessionRuntimeSettings {
  if (settings === undefined) return false;
  const { shell, historyLimit } = settings;
  return (
    typeof shell === 'string' &&
    shell.startsWith('/') &&
    shell.normalize('NFC') === shell &&
    new TextEncoder().encode(shell).byteLength <= MAX_RUNTIME_SHELL_BYTES &&
    !unsafeRuntimeShellCharacterPattern.test(shell) &&
    Number.isInteger(historyLimit) &&
    historyLimit >= 0 &&
    historyLimit <= MAX_RUNTIME_HISTORY_LIMIT
  );
}

function isValidEligibilityCapture(
  id: string,
  snapshot: EligibilitySnapshot,
): boolean {
  return (
    isSessionId(id) &&
    snapshot !== null &&
    typeof snapshot === 'object' &&
    snapshot.id === id &&
    Number.isSafeInteger(snapshot.thresholdMs) &&
    snapshot.thresholdMs >= 0 &&
    Number.isSafeInteger(snapshot.cutoffMs) &&
    typeof snapshot.eligible === 'boolean' &&
    validCleanupReason(snapshot.reason) &&
    (snapshot.eligible ? snapshot.reason === null : snapshot.reason !== null) &&
    snapshot.generation !== null &&
    typeof snapshot.generation === 'object' &&
    validGeneration(snapshot.generation.structure) &&
    validGeneration(snapshot.generation.activity) &&
    validGeneration(snapshot.generation.sockets)
  );
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCleanupReason(value: CleanupSkipReason | null): boolean {
  return (
    value === null ||
    value === 'disabled' ||
    value === 'invalid' ||
    value === 'tab_absent' ||
    value === 'inactive' ||
    value === 'session_absent' ||
    value === 'connected' ||
    value === 'bridged' ||
    value === 'activity_pending' ||
    value === 'recent_activity' ||
    value === 'invalid_timestamp' ||
    value === 'dependency_error' ||
    value === 'changed'
  );
}

function asRuntimeController(
  preparer: SessionPreparer,
): SessionRuntimeController | undefined {
  const candidate = preparer as Partial<SessionRuntimeController>;
  return typeof candidate.exists === 'function' &&
    typeof candidate.kill === 'function' &&
    typeof candidate.listActiveSessionIds === 'function' &&
    typeof candidate.attachSpec === 'function'
    ? (candidate as SessionRuntimeController)
    : undefined;
}

function findRecord(
  collection: TabCollection,
  id: string,
): TabRecord | undefined {
  return collection.tabs.find((record) => record.id === id);
}

function isValidLegacyRequest(value: unknown): value is ConnectRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ConnectRequest>;
  return (
    isSessionId(candidate.sessionId) &&
    candidate.socket !== undefined &&
    isValidDimensions(candidate.dimensions)
  );
}

function isValidDimensions(
  dimensions: TerminalDimensions | undefined,
): dimensions is TerminalDimensions {
  if (dimensions === undefined) return false;
  const { cols, rows } = dimensions;
  return (
    Number.isInteger(cols) &&
    cols >= MIN_COLS &&
    cols <= MAX_COLS &&
    Number.isInteger(rows) &&
    rows >= MIN_ROWS &&
    rows <= MAX_ROWS
  );
}

function immutableCollection(value: TabCollectionView): TabCollectionView {
  const immutable: TabCollectionView = {
    structureRevision: value.structureRevision,
    tabs: [...value.tabs],
  };
  Object.freeze(immutable.tabs);
  return Object.freeze(immutable);
}

async function ignoreFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Preserve the bounded primary operation error after best-effort cleanup.
  }
}
