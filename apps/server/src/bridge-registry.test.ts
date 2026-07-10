import { describe, expect, it, vi } from 'vitest';

import { BridgeRegistry } from './bridge-registry.js';
import type { BridgeOwner } from './terminal-bridge.js';

describe('BridgeRegistry', () => {
  it('fully disposes a prior owner before publishing its replacement', async () => {
    let finishClose: (() => void) | undefined;
    const prior = owner(
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
    );
    const next = owner();
    const registry = new BridgeRegistry();
    await registry.replace('session-a', prior);

    const replacing = registry.replace('session-a', next);

    expect(prior.close).toHaveBeenCalledWith(4001, 'session_replaced');
    expect(registry.get('session-a')).toBe(prior);
    finishClose?.();
    await replacing;
    expect(registry.get('session-a')).toBe(next);
  });

  it('leaves other sessions untouched during replacement', async () => {
    const registry = new BridgeRegistry();
    const first = owner();
    const other = owner();
    await registry.replace('session-a', first);
    await registry.replace('session-b', other);

    await registry.replace('session-a', owner());

    expect(registry.get('session-b')).toBe(other);
    expect(other.close).not.toHaveBeenCalled();
  });

  it('removes only when identity matches the current owner', async () => {
    const registry = new BridgeRegistry();
    const current = owner();
    await registry.replace('session-a', current);

    registry.remove('session-a', owner());
    expect(registry.get('session-a')).toBe(current);
    registry.remove('session-a', current);
    expect(registry.get('session-a')).toBeUndefined();
  });

  it('closes one owner and all remaining owners', async () => {
    const registry = new BridgeRegistry();
    const first = owner();
    const second = owner();
    await registry.replace('session-a', first);
    await registry.replace('session-b', second);

    await registry.close('session-a');
    await registry.closeAll();

    expect(first.close).toHaveBeenCalledWith(4001, 'session_replaced');
    expect(second.close).toHaveBeenCalledWith(1001, 'server_shutdown');
    expect(registry.get('session-a')).toBeUndefined();
    expect(registry.get('session-b')).toBeUndefined();
  });
});

function owner(result: Promise<void> = Promise.resolve()): BridgeOwner {
  return { close: vi.fn(() => result) };
}
