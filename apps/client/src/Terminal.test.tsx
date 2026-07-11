// @vitest-environment jsdom

import { FIXED_SESSION_ID, type ClientConfig } from '@flanterminal/shared';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './test/setup.js';

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn() }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn() }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: vi.fn() }));

import {
  Terminal,
  type TerminalDependencies,
  type TerminalLike,
} from './Terminal.js';
import type { TerminalSocketController } from './useTerminalSocket.js';

type Mutable<T> = { -readonly [Property in keyof T]: T[Property] };

const config: ClientConfig = {
  basePath: '/terminal',
  sessionId: FIXED_SESSION_ID,
  fontSize: 15,
  scrollback: 12_345,
  resizeDebounceMs: 75,
  reconnectMaxSeconds: 8,
};

class FakeTerminal implements TerminalLike {
  cols = 80;
  rows = 24;
  readonly loadAddon = vi.fn();
  readonly open = vi.fn();
  readonly focus = vi.fn();
  readonly write = vi.fn();
  readonly dispose = vi.fn();
  readonly dataListeners = new Set<(data: string) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  input(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
}

function setup(status: TerminalSocketController['status'] = 'connected') {
  const terminal = new FakeTerminal();
  const terminalFactory = vi.fn(() => terminal);
  const fitAddon = { fit: vi.fn(), dispose: vi.fn() };
  const webLinksAddon = { dispose: vi.fn() };
  let resizeCallback: () => void = () => undefined;
  const observer = {
    observe: vi.fn(),
    disconnect: vi.fn(),
  };
  const resizeObserverFactory = vi.fn((callback: () => void) => {
    resizeCallback = callback;
    return observer;
  });
  let initialFit: () => void = () => undefined;
  const scheduleInitialFit = vi.fn((callback: () => void) => {
    initialFit = callback;
    return vi.fn();
  });
  let outputListener: (data: string) => void = () => undefined;
  const unsubscribe = vi.fn();
  const socket: TerminalSocketController = {
    status,
    error: null,
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    sendInput: vi.fn(() => true),
    sendResize: vi.fn(() => true),
    subscribeOutput: vi.fn((listener) => {
      outputListener = listener;
      return unsubscribe;
    }),
  };
  const dependencies: TerminalDependencies = {
    terminalFactory,
    fitAddonFactory: () => fitAddon,
    webLinksAddonFactory: () => webLinksAddon,
    resizeObserverFactory,
    scheduleInitialFit,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
  };
  const view = render(
    <Terminal config={config} socket={socket} dependencies={dependencies} />,
  );
  return {
    ...view,
    dependencies,
    fitAddon,
    initialFit,
    observer,
    output: (data: string) => outputListener(data),
    resize: () => resizeCallback(),
    socket,
    terminal,
    terminalFactory,
    unsubscribe,
    webLinksAddon,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Terminal', () => {
  it('opens a configured real-terminal surface and loads both addons', () => {
    const {
      terminal,
      terminalFactory,
      fitAddon,
      webLinksAddon,
      getByLabelText,
    } = setup();

    expect(terminalFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        allowTransparency: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily:
          "'JetBrainsMono Nerd Font', ui-monospace, 'Noto Sans Mono', 'Symbols Nerd Font', 'Noto Color Emoji', monospace",
        fontSize: 15,
        letterSpacing: 0,
        lineHeight: 1.2,
        rightClickSelectsWord: true,
        scrollback: 12_345,
      }),
    );
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(1, fitAddon);
    expect(terminal.loadAddon).toHaveBeenNthCalledWith(2, webLinksAddon);
    expect(terminal.open).toHaveBeenCalledWith(getByLabelText('Terminal'));
  });

  it('writes only subscribed protocol output and sends input only when connected', () => {
    const connected = setup();
    act(() => connected.output('server output'));
    expect(connected.terminal.write).toHaveBeenCalledWith('server output');
    act(() => connected.terminal.input('typed'));
    expect(connected.socket.sendInput).toHaveBeenCalledWith('typed');

    const disconnected = setup('reconnecting');
    act(() => disconnected.terminal.input('do not replay'));
    expect(disconnected.socket.sendInput).not.toHaveBeenCalled();
  });

  it('fits after layout and observer changes, then debounces distinct dimensions', () => {
    const { initialFit, resize, fitAddon, socket, terminal } = setup();

    act(() => initialFit());
    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(75));
    expect(socket.sendResize).toHaveBeenCalledWith(80, 24);

    act(() => resize());
    act(() => vi.advanceTimersByTime(75));
    expect(socket.sendResize).toHaveBeenCalledTimes(1);

    terminal.cols = 100;
    terminal.rows = 35;
    act(() => resize());
    act(() => vi.advanceTimersByTime(74));
    expect(socket.sendResize).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(socket.sendResize).toHaveBeenLastCalledWith(100, 35);
  });

  it('sends valid dimensions after readiness and resends them after reconnect', () => {
    const result = setup('reconnecting');
    const mutableSocket = result.socket as Mutable<TerminalSocketController>;

    act(() => result.initialFit());
    act(() => vi.advanceTimersByTime(75));
    expect(result.socket.sendResize).not.toHaveBeenCalled();

    mutableSocket.status = 'connected';
    result.rerender(
      <Terminal
        config={config}
        socket={result.socket}
        dependencies={result.dependencies}
      />,
    );
    act(() => vi.advanceTimersByTime(75));
    expect(result.socket.sendResize).toHaveBeenLastCalledWith(80, 24);

    mutableSocket.status = 'reconnecting';
    result.rerender(
      <Terminal
        config={config}
        socket={result.socket}
        dependencies={result.dependencies}
      />,
    );
    mutableSocket.status = 'connected';
    result.rerender(
      <Terminal
        config={config}
        socket={result.socket}
        dependencies={result.dependencies}
      />,
    );
    act(() => vi.advanceTimersByTime(75));
    expect(result.socket.sendResize).toHaveBeenCalledTimes(2);
    expect(result.socket.sendResize).toHaveBeenLastCalledWith(80, 24);
  });

  it('does not send dimensions from a hidden or invalid terminal geometry', () => {
    const result = setup();
    result.terminal.cols = 1;
    result.terminal.rows = 1;

    act(() => result.initialFit());
    act(() => vi.advanceTimersByTime(75));

    expect(result.socket.sendResize).not.toHaveBeenCalled();
  });

  it('forwards focus from the accessible host to the xterm input', () => {
    const result = setup();

    act(() => result.getByLabelText('Terminal').focus());

    expect(result.terminal.focus).toHaveBeenCalled();
  });

  it('disposes observers, scheduling, subscriptions, addons and terminal', () => {
    const result = setup();
    const cancelInitialFit = result.dependencies
      .scheduleInitialFit as ReturnType<typeof vi.fn>;
    const cancel = cancelInitialFit.mock.results[0]!.value as ReturnType<
      typeof vi.fn
    >;

    result.unmount();

    expect(result.observer.disconnect).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(result.unsubscribe).toHaveBeenCalled();
    expect(result.fitAddon.dispose).toHaveBeenCalled();
    expect(result.webLinksAddon.dispose).toHaveBeenCalled();
    expect(result.terminal.dispose).toHaveBeenCalled();
  });
});
