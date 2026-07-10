import {
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  isSessionId,
} from '@flanterminal/shared';

import type { BridgeRegistry } from './bridge-registry.js';
import type { LifecycleLogger } from './logger.js';
import type { PtyFactory, PtyProcess, TerminalDimensions } from './pty.js';
import {
  TerminalBridge,
  type BridgeOwner,
  type SocketPort,
} from './terminal-bridge.js';
import type { SessionPreparer } from './tmux.js';

export type ManagedBridgeOptions = Readonly<{
  sessionId: string;
  socket: SocketPort;
  pty: PtyProcess;
}>;

export interface ManagedBridgeFactory {
  create(options: ManagedBridgeOptions): BridgeOwner;
}

export class TerminalBridgeFactory implements ManagedBridgeFactory {
  constructor(
    private readonly logger: LifecycleLogger,
    private readonly maxBufferedBytes: number,
  ) {}

  create(options: ManagedBridgeOptions): BridgeOwner {
    return new TerminalBridge({
      ...options,
      logger: this.logger,
      maxBufferedBytes: this.maxBufferedBytes,
    });
  }
}

export type ConnectRequest = Readonly<{
  sessionId: string;
  socket: SocketPort;
  dimensions: TerminalDimensions;
}>;

export type SessionManagerOptions = Readonly<{
  preparer: SessionPreparer;
  ptyFactory: PtyFactory;
  registry: BridgeRegistry;
  bridgeFactory: ManagedBridgeFactory;
}>;

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

  constructor(private readonly options: SessionManagerOptions) {}

  async connect(request: ConnectRequest): Promise<BridgeOwner> {
    if (!isValidRequest(request)) {
      throw new Error('Invalid terminal connection');
    }

    return this.mutex.runExclusive(request.sessionId, async () => {
      const spec = await this.options.preparer.prepare(request.sessionId);

      await this.options.registry.close(request.sessionId);
      const pty = this.options.ptyFactory.spawn(spec, request.dimensions);
      let bridge: BridgeOwner;
      try {
        bridge = this.options.bridgeFactory.create({
          sessionId: request.sessionId,
          socket: request.socket,
          pty,
        });
      } catch (error) {
        try {
          pty.kill();
        } catch {
          // Preserve the bridge-construction failure.
        }
        throw error;
      }
      try {
        await this.options.registry.replace(request.sessionId, bridge);
      } catch (error) {
        try {
          await bridge.close(1011, 'registration_failed');
        } catch {
          // Preserve the registration failure after best-effort rollback.
        } finally {
          this.options.registry.remove(request.sessionId, bridge);
        }
        throw error;
      }
      return bridge;
    });
  }
}

function isValidRequest(request: ConnectRequest): boolean {
  const { cols, rows } = request.dimensions;
  return (
    isSessionId(request.sessionId) &&
    Number.isInteger(cols) &&
    cols >= MIN_COLS &&
    cols <= MAX_COLS &&
    Number.isInteger(rows) &&
    rows >= MIN_ROWS &&
    rows <= MAX_ROWS
  );
}
