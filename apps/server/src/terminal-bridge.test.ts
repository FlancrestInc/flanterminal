import { describe, expect, it, vi, type Mock } from 'vitest';

import type { LifecycleLogger } from './logger.js';
import type { Disposable, PtyExit, PtyProcess } from './pty.js';
import {
  OPEN_SOCKET_STATE,
  TerminalBridge,
  type SocketPort,
  type TerminalBridgeOptions,
} from './terminal-bridge.js';

type FakeDisposable = { dispose: Mock<() => void> };
const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('TerminalBridge', () => {
  it.each(['omitted', 'malformed'] as const)(
    'fails closed when the authenticated input gate is %s',
    (configuration) => {
      const socket = new FakeSocket();
      const pty = new FakePty();
      const options = {
        sessionId: SESSION_ID,
        socket,
        pty,
        logger: new CapturingLogger(),
        maxBufferedBytes: 1024,
        ...(configuration === 'malformed'
          ? { authenticatedInput: { authenticate: () => 'true' } }
          : {}),
      } as unknown as TerminalBridgeOptions;
      new TerminalBridge(options);

      socket.emitMessage(
        JSON.stringify({
          v: 1,
          type: 'input',
          sessionId: SESSION_ID,
          data: 'must not reach pty',
        }),
      );

      expect(pty.write).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(
        4003,
        'authentication_required',
      );
    },
  );

  it('authenticates accepted same-session input immediately before PTY write', () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    const authenticateInput = vi.fn(() => true);
    createBridge(socket, pty, undefined, 1024, undefined, authenticateInput);

    socket.emitMessage(
      JSON.stringify({
        v: 1,
        type: 'input',
        sessionId: SESSION_ID,
        data: 'private input',
      }),
    );

    expect(authenticateInput).toHaveBeenCalledOnce();
    expect(authenticateInput.mock.invocationCallOrder[0]).toBeLessThan(
      pty.write.mock.invocationCallOrder[0]!,
    );
    expect(pty.write).toHaveBeenCalledWith('private input');
  });

  it.each(['revoked', 'failure'] as const)(
    'blocks input and closes 4003 when input authentication reports %s',
    (outcome) => {
      const socket = new FakeSocket();
      const pty = new FakePty();
      const logger = new CapturingLogger();
      const secret = 'credential-or-terminal-secret';
      const authenticateInput = vi.fn(() => {
        if (outcome === 'failure') throw new Error(secret);
        return false;
      });
      createBridge(socket, pty, logger, 1024, undefined, authenticateInput);

      socket.emitMessage(
        JSON.stringify({
          v: 1,
          type: 'input',
          sessionId: SESSION_ID,
          data: secret,
        }),
      );

      expect(pty.write).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(
        4003,
        'authentication_required',
      );
      expect(JSON.stringify(logger.records)).not.toContain(secret);
    },
  );

  it('does not authenticate resize, output, malformed, or mismatched frames', () => {
    const authenticateInput = vi.fn(() => true);
    const resizeSocket = new FakeSocket();
    const resizePty = new FakePty();
    createBridge(
      resizeSocket,
      resizePty,
      undefined,
      1024,
      undefined,
      authenticateInput,
    );
    resizeSocket.emitMessage(
      JSON.stringify({
        v: 1,
        type: 'resize',
        sessionId: SESSION_ID,
        cols: 80,
        rows: 24,
      }),
    );
    resizePty.emitData('private output');

    const malformedSocket = new FakeSocket();
    createBridge(
      malformedSocket,
      new FakePty(),
      undefined,
      1024,
      undefined,
      authenticateInput,
    );
    malformedSocket.emitMessage('{private');

    const mismatchedSocket = new FakeSocket();
    createBridge(
      mismatchedSocket,
      new FakePty(),
      undefined,
      1024,
      undefined,
      authenticateInput,
    );
    mismatchedSocket.emitMessage(
      JSON.stringify({
        v: 1,
        type: 'input',
        sessionId: OTHER_SESSION_ID,
        data: 'private',
      }),
    );

    expect(authenticateInput).not.toHaveBeenCalled();
  });

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
        sessionId: SESSION_ID,
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

  it('closes when the existing socket buffer is exactly at the limit', () => {
    const socket = new FakeSocket();
    socket.bufferedAmount = 100;
    const pty = new FakePty();
    createBridge(socket, pty, undefined, 100);

    pty.emitData('output');

    expect(socket.sent).toEqual([]);
    expect(socket.close).toHaveBeenCalledWith(4002, 'terminal_backpressure');
  });

  it.each([
    ['equals', 0],
    ['crosses', -1],
  ] as const)(
    'closes when buffered bytes plus the encoded output frame %s the limit',
    (_case, offset) => {
      const data = 'é"\n';
      const frame = JSON.stringify({
        v: 1,
        type: 'output',
        sessionId: SESSION_ID,
        data,
      });
      const frameBytes = new TextEncoder().encode(frame).byteLength;
      const socket = new FakeSocket();
      socket.bufferedAmount = 7;
      const pty = new FakePty();
      createBridge(socket, pty, undefined, 7 + frameBytes + offset);

      pty.emitData(data);

      expect(frameBytes).toBeGreaterThan(frame.length);
      expect(socket.sent).toEqual([]);
      expect(socket.close).toHaveBeenCalledWith(4002, 'terminal_backpressure');
    },
  );

  it('sends JSON-escaped multibyte output when the encoded frame stays below the limit', () => {
    const data = 'é"\n';
    const frame = JSON.stringify({
      v: 1,
      type: 'output',
      sessionId: SESSION_ID,
      data,
    });
    const frameBytes = new TextEncoder().encode(frame).byteLength;
    const socket = new FakeSocket();
    socket.bufferedAmount = 7;
    const pty = new FakePty();
    createBridge(socket, pty, undefined, 7 + frameBytes + 1);

    pty.emitData(data);

    expect(socket.sent).toEqual([frame]);
    expect(socket.close).not.toHaveBeenCalled();
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
        sessionId: SESSION_ID,
        code: 'terminal_unavailable',
      }),
    ]);
    expect(socket.close).toHaveBeenCalledWith(1011, 'terminal_exited');
    expect(logger.records).toContainEqual({
      level: 'warn',
      event: 'terminal_exited',
      metadata: { sessionId: SESSION_ID, exitCode: 55, signal: 9 },
    });
  });

  it.each([
    ['above', -1, false],
    ['at', 0, false],
    ['below', 1, true],
  ] as const)(
    'sends a lifecycle error only when pending UTF-8 bytes stay %s the limit',
    (_boundary, limitOffset, shouldSend) => {
      const frame = JSON.stringify({
        v: 1,
        type: 'error',
        sessionId: SESSION_ID,
        code: 'terminal_unavailable',
      });
      const frameBytes = new TextEncoder().encode(frame).byteLength;
      const socket = new FakeSocket();
      socket.bufferedAmount = 7;
      const pty = new FakePty();
      createBridge(socket, pty, undefined, 7 + frameBytes + limitOffset);

      pty.emitExit({ exitCode: 1 });

      expect(socket.sent).toEqual(shouldSend ? [frame] : []);
      expect(socket.close).toHaveBeenCalledWith(1011, 'terminal_exited');
      expect(pty.kill).toHaveBeenCalledOnce();
    },
  );

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

  it('terminates an open socket when lifecycle close throws', async () => {
    const socket = new FakeSocket();
    socket.close.mockImplementation(() => {
      throw new Error('private close failure');
    });
    const pty = new FakePty();
    const bridge = createBridge(socket, pty);

    await expect(
      bridge.close(4003, 'authentication_required'),
    ).resolves.toBeUndefined();

    expect(socket.close).toHaveBeenCalledWith(4003, 'authentication_required');
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.readyState).not.toBe(socket.OPEN);
    expect(pty.kill).toHaveBeenCalledOnce();
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

  it.each(['ptyExit', 'socketClose', 'socketError'] as const)(
    'rolls back earlier subscriptions when %s registration throws',
    (registration) => {
      const socket = new FakeSocket();
      const pty = new FakePty();
      if (registration === 'ptyExit') pty.throwOnExitRegistration = true;
      if (registration === 'socketClose')
        socket.throwOnCloseRegistration = true;
      if (registration === 'socketError')
        socket.throwOnErrorRegistration = true;

      let caught: unknown;
      try {
        createBridge(socket, pty);
      } catch (error) {
        caught = error;
      }

      expect(pty.kill).toHaveBeenCalledOnce();
      expect(socket.close).toHaveBeenCalledWith(1011, 'terminal_setup_failed');
      for (const disposable of [...socket.disposables, ...pty.disposables]) {
        expect(disposable.dispose).toHaveBeenCalledOnce();
      }
      expect(String(caught)).toBe('Error: Terminal bridge setup failed');
    },
  );

  it.each(['input', 'resize'] as const)(
    'rejects a valid %s frame authorized for a different session',
    (type) => {
      const socket = new FakeSocket();
      const pty = new FakePty();
      const logger = new CapturingLogger();
      createBridge(socket, pty, logger);
      const frame =
        type === 'input'
          ? { v: 1, type, sessionId: OTHER_SESSION_ID, data: 'private input' }
          : { v: 1, type, sessionId: OTHER_SESSION_ID, cols: 100, rows: 30 };

      socket.emitMessage(JSON.stringify(frame));

      expect(pty.write).not.toHaveBeenCalled();
      expect(pty.resize).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(1008, 'invalid_message');
      expect(logger.records).toContainEqual({
        level: 'warn',
        event: 'protocol_message_rejected',
        metadata: { sessionId: SESSION_ID, category: 'session_mismatch' },
      });
      expect(JSON.stringify(logger.records)).not.toContain('private input');
    },
  );

  it('marks accepted input, resize, and output activity by session ID only', () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    const onActivity = vi.fn();
    createBridge(socket, pty, undefined, 1024, onActivity);

    socket.emitMessage(
      JSON.stringify({
        v: 1,
        type: 'input',
        sessionId: SESSION_ID,
        data: 'private input',
      }),
    );
    socket.emitMessage(
      JSON.stringify({
        v: 1,
        type: 'resize',
        sessionId: SESSION_ID,
        cols: 100,
        rows: 30,
      }),
    );
    pty.emitData('private output');

    expect(onActivity).toHaveBeenCalledTimes(3);
    expect(onActivity).toHaveBeenNthCalledWith(1, SESSION_ID);
    expect(onActivity).toHaveBeenNthCalledWith(2, SESSION_ID);
    expect(onActivity).toHaveBeenNthCalledWith(3, SESSION_ID);
  });

  it('does not mark malformed or mismatched frame activity', () => {
    const onActivity = vi.fn();
    const malformedSocket = new FakeSocket();
    createBridge(malformedSocket, new FakePty(), undefined, 1024, onActivity);
    malformedSocket.emitMessage('{');

    const mismatchSocket = new FakeSocket();
    createBridge(mismatchSocket, new FakePty(), undefined, 1024, onActivity);
    mismatchSocket.emitMessage(
      JSON.stringify({
        v: 1,
        type: 'input',
        sessionId: OTHER_SESSION_ID,
        data: 'secret',
      }),
    );

    expect(onActivity).not.toHaveBeenCalled();
  });

  it('bounds activity observer failures without interrupting terminal flow', () => {
    const socket = new FakeSocket();
    const pty = new FakePty();
    const logger = new CapturingLogger();
    createBridge(socket, pty, logger, 1024, () => {
      throw new Error('observer-secret');
    });

    socket.emitMessage(
      JSON.stringify({
        v: 1,
        type: 'input',
        sessionId: SESSION_ID,
        data: 'input-secret',
      }),
    );

    expect(pty.write).toHaveBeenCalledWith('input-secret');
    expect(socket.close).not.toHaveBeenCalled();
    expect(logger.records).toContainEqual({
      level: 'warn',
      event: 'terminal_activity_failed',
      metadata: { sessionId: SESSION_ID },
    });
    expect(JSON.stringify(logger.records)).not.toContain('observer-secret');
  });

  it.each([
    [4321, 4321],
    [0, null],
    [-1, null],
    [1.5, null],
    [Number.POSITIVE_INFINITY, null],
    ['4321', null],
    [undefined, null],
  ])('exposes only a validated PTY pid for %j', (nativePid, expected) => {
    const pty = new FakePty();
    Object.assign(pty, { pid: nativePid, privateState: 'do-not-expose' });
    const bridge = createBridge(new FakeSocket(), pty);

    expect(bridge.pid).toBe(expected);
    expect(Object.keys({ sessionId: SESSION_ID, pid: bridge.pid })).toEqual([
      'sessionId',
      'pid',
    ]);
  });
});

