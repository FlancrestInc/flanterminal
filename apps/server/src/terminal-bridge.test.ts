import { describe, expect, it, vi, type Mock } from 'vitest';

import type { LifecycleLogger } from './logger.js';
import type { Disposable, PtyExit, PtyProcess } from './pty.js';
import {
  OPEN_SOCKET_STATE,
  TerminalBridge,
  type SocketPort,
} from './terminal-bridge.js';

type FakeDisposable = { dispose: Mock<() => void> };

describe('TerminalBridge', () => {
  it('forwards input, output, and resize without logging terminal data', () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    const logger = new CapturingLogger();
    const bridge = createBridge(socket, pty, logger);
    const inputSecret = 'unique-input-secret';
    const outputSecret = 'unique-output-secret';

    bridge.write(inputSecret);
    bridge.resize(120, 40);
    pty.emitData(outputSecret);

    expect(pty.write).toHaveBeenCalledWith(inputSecret);
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
    expect(socket.sent).toEqual([
      JSON.stringify({
        v: 1,
        type: 'output',
        sessionId: 'phase-1-main',
        data: outputSecret,
      }),
    ]);
    expect(JSON.stringify(logger.records)).not.toContain(inputSecret);
    expect(JSON.stringify(logger.records)).not.toContain(outputSecret);
  });

  it('sends output only while the socket is OPEN', () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    const pty = new FakePty();
    createBridge(socket, pty);

    pty.emitData('not-sent');

    expect(socket.sent).toEqual([]);
  });

  it('closes with 4002 and cleans up before sending above the buffer limit', () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 101;
    const pty = new FakePty();
    const bridge = createBridge(socket, pty, undefined, 100);

    pty.emitData('discarded-output');
    pty.emitData('never-replayed');

    expect(socket.sent).toEqual([]);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(4002, 'terminal_backpressure');
    expectDisposedOnce(bridge, socket, pty);
  });

  it('caps configured buffering at one MiB', () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 1_048_577;
    const pty = new FakePty();
    createBridge(socket, pty, undefined, 10_000_000);

    pty.emitData('discarded');

    expect(socket.close).toHaveBeenCalledWith(4002, 'terminal_backpressure');
  });

  it('reports a bounded lifecycle error and closes when the PTY exits', () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    const logger = new CapturingLogger();
    createBridge(socket, pty, logger);

    pty.emitExit({ exitCode: 55, signal: 9 });

    expect(socket.sent).toEqual([
      JSON.stringify({
        v: 1,
        type: 'error',
        sessionId: 'phase-1-main',
        code: 'terminal_unavailable',
      }),
    ]);
    expect(socket.close).toHaveBeenCalledWith(1011, 'terminal_exited');
    expect(logger.records).toContainEqual({
      level: 'warn',
      event: 'terminal_exited',
      metadata: { sessionId: 'phase-1-main', exitCode: 55, signal: 9 },
    });
  });

  it.each(['close', 'error'] as const)('cleans up on socket %s', (event) => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    const bridge = createBridge(socket, pty);

    socket.emit(event);

    expectDisposedOnce(bridge, socket, pty);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('cleans up when output serialization or sending throws', () => {
    const socket = new FakeSocket();
    socket.send = vi.fn(() => {
      throw new Error('unique-output-secret');
    });
    const pty = new FakePty();
    const logger = new CapturingLogger();
    const bridge = createBridge(socket, pty, logger);

    pty.emitData('unique-output-secret');

    expectDisposedOnce(bridge, socket, pty);
    expect(JSON.stringify(logger.records)).not.toContain(
      'unique-output-secret',
    );
  });

  it('makes explicit and repeated cleanup idempotent', async () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    const bridge = createBridge(socket, pty);

    await Promise.all([
      bridge.close(4001, 'replaced'),
      bridge.close(4001, 'replaced'),
    ]);
    socket.emit('close');
    pty.emitExit({ exitCode: 0 });

    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledWith(4001, 'replaced');
    expectDisposedOnce(bridge, socket, pty);
  });

  it('continues cleanup when a subscription disposer throws', async () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    const bridge = createBridge(socket, pty);
    pty.disposables[0]?.dispose.mockImplementation(() => {
      throw new Error('dispose failed');
    });

    await expect(bridge.close()).resolves.toBeUndefined();

    expectDisposedOnce(bridge, socket, pty);
  });
});

function createBridge(
  socket: FakeSocket,
  pty: FakePty,
  logger: LifecycleLogger = new CapturingLogger(),
  maxBufferedBytes = 1024,
) {
  return new TerminalBridge({
    sessionId: 'phase-1-main',
    socket,
    pty,
    logger,
    maxBufferedBytes,
  });
}

function expectDisposedOnce(
  _bridge: TerminalBridge,
  socket: FakeSocket,
  pty: FakePty,
) {
  expect(pty.kill).toHaveBeenCalledOnce();
  for (const disposable of [...socket.disposables, ...pty.disposables]) {
    expect(disposable.dispose).toHaveBeenCalledOnce();
  }
}

class FakeSocket implements SocketPort {
  readonly OPEN = OPEN_SOCKET_STATE;
  readyState = OPEN_SOCKET_STATE;
  bufferedAmount = 0;
  sent: string[] = [];
  disposables: FakeDisposable[] = [];
  private closeListeners: Array<() => void> = [];
  private errorListeners: Array<() => void> = [];

  send = vi.fn((data: string) => this.sent.push(data));
  close = vi.fn();

  onClose(listener: () => void): Disposable {
    this.closeListeners.push(listener);
    return this.disposable();
  }

  onError(listener: () => void): Disposable {
    this.errorListeners.push(listener);
    return this.disposable();
  }

  emit(event: 'close' | 'error') {
    for (const listener of event === 'close'
      ? this.closeListeners
      : this.errorListeners)
      listener();
  }

  private disposable(): FakeDisposable {
    const disposable = { dispose: vi.fn() };
    this.disposables.push(disposable);
    return disposable;
  }
}

class FakePty implements PtyProcess {
  disposables: FakeDisposable[] = [];
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: PtyExit) => void> = [];

  write = vi.fn();
  resize = vi.fn();
  kill = vi.fn();

  onData(listener: (data: string) => void): Disposable {
    this.dataListeners.push(listener);
    return this.disposable();
  }

  onExit(listener: (event: PtyExit) => void): Disposable {
    this.exitListeners.push(listener);
    return this.disposable();
  }

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyExit) {
    for (const listener of this.exitListeners) listener(event);
  }

  private disposable(): FakeDisposable {
    const disposable = { dispose: vi.fn() };
    this.disposables.push(disposable);
    return disposable;
  }
}

class CapturingLogger implements LifecycleLogger {
  records: Array<Record<string, unknown>> = [];

  info(event: string, metadata: Record<string, unknown> = {}) {
    this.records.push({ level: 'info', event, metadata });
  }

  warn(event: string, metadata: Record<string, unknown> = {}) {
    this.records.push({ level: 'warn', event, metadata });
  }

  error(event: string, metadata: Record<string, unknown> = {}) {
    this.records.push({ level: 'error', event, metadata });
  }
}
