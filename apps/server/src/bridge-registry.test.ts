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
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', prior);

    const replacing = registry.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      next,
    );

    await vi.waitFor(() =>
      expect(prior.close).toHaveBeenCalledWith(4001, 'session_replaced'),
    );
    expect(registry.get('550e8400-e29b-41d4-a716-446655440000')).toBe(prior);
    finishClose?.();
    await replacing;
    expect(registry.get('550e8400-e29b-41d4-a716-446655440000')).toBe(next);
  });

  it('leaves other sessions untouched during replacement', async () => {
    const registry = new BridgeRegistry();
    const first = owner();
    const other = owner();
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', first);
    await registry.replace('123e4567-e89b-42d3-a456-426614174000', other);

    await registry.replace('550e8400-e29b-41d4-a716-446655440000', owner());

    expect(registry.get('123e4567-e89b-42d3-a456-426614174000')).toBe(other);
    expect(other.close).not.toHaveBeenCalled();
  });

  it('does not let a deferred replacement for one session block another', async () => {
    let finishFirstClose: (() => void) | undefined;
    const deferred = owner(
      new Promise<void>((resolve) => {
        finishFirstClose = resolve;
      }),
    );
    const registry = new BridgeRegistry();
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', deferred);
    const secondPrior = owner();
    await registry.replace('123e4567-e89b-42d3-a456-426614174000', secondPrior);

    const firstReplacement = registry.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      owner(),
    );
    const secondReplacement = registry.replace(
      '123e4567-e89b-42d3-a456-426614174000',
      owner(),
    );
    await vi.waitFor(() => expect(deferred.close).toHaveBeenCalledOnce());

    await expect(secondReplacement).resolves.toBeUndefined();
    expect(secondPrior.close).toHaveBeenCalledOnce();

    const secondClose = registry.close('123e4567-e89b-42d3-a456-426614174000');
    await expect(secondClose).resolves.toBeUndefined();
    finishFirstClose?.();
    await firstReplacement;
  });

  it('removes only when identity matches the current owner', async () => {
    const registry = new BridgeRegistry();
    const current = owner();
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', current);

    await registry.remove('550e8400-e29b-41d4-a716-446655440000', owner());
    expect(registry.get('550e8400-e29b-41d4-a716-446655440000')).toBe(current);
    await registry.remove('550e8400-e29b-41d4-a716-446655440000', current);
    expect(
      registry.get('550e8400-e29b-41d4-a716-446655440000'),
    ).toBeUndefined();
  });

  it('closes one owner and all remaining owners', async () => {
    const registry = new BridgeRegistry();
    const first = owner();
    const second = owner();
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', first);
    await registry.replace('123e4567-e89b-42d3-a456-426614174000', second);

    await registry.close('550e8400-e29b-41d4-a716-446655440000');
    await registry.closeAll();

    expect(first.close).toHaveBeenCalledWith(4001, 'session_replaced');
    expect(second.close).toHaveBeenCalledWith(1001, 'server_shutdown');
    expect(
      registry.get('550e8400-e29b-41d4-a716-446655440000'),
    ).toBeUndefined();
    expect(
      registry.get('123e4567-e89b-42d3-a456-426614174000'),
    ).toBeUndefined();
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
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', prior);

    const firstReplacement = registry.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      first,
    );
    const secondReplacement = registry.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      second,
    );
    await vi.waitFor(() => expect(prior.close).toHaveBeenCalledOnce());

    expect(registry.get('550e8400-e29b-41d4-a716-446655440000')).toBe(prior);
    finishPriorClose?.();
    await Promise.all([firstReplacement, secondReplacement]);

    expect(prior.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledWith(4001, 'session_replaced');
    expect(second.close).not.toHaveBeenCalled();
    expect(registry.get('550e8400-e29b-41d4-a716-446655440000')).toBe(second);
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
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', prior);

    const replacing = registry.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      replacement,
    );
    const closing = registry.closeAll();
    await vi.waitFor(() => expect(prior.close).toHaveBeenCalledOnce());
    finishPriorClose?.();
    await Promise.all([replacing, closing]);

    expect(prior.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledWith(1001, 'server_shutdown');
    expect(
      registry.get('550e8400-e29b-41d4-a716-446655440000'),
    ).toBeUndefined();
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
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', prior);

    const failed = registry.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      rejected,
    );
    const retry = registry.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      recovered,
    );

    await expect(failed).rejects.toThrow('close failed');
    await expect(retry).resolves.toBeUndefined();
    expect(prior.close).toHaveBeenCalledTimes(2);
    expect(rejected.close).toHaveBeenCalledOnce();
    expect(rejected.close).toHaveBeenCalledWith(1011, 'registration_failed');
    expect(registry.get('550e8400-e29b-41d4-a716-446655440000')).toBe(
      recovered,
    );
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
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', current);

    const closing = registry.closeAll();
    const replacing = registry.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      replacement,
    );
    await vi.waitFor(() => expect(current.close).toHaveBeenCalledOnce());

    expect(replacement.close).not.toHaveBeenCalled();
    finishClose?.();
    await expect(closing).resolves.toBeUndefined();
    await expect(replacing).rejects.toThrow('Bridge registry is shutting down');

    expect(current.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(replacement.close).toHaveBeenCalledWith(1001, 'server_shutdown');
    expect(
      registry.get('550e8400-e29b-41d4-a716-446655440000'),
    ).toBeUndefined();
  });

  it('disposes a post-seal replacement even when shutdown owner close fails', async () => {
    const registry = new BridgeRegistry();
    const failed: BridgeOwner = {
      pid: null,
      close: vi.fn(async () => {
        throw new Error('close failed');
      }),
    };
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', failed);
    const rejected = owner();

    const closing = registry.closeAll();
    const replacing = registry.replace(
      '123e4567-e89b-42d3-a456-426614174000',
      rejected,
    );

    await expect(closing).rejects.toThrow('close failed');
    await expect(replacing).rejects.toThrow('Bridge registry is shutting down');
    expect(rejected.close).toHaveBeenCalledWith(1001, 'server_shutdown');
  });

  it('seals close and remove behind an in-progress shutdown', async () => {
    let finishShutdownClose: (() => void) | undefined;
    const current = owner(
      new Promise<void>((resolve) => {
        finishShutdownClose = resolve;
      }),
    );
    const registry = new BridgeRegistry();
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', current);

    const closingAll = registry.closeAll();
    await vi.waitFor(() => expect(current.close).toHaveBeenCalledOnce());
    let closeFinished = false;
    let removeFinished = false;
    const closingOne = registry
      .close('550e8400-e29b-41d4-a716-446655440000')
      .then(() => {
        closeFinished = true;
      });
    const removing = registry
      .remove('550e8400-e29b-41d4-a716-446655440000', current)
      .then(() => {
        removeFinished = true;
      });

    await Promise.resolve();
    expect(current.close).toHaveBeenCalledOnce();
    expect(registry.get('550e8400-e29b-41d4-a716-446655440000')).toBe(current);
    expect(closeFinished).toBe(false);
    expect(removeFinished).toBe(false);

    finishShutdownClose?.();
    await Promise.all([closingAll, closingOne, removing]);

    expect(current.close).toHaveBeenCalledOnce();
    expect(
      registry.get('550e8400-e29b-41d4-a716-446655440000'),
    ).toBeUndefined();
    expect(closeFinished).toBe(true);
    expect(removeFinished).toBe(true);
  });

  it('returns an immutable runtime snapshot containing only session health', async () => {
    const registry = new BridgeRegistry();
    const attached = owner(undefined, 4321);
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', attached);

    const snapshot = registry.entries();

    expect(snapshot).toEqual([
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        pid: 4321,
        attached: true,
      },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('close');
  });

  it('bounds invalid or throwing owner pid values to null in snapshots', async () => {
    const registry = new BridgeRegistry();
    const unsafe: BridgeOwner = {
      get pid(): number | null {
        throw new Error('process-secret');
      },
      close: vi.fn(async () => undefined),
    };
    await registry.replace('550e8400-e29b-41d4-a716-446655440000', unsafe);

    expect(registry.entries()).toEqual([
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        pid: null,
        attached: true,
      },
    ]);
  });
});

function owner(
  result: Promise<void> | undefined = Promise.resolve(),
  pid: number | null = null,
): BridgeOwner {
  return { pid, close: vi.fn(() => result ?? Promise.resolve()) };
}