function createBridge(
  socket: FakeSocket,
  pty: FakePty,
  logger: LifecycleLogger = new CapturingLogger(),
  maxBufferedBytes = 1024,
  onActivity?: (sessionId: string) => void,
  authenticateInput: () => boolean = () => true,
) {
  return new TerminalBridge({
    sessionId: SESSION_ID,
    socket,
    pty,
    logger,
    maxBufferedBytes,
    ...(onActivity === undefined ? {} : { onActivity }),
    authenticatedInput: { authenticate: authenticateInput },
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
  readonly authenticatedInput = { authenticate: () => true };
  readyState = OPEN_SOCKET_STATE;
  bufferedAmount = 0;
  sent: string[] = [];
  disposables: FakeDisposable[] = [];
  throwOnCloseRegistration = false;
  throwOnErrorRegistration = false;
  private closeListeners: Array<() => void> = [];
  private errorListeners: Array<() => void> = [];
  private messageListeners: Array<(data: unknown, isBinary: boolean) => void> =
    [];

  send = vi.fn((data: string) => this.sent.push(data));
  close = vi.fn(() => {
    this.readyState = 2;
  });
  terminate = vi.fn(() => {
    this.readyState = 3;
  });

  onMessage(listener: (data: unknown, isBinary: boolean) => void): Disposable {
    this.messageListeners.push(listener);
    return this.disposable();
  }

  onClose(listener: () => void): Disposable {
    if (this.throwOnCloseRegistration)
      throw new Error('close registration failed');
    this.closeListeners.push(listener);
    return this.disposable();
  }

  onError(listener: () => void): Disposable {
    if (this.throwOnErrorRegistration)
      throw new Error('error registration failed');
    this.errorListeners.push(listener);
    return this.disposable();
  }

  emit(event: 'close' | 'error') {
    for (const listener of event === 'close'
      ? this.closeListeners
      : this.errorListeners)
      listener();
  }

  emitMessage(data: unknown, isBinary = false) {
    for (const listener of this.messageListeners) listener(data, isBinary);
  }

  private disposable(): FakeDisposable {
    const disposable = { dispose: vi.fn() };
    this.disposables.push(disposable);
    return disposable;
  }
}

class FakePty implements PtyProcess {
  disposables: FakeDisposable[] = [];
  throwOnExitRegistration = false;
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
    if (this.throwOnExitRegistration)
      throw new Error('exit registration failed');
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
