import type { BridgeOwner } from './terminal-bridge.js';

export class BridgeRegistryShuttingDownError extends Error {
  constructor() {
    super('Bridge registry is shutting down');
    this.name = 'BridgeRegistryShuttingDownError';
  }
}

export class BridgeRegistry {
  private readonly owners = new Map<string, BridgeOwner>();
  private operationQueue: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  get(sessionId: string): BridgeOwner | undefined {
    return this.owners.get(sessionId);
  }

  /** Takes ownership of owner and closes it before any rejected result. */
  replace(sessionId: string, owner: BridgeOwner): Promise<void> {
    if (this.shuttingDown) {
      return this.serialize(async () => {
        await this.closeRejectedOwner(owner, 1001, 'server_shutdown');
        throw new BridgeRegistryShuttingDownError();
      });
    }
    return this.serialize(async () => {
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
    return this.serialize(() => {
      if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
    });
  }

  close(
    sessionId: string,
    code = 4001,
    reason = 'session_replaced',
  ): Promise<void> {
    return this.serialize(async () => {
      const owner = this.owners.get(sessionId);
      if (owner === undefined) return;
      await owner.close(code, reason);
      if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
    });
  }

  closeAll(): Promise<void> {
    this.shuttingDown = true;
    return this.serialize(async () => {
      const entries = [...this.owners.entries()];
      await Promise.all(
        entries.map(async ([sessionId, owner]) => {
          await owner.close(1001, 'server_shutdown');
          if (this.owners.get(sessionId) === owner) {
            this.owners.delete(sessionId);
          }
        }),
      );
    });
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
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
