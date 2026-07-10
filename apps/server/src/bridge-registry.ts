import type { BridgeOwner } from './terminal-bridge.js';

export class BridgeRegistry {
  private readonly owners = new Map<string, BridgeOwner>();

  get(sessionId: string): BridgeOwner | undefined {
    return this.owners.get(sessionId);
  }

  async replace(sessionId: string, owner: BridgeOwner): Promise<void> {
    const prior = this.owners.get(sessionId);
    if (prior !== undefined && prior !== owner) {
      await prior.close(4001, 'session_replaced');
    }
    if (this.owners.get(sessionId) === prior) this.owners.set(sessionId, owner);
  }

  remove(sessionId: string, owner: BridgeOwner): void {
    if (this.owners.get(sessionId) === owner) this.owners.delete(sessionId);
  }

  async close(
    sessionId: string,
    code = 4001,
    reason = 'session_replaced',
  ): Promise<void> {
    const owner = this.owners.get(sessionId);
    if (owner === undefined) return;
    await owner.close(code, reason);
    this.remove(sessionId, owner);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.owners.entries()];
    await Promise.all(
      entries.map(async ([sessionId, owner]) => {
        await owner.close(1001, 'server_shutdown');
        this.remove(sessionId, owner);
      }),
    );
  }
}
