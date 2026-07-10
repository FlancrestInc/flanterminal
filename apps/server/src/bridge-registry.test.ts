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

    await vi.waitFor(() =>
      expect(prior.close).toHaveBeenCalledWith(4001, 'session_replaced'),
    );
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

    await registry.remove('session-a', owner());
    expect(registry.get('session-a')).toBe(current);
    await registry.remove('session-a', current);
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

  it('serializes concurrent replacements without leaking an owner', async () => {
    let finishPriorClose: (() => void) | undefined;
    const prior = owner(
      new Promise<void>((resolve) => {
        finishPriorClose = resolve;
      }),
    );
    const first = owner();
    const second = owner();
    const registry = new BridgeRegistry();
    await registry.replace('session-a', prior);

    const firstReplacement = registry.replace('session-a', first);
    const secondReplacement = registry.replace('session-a', second);
    await vi.waitFor(() => expect(prior.close).toHaveBeenCalledOnce());

    expect(registry.get('session-a')).toBe(prior);
    finishPriorClose?.();
    await Promise.all([firstReplacement, secondReplacement]);

    expect(prior.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledWith(4001, 'session_replaced');
    expect(second.close).not.toHaveBeenCalled();
    expect(registry.get('session-a')).toBe(second);
  });

  it('serializes closeAll behind an in-flight replacement', async () => {
    let finishPriorClose: (() => void) | undefined;
    const prior = owner(
      new Promise<void>((resolve) => {
        finishPriorClose = resolve;
      }),
    );
    const replacement = owner();
    const registry = new BridgeRegistry();
    await registry.replace('session-a', prior);

    const replacing = registry.replace('session-a', replacement);
    const closing = registry.closeAll();
    await vi.waitFor(() => expect(prior.close).toHaveBeenCalledOnce());
    finishPriorClose?.();
    await Promise.all([replacing, closing]);

    expect(prior.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledWith(1001, 'server_shutdown');
    expect(registry.get('session-a')).toBeUndefined();
  });

  it('releases its operation queue after a replacement rejection', async () => {
    const prior: BridgeOwner = {
      close: vi
        .fn<BridgeOwner['close']>()
        .mockRejectedValueOnce(new Error('close failed'))
        .mockResolvedValueOnce(),
    };
    const rejected = owner();
    const recovered = owner();
    const registry = new BridgeRegistry();
    await registry.replace('session-a', prior);

    const failed = registry.replace('session-a', rejected);
    const retry = registry.replace('session-a', recovered);

    await expect(failed).rejects.toThrow('close failed');
    await expect(retry).resolves.toBeUndefined();
    expect(prior.close).toHaveBeenCalledTimes(2);
    expect(rejected.close).toHaveBeenCalledOnce();
    expect(rejected.close).toHaveBeenCalledWith(1011, 'registration_failed');
    expect(registry.get('session-a')).toBe(recovered);
  });

  it('seals synchronously when closeAll races a later replacement', async () => {
    let finishClose: (() => void) | undefined;
    const current = owner(
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
    );
    const replacement = owner();
    const registry = new BridgeRegistry();
    await registry.replace('session-a', current);

    const closing = registry.closeAll();
    const replacing = registry.replace('session-a', replacement);
    await vi.waitFor(() => expect(current.close).toHaveBeenCalledOnce());

    expect(replacement.close).not.toHaveBeenCalled();
    finishClose?.();
    await expect(closing).resolves.toBeUndefined();
    await expect(replacing).rejects.toThrow('Bridge registry is shutting down');

    expect(current.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledWith(1001, 'server_shutdown');
    expect(registry.get('session-a')).toBeUndefined();
  });
});

function owner(result: Promise<void> = Promise.resolve()): BridgeOwner {
  return { close: vi.fn(() => result) };
}
