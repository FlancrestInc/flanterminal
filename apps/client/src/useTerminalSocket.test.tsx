// @vitest-environment jsdom

import type { ClientConfig } from '@flanterminal/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  terminalSocketUrl,
  useTerminalSocket,
  type BrowserSocket,
} from './useTerminalSocket.js';

const config: ClientConfig = {
  basePath: '/tools/terminal',
  fontSize: 14,
  scrollback: 5_000,
  resizeDebounceMs: 100,
  reconnectMaxSeconds: 8,
};
const DYNAMIC_SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const FIXED_SESSION_ID = DYNAMIC_SESSION_ID;

class FakeSocket extends EventTarget implements BrowserSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly sent: string[] = [];
  readonly close = vi.fn((code?: number) => {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(
      new CloseEvent('close', code === undefined ? {} : { code }),
    );
  });
  readyState = FakeSocket.CONNECTING;

  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(data: string) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  temporaryClose() {
    this.readyState = FakeSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code: 1006 }));
  }

  send(data: string) {
    this.sent.push(data);
  }
}

function readyMessage() {
  return JSON.stringify({
    v: 1,
    type: 'ready',
    sessionId: FIXED_SESSION_ID,
  });
}

function harness(override: Partial<ClientConfig> = {}) {
  const sockets: FakeSocket[] = [];
  const factory = vi.fn((url: string) => {
    void url;
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const hook = renderHook(() =>
    useTerminalSocket({ ...config, ...override }, DYNAMIC_SESSION_ID, {
      socketFactory: factory,
    }),
  );
  return { ...hook, sockets, factory };
}

beforeEach(() => {
  vi.useFakeTimers();
  window.history.replaceState({}, '', '/tools/terminal/');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTerminalSocket', () => {
  it('does not add a duplicate slash for a root-mounted runtime', () => {
    expect(
      terminalSocketUrl({ basePath: '/' }, DYNAMIC_SESSION_ID, {
        host: 'terminal.example',
        protocol: 'https:',
      }),
    ).toBe(`wss://terminal.example/ws/sessions/${FIXED_SESSION_ID}`);
  });

  it('connects to the configured session beneath the runtime base path', () => {
    const { result, sockets, factory } = harness();

    expect(result.current.status).toBe('connecting');
    expect(factory).toHaveBeenCalledWith(
      `ws://${window.location.host}/tools/terminal/ws/sessions/${FIXED_SESSION_ID}`,
    );

    act(() => {
      sockets[0]!.open();
      sockets[0]!.message(readyMessage());
    });
    expect(result.current.status).toBe('connected');
  });

  it('uses an explicit dynamic tab ID for the URL and every frame', () => {
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const { result } = renderHook(() =>
      useTerminalSocket(config, DYNAMIC_SESSION_ID, { socketFactory: factory }),
    );

    expect(factory).toHaveBeenCalledWith(
      `ws://${window.location.host}/tools/terminal/ws/sessions/${DYNAMIC_SESSION_ID}`,
    );
    act(() => {
      sockets[0]!.open();
      sockets[0]!.message(
        JSON.stringify({ v: 1, type: 'ready', sessionId: DYNAMIC_SESSION_ID }),
      );
      result.current.sendInput('pwd\n');
    });
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({
      sessionId: DYNAMIC_SESSION_ID,
      data: 'pwd\n',
    });
  });

  it('sends versioned input and resize only while open and never replays input', () => {
    const { result, sockets } = harness();
    act(() => result.current.sendInput('before-open'));
    expect(sockets[0]!.sent).toEqual([]);

    act(() => {
      sockets[0]!.open();
      result.current.sendInput('ls\n');
      result.current.sendResize(101, 32);
    });
    expect(sockets[0]!.sent.map((value) => JSON.parse(value))).toEqual([
      { v: 1, type: 'input', sessionId: FIXED_SESSION_ID, data: 'ls\n' },
      {
        v: 1,
        type: 'resize',
        sessionId: FIXED_SESSION_ID,
        cols: 101,
        rows: 32,
      },
    ]);

    act(() => sockets[0]!.temporaryClose());
    expect(result.current.sendInput('lost')).toBe(false);
    act(() => vi.advanceTimersByTime(500));
    expect(sockets[1]!.sent).toEqual([]);
  });

  it('publishes validated output and bounds malformed-message errors', () => {
    const { result, sockets } = harness();
    const output = vi.fn();
    const unsubscribe = result.current.subscribeOutput(output);

    act(() => {
      sockets[0]!.open();
      sockets[0]!.message(
        JSON.stringify({
          v: 1,
          type: 'output',
          sessionId: FIXED_SESSION_ID,
          data: 'hello\u001b[0m',
        }),
      );
    });
    expect(output).toHaveBeenCalledWith('hello\u001b[0m');

    act(() => sockets[0]!.message('{"private":"payload"}'));
    expect(result.current.error).toBe('Terminal connection protocol error.');
    expect(result.current.error).not.toContain('private');
    expect(sockets[0]!.close).toHaveBeenCalledWith(1002, 'Protocol error');
    unsubscribe();
  });

  it('backs off at 500ms, 1s, 2s, 4s, 8s and caps each delay', () => {
    const { sockets, factory } = harness({ reconnectMaxSeconds: 2 });
    const delays = [500, 1_000, 2_000, 2_000, 2_000];

    for (const [index, delay] of delays.entries()) {
      act(() => sockets[index]!.temporaryClose());
      expect(factory).toHaveBeenCalledTimes(index + 1);
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(factory).toHaveBeenCalledTimes(index + 1);
      act(() => vi.advanceTimersByTime(1));
      expect(factory).toHaveBeenCalledTimes(index + 2);
    }
  });

  it('reaches the configured 15 second cap after the 8 second retry', () => {
    const { sockets, factory } = harness({ reconnectMaxSeconds: 15 });
    const delays = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000];

    for (const [index, delay] of delays.entries()) {
      act(() => sockets[index]!.temporaryClose());
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(factory).toHaveBeenCalledTimes(index + 1);
      act(() => vi.advanceTimersByTime(1));
      expect(factory).toHaveBeenCalledTimes(index + 2);
    }
  });

  it('jumps directly from 8 seconds to a configured larger retry cap', () => {
    const { sockets, factory } = harness({ reconnectMaxSeconds: 60 });
    const delays = [500, 1_000, 2_000, 4_000, 8_000, 60_000, 60_000];

    for (const [index, delay] of delays.entries()) {
      act(() => sockets[index]!.temporaryClose());
      act(() => vi.advanceTimersByTime(delay - 1));
      expect(factory).toHaveBeenCalledTimes(index + 1);
      act(() => vi.advanceTimersByTime(1));
      expect(factory).toHaveBeenCalledTimes(index + 2);
    }
  });

  it('retries when creating the browser WebSocket throws', () => {
    const socket = new FakeSocket();
    const factory = vi
      .fn<(url: string) => BrowserSocket>()
      .mockImplementationOnce(() => {
        throw new Error('sensitive browser failure');
      })
      .mockReturnValue(socket);

    const { result } = renderHook(() =>
      useTerminalSocket(config, DYNAMIC_SESSION_ID, {
        socketFactory: factory,
      }),
    );

    expect(result.current.status).toBe('reconnecting');
    expect(result.current.error).toBe('Unable to open terminal connection.');
    act(() => vi.advanceTimersByTime(499));
    expect(factory).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1));
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('resets backoff after open/ready and reconnects immediately on command', () => {
    const { result, sockets, factory } = harness();
    act(() => sockets[0]!.temporaryClose());
    act(() => vi.advanceTimersByTime(500));
    act(() => {
      sockets[1]!.open();
      sockets[1]!.message(readyMessage());
      sockets[1]!.temporaryClose();
    });
    act(() => vi.advanceTimersByTime(499));
    expect(factory).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1));
    expect(factory).toHaveBeenCalledTimes(3);

    act(() => result.current.reconnect());
    expect(sockets[2]!.close).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(4);
    expect(result.current.status).toBe('connecting');
  });

  it('resets backoff as soon as a browser WebSocket opens', () => {
    const { sockets, factory } = harness();
    act(() => sockets[0]!.temporaryClose());
    act(() => vi.advanceTimersByTime(500));
    act(() => sockets[1]!.temporaryClose());
    act(() => vi.advanceTimersByTime(1_000));

    act(() => {
      sockets[2]!.open();
      sockets[2]!.temporaryClose();
    });
    act(() => vi.advanceTimersByTime(499));
    expect(factory).toHaveBeenCalledTimes(3);
    act(() => vi.advanceTimersByTime(1));
    expect(factory).toHaveBeenCalledTimes(4);
  });

  it('waits for manual reconnect after another browser replaces the bridge', () => {
    const { result, sockets, factory } = harness();
    act(() => {
      sockets[0]!.open();
      sockets[0]!.message(readyMessage());
      sockets[0]!.dispatchEvent(
        new CloseEvent('close', { code: 4001, reason: 'Session replaced' }),
      );
    });

    expect(result.current.status).toBe('disconnected');
    expect(result.current.error).toBe(
      'Terminal opened in another browser. Reconnect to take control.',
    );
    act(() => vi.runAllTimers());
    expect(factory).toHaveBeenCalledOnce();

    act(() => result.current.reconnect());
    expect(factory).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('connecting');
  });

  it('retries a bridge restart but waits after session stop or restart', () => {
    const onSessionStopped = vi.fn();
    const onSessionRestarting = vi.fn();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const { result } = renderHook(() =>
      useTerminalSocket(config, DYNAMIC_SESSION_ID, {
        socketFactory: factory,
        onSessionStopped,
        onSessionRestarting,
      }),
    );

    act(() =>
      sockets[0]!.dispatchEvent(new CloseEvent('close', { code: 4010 })),
    );
    expect(result.current.status).toBe('reconnecting');
    act(() => vi.advanceTimersByTime(500));
    expect(factory).toHaveBeenCalledTimes(2);

    act(() =>
      sockets[1]!.dispatchEvent(new CloseEvent('close', { code: 4011 })),
    );
    expect(result.current.status).toBe('disconnected');
    expect(onSessionStopped).toHaveBeenCalledOnce();
    act(() => vi.runAllTimers());
    expect(factory).toHaveBeenCalledTimes(2);

    act(() => result.current.reconnect());
    act(() =>
      sockets[2]!.dispatchEvent(new CloseEvent('close', { code: 4012 })),
    );
    expect(result.current.status).toBe('disconnected');
    expect(onSessionRestarting).toHaveBeenCalledOnce();
    act(() => vi.runAllTimers());
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('stops on unmount and ignores events from replaced sockets', () => {
    const { result, sockets, factory, unmount } = harness();
    act(() => result.current.reconnect());
    const active = sockets[1];

    act(() => {
      sockets[0]!.dispatchEvent(new Event('open'));
      sockets[0]!.message(readyMessage());
    });
    expect(result.current.status).toBe('connecting');

    unmount();
    expect(active!.close).toHaveBeenCalled();
    act(() => vi.runAllTimers());
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
