import { describe, expect, it, vi } from 'vitest';

import { BridgeRegistry } from './bridge-registry.js';
import type { PtyFactory, PtyProcess } from './pty.js';
import {
  SessionManager,
  TerminalBridgeFactory,
  type ManagedBridgeFactory,
} from './session-manager.js';
import type { BridgeOwner, SocketPort } from './terminal-bridge.js';
import type { AttachSpec, SessionPreparer } from './tmux.js';

const attachSpec: AttachSpec = {
  executable: '/usr/bin/tmux',
  args: ['attach-session', '-t', 'webterm-phase-1-main'],
  cwd: '/home/webterm',
  env: { HOME: '/home/webterm', SHELL: '/bin/bash', TERM: 'xterm-256color' },
};

describe('SessionManager', () => {
  it('serializes simultaneous connects so tmux is created once', async () => {
    let finishPrepare: ((spec: AttachSpec) => void) | undefined;
    let preparationCalls = 0;
    let tmuxCreations = 0;
    const preparer: SessionPreparer = {
      prepare: vi.fn(async () => {
        preparationCalls += 1;
        if (tmuxCreations === 0) tmuxCreations += 1;
        if (preparationCalls === 1) {
          return new Promise<AttachSpec>((resolve) => {
            finishPrepare = resolve;
          });
        }
        return attachSpec;
      }),
    };
    const harness = createHarness(preparer);

    const first = harness.manager.connect(request());
    const second = harness.manager.connect(request());

    await vi.waitFor(() => expect(preparer.prepare).toHaveBeenCalledOnce());
    expect(harness.ptyFactory.spawn).not.toHaveBeenCalled();
    finishPrepare?.(attachSpec);
    const [firstOwner, secondOwner] = await Promise.all([first, second]);

    expect(preparer.prepare).toHaveBeenCalledTimes(2);
    expect(tmuxCreations).toBe(1);
    expect(harness.ptyFactory.spawn).toHaveBeenCalledTimes(2);
    expect(firstOwner.close).toHaveBeenCalledWith(4001, 'session_replaced');
    expect(harness.registry.get('phase-1-main')).toBe(secondOwner);
  });

  it('fully disposes the prior owner before spawning a replacement PTY', async () => {
    let finishClose: (() => void) | undefined;
    const prior = owner(
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
    );
    const harness = createHarness();
    await harness.registry.replace('phase-1-main', prior);

    const connecting = harness.manager.connect(request());

    await vi.waitFor(() =>
      expect(prior.close).toHaveBeenCalledWith(4001, 'session_replaced'),
    );
    expect(harness.ptyFactory.spawn).not.toHaveBeenCalled();
    finishClose?.();
    await connecting;
    expect(harness.ptyFactory.spawn).toHaveBeenCalledOnce();
  });

  it('does not spawn or register after preparation failure and allows retry', async () => {
    const preparer: SessionPreparer = {
      prepare: vi
        .fn<SessionPreparer['prepare']>()
        .mockRejectedValueOnce(new Error('tmux unavailable'))
        .mockResolvedValueOnce(attachSpec),
    };
    const harness = createHarness(preparer);

    await expect(harness.manager.connect(request())).rejects.toThrow(
      'tmux unavailable',
    );
    expect(harness.ptyFactory.spawn).not.toHaveBeenCalled();
    expect(harness.registry.get('phase-1-main')).toBeUndefined();

    await expect(harness.manager.connect(request())).resolves.toBeDefined();
    expect(preparer.prepare).toHaveBeenCalledTimes(2);
  });

  it('leaves no owner after spawn failure and allows a subsequent retry', async () => {
    const ptyFactory: PtyFactory = {
      spawn: vi
        .fn<PtyFactory['spawn']>()
        .mockImplementationOnce(() => {
          throw new Error('spawn failed');
        })
        .mockReturnValue(fakePty()),
    };
    const harness = createHarness(undefined, ptyFactory);

    await expect(harness.manager.connect(request())).rejects.toThrow(
      'spawn failed',
    );
    expect(harness.registry.get('phase-1-main')).toBeUndefined();
    await expect(harness.manager.connect(request())).resolves.toBeDefined();
    expect(harness.preparer.prepare).toHaveBeenCalledTimes(2);
  });

  it('hands PTY cleanup to the bridge factory once creation begins', async () => {
    const failingPty = fakePty();
    failingPty.onExit = vi.fn(() => {
      throw new Error('subscription setup failed');
    });
    const healthyPty = fakePty();
    const ptyFactory: PtyFactory = {
      spawn: vi
        .fn<PtyFactory['spawn']>()
        .mockReturnValueOnce(failingPty)
        .mockReturnValueOnce(healthyPty),
    };
    const registry = new BridgeRegistry();
    const bridgeFactory = new TerminalBridgeFactory(
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      1024,
    );
    const manager = new SessionManager({
      preparer: { prepare: vi.fn(async () => attachSpec) },
      ptyFactory,
      registry,
      bridgeFactory,
    });

    await expect(manager.connect(request())).rejects.toThrow(
      'Terminal bridge setup failed',
    );

    expect(failingPty.kill).toHaveBeenCalledOnce();
    expect(registry.get('phase-1-main')).toBeUndefined();

    await expect(manager.connect(request())).resolves.toBeDefined();
    expect(registry.get('phase-1-main')).toBeDefined();
    await registry.closeAll();
    expect(healthyPty.kill).toHaveBeenCalledOnce();
  });

  it('rolls back a new bridge when registration fails and releases the mutex', async () => {
    const registry = new BridgeRegistry();
    const prior = owner();
    await registry.replace('phase-1-main', prior);
    const originalReplace = registry.replace.bind(registry);
    vi.spyOn(registry, 'replace')
      .mockRejectedValueOnce(new Error('registration failed'))
      .mockImplementation((sessionId, bridge) =>
        originalReplace(sessionId, bridge),
      );
    const ptys = [fakePty(), fakePty()];
    const ptyFactory: PtyFactory = {
      spawn: vi
        .fn<PtyFactory['spawn']>()
        .mockReturnValueOnce(ptys[0]!)
        .mockReturnValueOnce(ptys[1]!),
    };
    const bridges: BridgeOwner[] = [];
    const bridgeFactory: ManagedBridgeFactory = {
      create: vi.fn(({ pty }) => {
        const bridge: BridgeOwner = {
          close: vi.fn(async () => pty.kill()),
        };
        bridges.push(bridge);
        return bridge;
      }),
    };
    const manager = new SessionManager({
      preparer: { prepare: vi.fn(async () => attachSpec) },
      ptyFactory,
      registry,
      bridgeFactory,
    });

    await expect(manager.connect(request())).rejects.toThrow(
      'registration failed',
    );

    expect(prior.close).toHaveBeenCalledOnce();
    expect(bridges[0]?.close).toHaveBeenCalledOnce();
    expect(bridges[0]?.close).toHaveBeenCalledWith(1011, 'registration_failed');
    expect(ptys[0]?.kill).toHaveBeenCalledOnce();
    expect(registry.get('phase-1-main')).toBeUndefined();

    const retried = await manager.connect(request());
    expect(retried).toBe(bridges[1]);
    expect(registry.get('phase-1-main')).toBe(bridges[1]);
    expect(prior.close).toHaveBeenCalledOnce();
    expect(ptys[1]?.kill).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: 'other', dimensions: { cols: 80, rows: 24 } },
    { sessionId: 'phase-1-main', dimensions: { cols: 1, rows: 24 } },
    { sessionId: 'phase-1-main', dimensions: { cols: 80, rows: 201 } },
    { sessionId: 'phase-1-main', dimensions: { cols: 80.5, rows: 24 } },
  ])(
    'validates the request before preparing: $sessionId $dimensions',
    async (invalid) => {
      const harness = createHarness();

      await expect(
        harness.manager.connect({ ...invalid, socket: fakeSocket() }),
      ).rejects.toThrow('Invalid terminal connection');
      expect(harness.preparer.prepare).not.toHaveBeenCalled();
      expect(harness.ptyFactory.spawn).not.toHaveBeenCalled();
    },
  );
});

function createHarness(
  preparer: SessionPreparer = { prepare: vi.fn(async () => attachSpec) },
  ptyFactory: PtyFactory = { spawn: vi.fn(() => fakePty()) },
) {
  const registry = new BridgeRegistry();
  const bridgeFactory: ManagedBridgeFactory = {
    create: vi.fn(() => owner()),
  };
  return {
    manager: new SessionManager({
      preparer,
      ptyFactory,
      registry,
      bridgeFactory,
    }),
    preparer,
    ptyFactory,
    registry,
    bridgeFactory,
  };
}

function request() {
  return {
    sessionId: 'phase-1-main',
    socket: fakeSocket(),
    dimensions: { cols: 80, rows: 24 },
  };
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
    onClose: vi.fn(() => ({ dispose: vi.fn() })),
    onError: vi.fn(() => ({ dispose: vi.fn() })),
  };
}
