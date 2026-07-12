import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_RESTART,
  SESSION_RESTARTING,
  SESSION_STOPPED,
  type DesiredState,
  type TabCollection,
  type TabRecord,
} from '@flanterminal/shared';

import { BridgeRegistry } from './bridge-registry.js';
import type { PtyFactory, PtyProcess } from './pty.js';
import {
  InvalidConnectionError,
  InvalidSessionStateError,
  OperationFailedError,
  SessionManager,
  StaleAttachError,
  TabNotFoundError,
  TerminalBridgeFactory,
  type ManagedBridgeFactory,
  type SessionRuntimeController,
  type SessionTabStore,
} from './session-manager.js';
import type { BridgeOwner, SocketPort } from './terminal-bridge.js';
import type { AttachSpec } from './tmux.js';

const TAB_A = '11111111-1111-4111-8111-111111111111';
const TAB_B = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_TAB = '33333333-3333-4333-8333-333333333333';

const attachSpec: AttachSpec = Object.freeze({
  executable: '/usr/bin/tmux',
  args: Object.freeze(['attach-session', '-t', 'webterm-tab-a']),
  cwd: '/home/webterm',
  env: Object.freeze({
    HOME: '/home/webterm',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
  }),
});

describe('SessionManager Phase 2 lifecycle', () => {
  it('authorizes only canonical active existing tabs with an immutable token', () => {
    const harness = createHarness();
    harness.store.records.get(TAB_B)!.desiredState = 'stopped';

    const token = harness.manager.authorize(TAB_A);

    expect(token).toBeDefined();
    expect(Object.isFrozen(token)).toBe(true);
    expect(harness.manager.authorize(TAB_B)).toBeUndefined();
    expect(harness.manager.authorize(UNKNOWN_TAB)).toBeUndefined();
    expect(harness.manager.authorize('not-a-uuid')).toBeUndefined();
    expect(harness.activity.mark).not.toHaveBeenCalled();
  });

  it('validates dimensions and tokens before tmux, bridge, PTY, or activity side effects', async () => {
    const harness = createHarness();
    const token = harness.manager.authorize(TAB_A)!;

    await expect(
      harness.manager.connect(token, fakeSocket(), { cols: 1, rows: 24 }),
    ).rejects.toBeInstanceOf(InvalidConnectionError);
    await expect(
      harness.manager.connect(Object.freeze({}) as never, fakeSocket(), {
        cols: 80,
        rows: 24,
      }),
    ).rejects.toBeInstanceOf(StaleAttachError);

    expect(harness.tmux.prepare).not.toHaveBeenCalled();
    expect(harness.ptyFactory.spawn).not.toHaveBeenCalled();
    expect(harness.activity.mark).not.toHaveBeenCalled();
  });

  it('revalidates a token under the keyed lock and marks only a successful attach', async () => {
    const harness = createHarness();
    const token = harness.manager.authorize(TAB_A)!;
    const bridge = await harness.manager.connect(token, fakeSocket(), {
      cols: 80,
      rows: 24,
    });

    expect(harness.tmux.prepare).toHaveBeenCalledWith(TAB_A);
    expect(harness.ptyFactory.spawn).toHaveBeenCalledWith(attachSpec, {
      cols: 80,
      rows: 24,
    });
    expect(harness.registry.get(TAB_A)).toBe(bridge);
    expect(harness.activity.mark).toHaveBeenCalledTimes(1);
    expect(harness.activity.mark).toHaveBeenCalledWith(TAB_A);
  });

  it('serializes same-ID attaches and fully closes the prior owner before spawning', async () => {
    const closeGate = deferred<void>();
    const prior = owner(closeGate.promise);
    const harness = createHarness();
    await harness.registry.replace(TAB_A, prior);
    const token = harness.manager.authorize(TAB_A)!;

    const first = harness.manager.connect(token, fakeSocket(), {
      cols: 80,
      rows: 24,
    });
    const second = harness.manager.connect(token, fakeSocket(), {
      cols: 80,
      rows: 24,
    });

    await vi.waitFor(() => expect(prior.close).toHaveBeenCalledOnce());
    expect(harness.ptyFactory.spawn).not.toHaveBeenCalled();
    closeGate.resolve();
    const [firstBridge, secondBridge] = await Promise.all([first, second]);
    expect(firstBridge.close).toHaveBeenCalledWith(4001, 'session_replaced');
    expect(harness.registry.get(TAB_A)).toBe(secondBridge);
    expect(harness.ptyFactory.spawn).toHaveBeenCalledTimes(2);
  });

  it('allows another ID to attach and complete lifecycle work while ID A is locked', async () => {
    const prepareGate = deferred<AttachSpec>();
    const harness = createHarness();
    vi.mocked(harness.tmux.prepare).mockImplementation(async (id) =>
      id === TAB_A ? prepareGate.promise : attachSpec,
    );

    const blockedA = harness.manager.connect(
      harness.manager.authorize(TAB_A)!,
      fakeSocket(),
      { cols: 80, rows: 24 },
    );
    await vi.waitFor(() =>
      expect(harness.tmux.prepare).toHaveBeenCalledWith(TAB_A),
    );

    await harness.manager.connect(
      harness.manager.authorize(TAB_B)!,
      fakeSocket(),
      { cols: 80, rows: 24 },
    );
    await harness.manager.restartBridge(TAB_B);
    expect(harness.registry.get(TAB_B)).toBeUndefined();
    expect(harness.activity.mark).toHaveBeenCalledWith(TAB_B);
    expect(harness.ptyFactory.spawn).toHaveBeenCalledOnce();

    prepareGate.resolve(attachSpec);
    await blockedA;
  });

  it('invalidates tokens before terminate persistence and touches nothing if persistence fails', async () => {
    const harness = createHarness();
    const oldToken = harness.manager.authorize(TAB_A)!;
    vi.mocked(harness.store.setDesiredState).mockRejectedValueOnce(
      new Error('secret persistence path'),
    );

    await expect(harness.manager.terminate(TAB_A)).rejects.toMatchObject({
      code: 'operation_failed',
      message: 'Session operation failed',
    });
    expect(harness.registry.close).not.toHaveBeenCalled();
    expect(harness.tmux.kill).not.toHaveBeenCalled();
    expect(harness.activity.mark).not.toHaveBeenCalled();
    await expect(
      harness.manager.connect(oldToken, fakeSocket(), { cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(StaleAttachError);
  });

  it('persists stopped before closing 4011 and killing, then returns a fresh immutable view', async () => {
    const harness = createHarness();
    const order: string[] = [];
    vi.mocked(harness.store.setDesiredState).mockImplementation(
      async (id, state) => {
        order.push(`persist:${state}`);
        return harness.store.applyState(id, state);
      },
    );
    vi.spyOn(harness.registry, 'close').mockImplementation(async () => {
      order.push('close');
    });
    vi.mocked(harness.tmux.kill).mockImplementation(async () => {
      order.push('kill');
      harness.tmux.active.delete(TAB_A);
    });

    const view = await harness.manager.terminate(TAB_A);

    expect(order).toEqual(['persist:stopped', 'close', 'kill']);
    expect(harness.registry.close).toHaveBeenCalledWith(
      TAB_A,
      SESSION_STOPPED,
      'session_stopped',
    );
    expect(view.desiredState).toBe('stopped');
    expect(view.session).toEqual({
      state: 'stopped',
      attached: false,
      bridgePid: null,
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.session)).toBe(true);
    expect(harness.activity.mark).toHaveBeenCalledWith(TAB_A);
  });

  it('rejects tokens captured before and during terminate and authorizes none after', async () => {
    const harness = createHarness();
    const before = harness.manager.authorize(TAB_A)!;
    const persistGate = deferred<TabRecord>();
    vi.mocked(harness.store.setDesiredState).mockReturnValueOnce(
      persistGate.promise,
    );

    const terminating = harness.manager.terminate(TAB_A);
    await vi.waitFor(() =>
      expect(harness.store.setDesiredState).toHaveBeenCalledWith(
        TAB_A,
        'stopped',
      ),
    );
    const during = harness.manager.authorize(TAB_A)!;
    expect(during).toBeDefined();
    persistGate.resolve(harness.store.applyState(TAB_A, 'stopped'));
    await terminating;

    for (const token of [before, during]) {
      await expect(
        harness.manager.connect(token, fakeSocket(), { cols: 80, rows: 24 }),
      ).rejects.toBeInstanceOf(StaleAttachError);
    }
    expect(harness.manager.authorize(TAB_A)).toBeUndefined();
  });

  it('recreate requires stopped intent and a fresh absent probe', async () => {
    const harness = createHarness();

    await expect(harness.manager.recreate(TAB_A)).rejects.toBeInstanceOf(
      InvalidSessionStateError,
    );
    harness.store.applyState(TAB_A, 'stopped');
    harness.tmux.active.add(TAB_A);
    await expect(harness.manager.recreate(TAB_A)).rejects.toMatchObject({
      code: 'invalid_session_state',
      message: 'Invalid session state',
    });
    expect(harness.tmux.prepare).not.toHaveBeenCalled();
    expect(harness.activity.mark).not.toHaveBeenCalled();
  });

  it('recreate invalidates tokens captured before and during creation, then activates', async () => {
    const harness = createHarness();
    harness.store.applyState(TAB_A, 'stopped');
    harness.tmux.active.delete(TAB_A);
    const before = harness.manager.authorize(TAB_A);
    expect(before).toBeUndefined();
    const prepareGate = deferred<AttachSpec>();
    vi.mocked(harness.tmux.prepare).mockReturnValueOnce(prepareGate.promise);

    const recreating = harness.manager.recreate(TAB_A);
    await vi.waitFor(() => expect(harness.tmux.prepare).toHaveBeenCalledOnce());
    const during = harness.manager.authorize(TAB_A);
    expect(during).toBeUndefined();
    prepareGate.resolve(attachSpec);
    await recreating;

    const after = harness.manager.authorize(TAB_A)!;
    await harness.manager.connect(after, fakeSocket(), { cols: 80, rows: 24 });
    expect(harness.store.records.get(TAB_A)?.desiredState).toBe('active');
    expect(harness.activity.mark).toHaveBeenCalledWith(TAB_A);
  });

  it('uses the final recreate generation change to invalidate a token captured after active commit', async () => {
    const harness = createHarness();
    harness.store.applyState(TAB_A, 'stopped');
    harness.tmux.active.delete(TAB_A);
    const activeCommitGate = deferred<TabRecord>();
    vi.mocked(harness.store.setDesiredState).mockImplementationOnce(
      async (id, state) => {
        const committed = harness.store.applyState(id, state);
        return activeCommitGate.promise.then(() => committed);
      },
    );

    const recreating = harness.manager.recreate(TAB_A);
    await vi.waitFor(() =>
      expect(harness.store.setDesiredState).toHaveBeenCalledWith(
        TAB_A,
        'active',
      ),
    );
    const midCommit = harness.manager.authorize(TAB_A)!;
    expect(midCommit).toBeDefined();
    activeCommitGate.resolve(harness.store.records.get(TAB_A)!);
    await recreating;

    await expect(
      harness.manager.connect(midCommit, fakeSocket(), { cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(StaleAttachError);
    await expect(
      harness.manager.connect(harness.manager.authorize(TAB_A)!, fakeSocket(), {
        cols: 80,
        rows: 24,
      }),
    ).resolves.toBeDefined();
  });

  it('kills a recreated tmux session best-effort when active persistence fails', async () => {
    const harness = createHarness();
    harness.store.applyState(TAB_A, 'stopped');
    harness.tmux.active.delete(TAB_A);
    vi.mocked(harness.store.setDesiredState).mockRejectedValueOnce(
      new Error('write details'),
    );

    await expect(harness.manager.recreate(TAB_A)).rejects.toBeInstanceOf(
      OperationFailedError,
    );
    expect(harness.tmux.kill).toHaveBeenCalledWith(TAB_A);
    expect(harness.store.records.get(TAB_A)?.desiredState).toBe('stopped');
    expect(harness.manager.authorize(TAB_A)).toBeUndefined();
    expect(harness.activity.mark).not.toHaveBeenCalled();
  });

  it('restart orders stopped, close 4012, kill, prepare, active and invalidates the old token', async () => {
    const harness = createHarness();
    const token = harness.manager.authorize(TAB_A)!;
    const order: string[] = [];
    vi.mocked(harness.store.setDesiredState).mockImplementation(
      async (id, state) => {
        order.push(`persist:${state}`);
        return harness.store.applyState(id, state);
      },
    );
    vi.spyOn(harness.registry, 'close').mockImplementation(async () => {
      order.push('close');
    });
    vi.mocked(harness.tmux.kill).mockImplementation(async () => {
      order.push('kill');
    });
    vi.mocked(harness.tmux.prepare).mockImplementation(async () => {
      order.push('prepare');
      return attachSpec;
    });

    const view = await harness.manager.restart(TAB_A);

    expect(order).toEqual([
      'persist:stopped',
      'close',
      'kill',
      'prepare',
      'persist:active',
    ]);
    expect(harness.registry.close).toHaveBeenCalledWith(
      TAB_A,
      SESSION_RESTARTING,
      'session_restarting',
    );
    expect(view.desiredState).toBe('active');
    expect(harness.activity.mark).toHaveBeenCalledWith(TAB_A);
    await expect(
      harness.manager.connect(token, fakeSocket(), { cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(StaleAttachError);
  });

  it('leaves restart stopped and kills the fresh tmux when active persistence fails', async () => {
    const harness = createHarness();
    vi.mocked(harness.store.setDesiredState)
      .mockImplementationOnce(async (id, state) =>
        harness.store.applyState(id, state),
      )
      .mockRejectedValueOnce(new Error('private store output'));

    await expect(harness.manager.restart(TAB_A)).rejects.toMatchObject({
      code: 'operation_failed',
      message: 'Session operation failed',
    });
    expect(harness.tmux.kill).toHaveBeenCalledTimes(2);
    expect(harness.store.records.get(TAB_A)?.desiredState).toBe('stopped');
    expect(harness.manager.authorize(TAB_A)).toBeUndefined();
  });

  it('rejects restart tokens from before and during the operation, then accepts only a fresh token', async () => {
    const harness = createHarness();
    const before = harness.manager.authorize(TAB_A)!;
    const prepareGate = deferred<AttachSpec>();
    vi.mocked(harness.tmux.prepare).mockReturnValueOnce(prepareGate.promise);

    const restarting = harness.manager.restart(TAB_A);
    await vi.waitFor(() => expect(harness.tmux.prepare).toHaveBeenCalledOnce());
    expect(harness.manager.authorize(TAB_A)).toBeUndefined();
    prepareGate.resolve(attachSpec);
    await restarting;

    await expect(
      harness.manager.connect(before, fakeSocket(), { cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(StaleAttachError);
    const after = harness.manager.authorize(TAB_A)!;
    await expect(
      harness.manager.connect(after, fakeSocket(), { cols: 80, rows: 24 }),
    ).resolves.toBeDefined();
  });

  it('restartBridge changes only the bridge and marks the ID', async () => {
    const harness = createHarness();
    const view = await harness.manager.restartBridge(TAB_A);

    expect(harness.registry.close).toHaveBeenCalledWith(
      TAB_A,
      BRIDGE_RESTART,
      'bridge_restart',
    );
    expect(harness.tmux.kill).not.toHaveBeenCalled();
    expect(harness.store.setDesiredState).not.toHaveBeenCalled();
    expect(view.desiredState).toBe('active');
    expect(harness.activity.mark).toHaveBeenCalledWith(TAB_A);
  });

  it('closeTab persists stopped, closes, kills, removes under one lock and stales tokens', async () => {
    const harness = createHarness();
    const token = harness.manager.authorize(TAB_A)!;
    const order: string[] = [];
    vi.mocked(harness.store.setDesiredState).mockImplementation(
      async (id, state) => {
        order.push(`persist:${state}`);
        return harness.store.applyState(id, state);
      },
    );
    vi.spyOn(harness.registry, 'close').mockImplementation(async () => {
      order.push('close');
    });
    vi.mocked(harness.tmux.kill).mockImplementation(async () => {
      order.push('kill');
    });
    vi.mocked(harness.store.remove).mockImplementation(async (id) => {
      order.push('remove');
      harness.store.records.delete(id);
    });

    await harness.manager.closeTab(TAB_A);

    expect(order).toEqual(['persist:stopped', 'close', 'kill', 'remove']);
    expect(harness.activity.mark).toHaveBeenCalledWith(TAB_A);
    await expect(
      harness.manager.connect(token, fakeSocket(), { cols: 80, rows: 24 }),
    ).rejects.toBeInstanceOf(StaleAttachError);
  });

  it('close persistence failure aborts bridge/tmux and does not mark activity', async () => {
    const harness = createHarness();
    vi.mocked(harness.store.setDesiredState).mockRejectedValueOnce(
      new Error('persistence detail'),
    );

    await expect(harness.manager.closeTab(TAB_A)).rejects.toBeInstanceOf(
      OperationFailedError,
    );
    expect(harness.registry.close).not.toHaveBeenCalled();
    expect(harness.tmux.kill).not.toHaveBeenCalled();
    expect(harness.store.remove).not.toHaveBeenCalled();
    expect(harness.activity.mark).not.toHaveBeenCalled();
  });

  it('rejects tokens captured before and during close and removes later authorization', async () => {
    const harness = createHarness();
    const before = harness.manager.authorize(TAB_A)!;
    const persistGate = deferred<TabRecord>();
    vi.mocked(harness.store.setDesiredState).mockReturnValueOnce(
      persistGate.promise,
    );

    const closing = harness.manager.closeTab(TAB_A);
    await vi.waitFor(() =>
      expect(harness.store.setDesiredState).toHaveBeenCalledOnce(),
    );
    const during = harness.manager.authorize(TAB_A)!;
    persistGate.resolve(harness.store.applyState(TAB_A, 'stopped'));
    await closing;

    for (const token of [before, during]) {
      await expect(
        harness.manager.connect(token, fakeSocket(), { cols: 80, rows: 24 }),
      ).rejects.toBeInstanceOf(StaleAttachError);
    }
    expect(harness.manager.authorize(TAB_A)).toBeUndefined();
  });

  it('marks a close attempt after stopped intent commits even when later cleanup fails', async () => {
    const harness = createHarness();
    vi.mocked(harness.tmux.kill).mockRejectedValueOnce(
      new Error('tmux output'),
    );

    await expect(harness.manager.closeTab(TAB_A)).rejects.toBeInstanceOf(
      OperationFailedError,
    );
    expect(harness.store.records.get(TAB_A)?.desiredState).toBe('stopped');
    expect(harness.store.remove).not.toHaveBeenCalled();
    expect(harness.activity.mark).toHaveBeenCalledWith(TAB_A);
  });

  it('returns tab-not-found errors without touching dependencies', async () => {
    const harness = createHarness();

    for (const operation of [
      () => harness.manager.terminate(UNKNOWN_TAB),
      () => harness.manager.recreate(UNKNOWN_TAB),
      () => harness.manager.restart(UNKNOWN_TAB),
      () => harness.manager.restartBridge(UNKNOWN_TAB),
      () => harness.manager.closeTab(UNKNOWN_TAB),
    ]) {
      await expect(operation()).rejects.toBeInstanceOf(TabNotFoundError);
    }
    expect(harness.tmux.kill).not.toHaveBeenCalled();
    expect(harness.registry.close).not.toHaveBeenCalled();
    expect(harness.activity.mark).not.toHaveBeenCalled();
  });

  it('collectionView enriches exactly one immutable store snapshot with one runtime snapshot', async () => {
    const harness = createHarness();
    const listGate = deferred<string[]>();
    vi.mocked(harness.tmux.listActiveSessionIds).mockReturnValueOnce(
      listGate.promise,
    );
    const bridge = Object.defineProperty(owner(), 'pid', { value: 4242 });
    await harness.registry.replace(TAB_A, bridge);

    const collecting = harness.manager.collectionView();
    harness.store.revision = 7;
    harness.store.records.get(TAB_A)!.displayName = 'Renamed later';
    harness.store.records.delete(TAB_B);
    listGate.resolve([TAB_A, TAB_B]);
    const collection = await collecting;

    expect(collection.structureRevision).toBe(0);
    expect(
      collection.tabs.map(({ id, displayName }) => ({ id, displayName })),
    ).toEqual([
      { id: TAB_A, displayName: 'Terminal A' },
      { id: TAB_B, displayName: 'Terminal B' },
    ]);
    expect(collection.tabs[0]?.session).toEqual({
      state: 'running',
      attached: true,
      bridgePid: 4242,
    });
    expect(Object.isFrozen(collection)).toBe(true);
    expect(Object.isFrozen(collection.tabs)).toBe(true);
    expect(harness.tmux.listActiveSessionIds).toHaveBeenCalledOnce();
  });

  it('uses unknown state on tmux list/probe failures without leaking their messages', async () => {
    const harness = createHarness();
    vi.mocked(harness.tmux.listActiveSessionIds).mockRejectedValueOnce(
      new Error('host and command detail'),
    );

    const collection = await harness.manager.collectionView();
    expect(
      collection.tabs.every((tab) => tab.session.state === 'unknown'),
    ).toBe(true);

    vi.mocked(harness.tmux.exists).mockRejectedValueOnce(
      new Error('more private output'),
    );
    await expect(harness.manager.terminate(TAB_A)).resolves.toMatchObject({
      session: { state: 'unknown' },
    });
  });

  it('rolls back bridge registration failure and releases the keyed mutex without PTY leaks', async () => {
    const harness = createHarness();
    const firstPty = fakePty();
    const secondPty = fakePty();
    vi.mocked(harness.ptyFactory.spawn)
      .mockReturnValueOnce(firstPty)
      .mockReturnValueOnce(secondPty);
    const originalReplace = harness.registry.replace.bind(harness.registry);
    vi.spyOn(harness.registry, 'replace')
      .mockImplementationOnce(async (_id, bridge) => {
        await bridge.close(1011, 'registration_failed');
        throw new Error('registry internals');
      })
      .mockImplementation(originalReplace);

    await expect(
      harness.manager.connect(harness.manager.authorize(TAB_A)!, fakeSocket(), {
        cols: 80,
        rows: 24,
      }),
    ).rejects.toBeInstanceOf(OperationFailedError);
    expect(firstPty.kill).toHaveBeenCalledOnce();

    await harness.manager.connect(
      harness.manager.authorize(TAB_A)!,
      fakeSocket(),
      { cols: 80, rows: 24 },
    );
    expect(secondPty.kill).not.toHaveBeenCalled();
  });
});

describe('SessionManager transitional compatibility', () => {
  it('supports the legacy request only when Phase 2 dependencies are omitted', async () => {
    const ptyFactory: PtyFactory = { spawn: vi.fn(() => fakePty()) };
    const manager = new SessionManager({
      preparer: { prepare: vi.fn(async () => attachSpec) },
      ptyFactory,
      registry: new BridgeRegistry(),
      bridgeFactory: { create: vi.fn(() => owner()) },
    });

    await manager.connect({
      sessionId: TAB_A,
      socket: fakeSocket(),
      dimensions: { cols: 80, rows: 24 },
    });
    expect(ptyFactory.spawn).toHaveBeenCalledOnce();
    await expect(manager.terminate(TAB_A)).rejects.toBeInstanceOf(
      OperationFailedError,
    );
  });

  it('rejects the legacy request in Phase 2 mode before side effects', async () => {
    const harness = createHarness();
    await expect(
      harness.manager.connect({
        sessionId: TAB_A,
        socket: fakeSocket(),
        dimensions: { cols: 80, rows: 24 },
      }),
    ).rejects.toBeInstanceOf(InvalidConnectionError);
    expect(harness.tmux.prepare).not.toHaveBeenCalled();
  });

  it('injects ID-only activity into TerminalBridge without changing constructor compatibility', () => {
    const activity = { mark: vi.fn<(id: string) => void>() };
    const factory = new TerminalBridgeFactory(
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      1024,
      activity,
    );
    const pty = fakePty();
    let onData: ((data: string) => void) | undefined;
    pty.onData = vi.fn((listener) => {
      onData = listener;
      return { dispose: vi.fn() };
    });

    factory.create({ sessionId: TAB_A, socket: fakeSocket(), pty });
    onData?.('private terminal content');

    expect(activity.mark).toHaveBeenCalledWith(TAB_A);
    expect(activity.mark).toHaveBeenCalledTimes(1);
  });
});

function createHarness() {
  const store = new MemoryStore([
    record(TAB_A, 'Terminal A'),
    record(TAB_B, 'Terminal B'),
  ]);
  const tmux = new FakeTmux([TAB_A, TAB_B]);
  const registry = new BridgeRegistry();
  vi.spyOn(registry, 'close');
  const ptyFactory: PtyFactory = { spawn: vi.fn(() => fakePty()) };
  const bridgeFactory: ManagedBridgeFactory = {
    create: vi.fn(({ pty }) => ({ close: vi.fn(async () => pty.kill()) })),
  };
  const activity = { mark: vi.fn<(id: string) => void>() };
  const manager = new SessionManager({
    store,
    activity,
    preparer: tmux,
    ptyFactory,
    registry,
    bridgeFactory,
  });
  return {
    manager,
    store,
    tmux,
    registry,
    ptyFactory,
    bridgeFactory,
    activity,
  };
}

class MemoryStore implements SessionTabStore {
  readonly records = new Map<string, MutableRecord>();
  revision = 0;

  readonly setDesiredState = vi.fn(async (id: string, state: DesiredState) =>
    this.applyState(id, state),
  );
  readonly remove = vi.fn(async (id: string) => {
    if (!this.records.delete(id)) throw new Error('missing');
    this.revision += 1;
  });

  constructor(records: TabRecord[]) {
    records.forEach((value) => this.records.set(value.id, { ...value }));
  }

  snapshot(): TabCollection {
    const snapshot: TabCollection = {
      structureRevision: this.revision,
      tabs: [...this.records.values()].map((value) =>
        Object.freeze({ ...value }),
      ),
    };
    Object.freeze(snapshot.tabs);
    return Object.freeze(snapshot);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  applyState(id: string, desiredState: DesiredState): TabRecord {
    const current = this.records.get(id);
    if (current === undefined) throw new Error('missing');
    current.desiredState = desiredState;
    return Object.freeze({ ...current });
  }
}

class FakeTmux implements SessionRuntimeController {
  readonly active: Set<string>;
  readonly prepare = vi.fn(async (id: string) => {
    this.active.add(id);
    return attachSpec;
  });
  readonly exists = vi.fn(async (id: string) => this.active.has(id));
  readonly kill = vi.fn(async (id: string) => {
    this.active.delete(id);
  });
  readonly listActiveSessionIds = vi.fn(async () => [...this.active]);
  readonly attachSpec = vi.fn(() => attachSpec);

  constructor(ids: string[]) {
    this.active = new Set(ids);
  }
}

type MutableRecord = {
  -readonly [K in keyof TabRecord]: TabRecord[K];
};

function record(id: string, displayName: string): TabRecord {
  return Object.freeze({
    id,
    displayName,
    position: id === TAB_A ? 0 : 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    lastActivityAt: '2026-07-11T00:00:00.000Z',
    desiredState: 'active',
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function owner(result: Promise<void> = Promise.resolve()): BridgeOwner {
  return { close: vi.fn(() => result) };
}

function fakePty(): PtyProcess {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function fakeSocket(): SocketPort {
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    onMessage: vi.fn(() => ({ dispose: vi.fn() })),
    onClose: vi.fn(() => ({ dispose: vi.fn() })),
    onError: vi.fn(() => ({ dispose: vi.fn() })),
  };
}
