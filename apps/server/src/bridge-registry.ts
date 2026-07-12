import type { BridgeOwner } from './terminal-bridge.js';

export class BridgeRegistryShuttingDownError extends Error {
  constructor() {
    super('Bridge registry is shutting down');
    this.name = 'BridgeRegistryShuttingDownError';
  }
}

export type BridgeRuntimeSnapshot = Readonly<{
  sessionId: string;
  pid: number | null;
  attached: true;
}>;

export class BridgeRegistry {
  private readonly owners = new Map<string, BridgeOwner>();
  private readonly operationQueues = new Map<string, Promise<void>>();
  private shuttingDown = false;
  private shutdownBarrier: Promise<void> = Promise.resolve();
  private shutdownResult: Promise<void> | undefined;

  get(sessionId: string): BridgeOwner | undefined {
    return this.owners.get(sessionId);
  }

  entries(): readonly BridgeRuntimeSnapshot[] {
    return Object.freeze(
      [...this.owners.entries()].map(([sessionId, owner]) =>
        Object.freeze({
          sessionId,
          pid: ownerPid(owner),
          attached: true as const,
        }),
      ),
    );
  }

  /** Takes ownership of owner and closes it before any rejected result. */
  replace(sessionId: string, owner: BridgeOwner): Promise<void> {
    if (this.shuttingDown) {
      return this.shutdownBarrier.then(async () => {
        await this.closeRejectedOwner(owner, 1001, 'server_shutdown');
        throw new BridgeRegistryShuttingDownError();
      });
    }
    return this.serialize(sessionId, async () => {
      try {
        const prior = this.owners.get(sessionId);
        if (prior !== undefined && prior !== owner) {
          await prior.close(4001, 'session_replaced');
        }
        if (this.owners.get(sessionId) === prior) {
          this.owners.set(sessionId, owner);
        }
      } catch (error) {
        await this.closeRejectedOwner(owner, 1011, 'registration_failed');
        throw error;
      }
    });
  }

  remove(sessionId: string, owner: BridgeOwner): Promise<void> {
    return this.serialize(sessionId, () => {
      if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
    });
  }

  close(
    sessionId: string,
    code = 4001,
    reason = 'session_replaced',
  ): Promise<void> {
    return this.serialize(sessionId, async () => {
      const owner = this.owners.get(sessionId);
      if (owner === undefined) return;
      await owner.close(code, reason);
      if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
    });
  }

  closeAll(): Promise<void> {
    if (this.shutdownResult !== undefined) return this.shutdownResult;
    this.shuttingDown = true;
    const inFlight = [...this.operationQueues.values()];
    const shutdown = (async () => {
      await Promise.all(inFlight);
      const entries = [...this.owners.entries()];
      const results = await Promise.allSettled(
        entries.map(async ([sessionId, owner]) => {
          try {
            await owner.close(1001, 'server_shutdown');
          } finally {
            if (this.owners.get(sessionId) === owner) {
              this.owners.delete(sessionId);
            }
          }
        }),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failure !== undefined) throw failure.reason;
    })();
    this.shutdownResult = shutdown;
    this.shutdownBarrier = shutdown.then(
      () => undefined,
      () => undefined,
    );
    return shutdown;
  }

  private serialize<T>(
    sessionId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const prior = this.operationQueues.get(sessionId) ?? Promise.resolve();
    const result = prior.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.operationQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.operationQueues.get(sessionId) === tail) {
        this.operationQueues.delete(sessionId);
      }
    });
    return result;
  }

  private async closeRejectedOwner(
    owner: BridgeOwner,
    code: number,
    reason: string,
  ): Promise<void> {
    try {
      await owner.close(code, reason);
    } catch {
      // Preserve the registry failure after best-effort owner disposal.
    }
  }
}

function ownerPid(owner: BridgeOwner): number | null {
  let value: number | null | undefined;
  try {
    value = owner.pid;
  } catch {
    return null;
  }
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}
