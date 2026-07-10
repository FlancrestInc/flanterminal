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

  replace(sessionId: string, owner: BridgeOwner): Promise<void> {
    if (this.shuttingDown) {
      return this.serialize(async () => {
        try {
          await owner.close(1001, 'server_shutdown');
        } catch {
          // Reject with a stable lifecycle error after best-effort disposal.
        }
        throw new BridgeRegistryShuttingDownError();
      });
    }
    return this.serialize(async () => {
      const prior = this.owners.get(sessionId);
      if (prior !== undefined && prior !== owner) {
        await prior.close(4001, 'session_replaced');
      }
      if (this.owners.get(sessionId) === prior) {
        this.owners.set(sessionId, owner);
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
}
