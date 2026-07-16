// @vitest-environment jsdom

import {
  MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  type ClientConfig,
  type WorkspaceSettings,
} from '@flanterminal/shared';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
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
  resizeDebounceMs: 75,
  reconnectMaxSeconds: 8,
};
const settings: WorkspaceSettings = {
  version: 1,
  fontFamily: 'jetbrains-mono-nerd',
  fontSize: 15,
  lineHeight: 1.2,
  letterSpacing: 0,
  scrollback: 12_345,
  theme: 'dark',
  cursorStyle: 'block',
  cursorBlink: true,
  bellBehavior: 'visual',
  reconnectBehavior: 'automatic',
  automaticTabCreation: true,
  workspaceShortcuts: 'default',
  defaultShell: '/bin/bash',
  tmuxHistoryLimit: 20_000,
  staleSessionCleanupHours: 0,
  customTerminalPalette: MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
};

class FakeTerminal implements TerminalLike {
  cols = 80;
  rows = 24;
  selection = '';
  readonly loadAddon = vi.fn();
  readonly open = vi.fn();
  readonly focus = vi.fn();
  readonly clear = vi.fn();
  readonly write = vi.fn();
  readonly scrollLines = vi.fn();
  readonly dispose = vi.fn();
  readonly dataListeners = new Set<(data: string) => void>();
  readonly bellListeners = new Set<() => void>();
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  wheelHandler: ((event: WheelEvent) => boolean) | undefined;

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onBell(listener: () => void) {
    this.bellListeners.add(listener);
    return { dispose: () => this.bellListeners.delete(listener) };
  }
  hasSelection() {
    return this.selection.length > 0;
  }
  getSelection() {
    return this.selection;
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
    this.wheelHandler = handler;
  }
  bell() {
    for (const listener of this.bellListeners) listener();
  }

  input(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  key(event: KeyboardEvent) {
    return this.keyHandler?.(event) ?? true;
  }
  wheel(event: WheelEvent) {
    return this.wheelHandler?.(event) ?? true;
  }
  forwardAcceptedControlC(event: KeyboardEvent) {
    const accepted = this.key(event);
    if (accepted) this.input('\x03');
    return accepted;
  }
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  'clipboard',
);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  navigator,
  'platform',
);

function setClipboard(writeText = vi.fn(async () => undefined)) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function setPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: platform,
  });
}

function restoreNavigatorProperty(
  property: 'clipboard' | 'platform',
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor === undefined) {
    delete (navigator as unknown as Record<string, unknown>)[property];
  } else {
    Object.defineProperty(navigator, property, descriptor);
  }
}

function keyEvent(init: KeyboardEventInit) {
  return new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'c',
    ...init,
  });
}

function wheelEvent(init: WheelEventInit) {
  return new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function setup(
  status: TerminalSocketController['status'] = 'connected',
  overrides: Partial<WorkspaceSettings> = {},
  dependencyOverrides: Partial<TerminalDependencies> = {},
) {
  const terminals: FakeTerminal[] = [];
  const terminalFactory = vi.fn(() => {
    const terminal = new FakeTerminal();
    terminals.push(terminal);
    return terminal;
  });
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
    audioFactory: vi.fn(() => fakeAudio()),
    now: () => performance.now(),
    ...dependencyOverrides,
  };
  const effectiveSettings = { ...settings, ...overrides };
  const view = render(
    <Terminal
      config={config}
      settings={effectiveSettings}
      socket={socket}
      dependencies={dependencies}
    />,
  );
  const terminal = terminals[0]!;
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
    terminals,
    terminalFactory,
    unsubscribe,
    webLinksAddon,
    settings: effectiveSettings,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  restoreNavigatorProperty('clipboard', originalClipboardDescriptor);
  restoreNavigatorProperty('platform', originalPlatformDescriptor);
  vi.useRealTimers();
});

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
        theme: expect.objectContaining({
          background: '#101112',
          foreground: '#dddcd7',
        }),
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

  it('captures signed fractional line wheels locally and scrolls only whole lines', () => {
    const result = setup();
    const first = wheelEvent({
      deltaY: 0.6,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    const second = wheelEvent({
      deltaY: 0.6,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    const negative = wheelEvent({
      deltaY: -1.7,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });

    expect(result.terminal.wheel(first)).toBe(false);
    expect(first.defaultPrevented).toBe(true);
    expect(result.terminal.scrollLines).not.toHaveBeenCalled();
    expect(result.terminal.wheel(second)).toBe(false);
    expect(second.defaultPrevented).toBe(true);
    expect(result.terminal.scrollLines).toHaveBeenNthCalledWith(1, 1);
    expect(result.terminal.wheel(negative)).toBe(false);
    expect(negative.defaultPrevented).toBe(true);
    expect(result.terminal.scrollLines).toHaveBeenNthCalledWith(2, -1);
    expect(result.socket.sendInput).not.toHaveBeenCalled();
  });

  it('converts page wheels to rows minus one with a one-row minimum', () => {
    const result = setup();
    result.terminal.rows = 5;

    result.terminal.wheel(
      wheelEvent({ deltaY: 0.5, deltaMode: WheelEvent.DOM_DELTA_PAGE }),
    );
    expect(result.terminal.scrollLines).toHaveBeenCalledWith(2);

    result.terminal.rows = 1;
    result.terminal.wheel(
      wheelEvent({ deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE }),
    );
    expect(result.terminal.scrollLines).toHaveBeenLastCalledWith(1);
  });

  it('converts pixel wheels using rendered row height', () => {
    const rendered = setup();
    const rows = document.createElement('div');
    rows.className = 'xterm-rows';
    const row = document.createElement('div');
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      height: 20,
    } as DOMRect);
    rows.append(row);
    rendered.getByLabelText('Terminal').append(rows);

    rendered.terminal.wheel(
      wheelEvent({ deltaY: 40, deltaMode: WheelEvent.DOM_DELTA_PIXEL }),
    );
    expect(rendered.terminal.scrollLines).toHaveBeenCalledWith(2);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to settings row height for invalid rendered height %s',
    (renderedHeight) => {
      const fallback = setup('connected', { fontSize: 10, lineHeight: 1.5 });
      const rows = document.createElement('div');
      rows.className = 'xterm-rows';
      const row = document.createElement('div');
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
        height: renderedHeight,
      } as DOMRect);
      rows.append(row);
      fallback.getByLabelText('Terminal').append(rows);

      fallback.terminal.wheel(
        wheelEvent({ deltaY: 30, deltaMode: WheelEvent.DOM_DELTA_PIXEL }),
      );
      expect(fallback.terminal.scrollLines).toHaveBeenCalledWith(2);
    },
  );

  it('retains pixel-mode fractions and resets them on direction changes', () => {
    const fallback = setup('connected', { fontSize: 10, lineHeight: 1.5 });

    fallback.terminal.wheel(
      wheelEvent({ deltaY: 9, deltaMode: WheelEvent.DOM_DELTA_PIXEL }),
    );
    fallback.terminal.wheel(
      wheelEvent({ deltaY: 9, deltaMode: WheelEvent.DOM_DELTA_PIXEL }),
    );
    expect(fallback.terminal.scrollLines).toHaveBeenNthCalledWith(1, 1);

    fallback.terminal.wheel(
      wheelEvent({ deltaY: -9, deltaMode: WheelEvent.DOM_DELTA_PIXEL }),
    );
    expect(fallback.terminal.scrollLines).toHaveBeenCalledTimes(1);
    fallback.terminal.wheel(
      wheelEvent({ deltaY: -9, deltaMode: WheelEvent.DOM_DELTA_PIXEL }),
    );
    expect(fallback.terminal.scrollLines).toHaveBeenNthCalledWith(2, -1);
  });

  it('retains same-direction fractions and resets them on direction changes', () => {
    const result = setup();

    result.terminal.wheel(
      wheelEvent({ deltaY: 1.6, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    );
    result.terminal.wheel(
      wheelEvent({ deltaY: 0.5, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    );
    expect(result.terminal.scrollLines).toHaveBeenNthCalledWith(1, 1);
    expect(result.terminal.scrollLines).toHaveBeenNthCalledWith(2, 1);

    result.terminal.wheel(
      wheelEvent({ deltaY: -0.6, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    );
    expect(result.terminal.scrollLines).toHaveBeenCalledTimes(2);
    result.terminal.wheel(
      wheelEvent({ deltaY: -0.5, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    );
    expect(result.terminal.scrollLines).toHaveBeenNthCalledWith(3, -1);
  });

  it.each([
    ['Ctrl', { ctrlKey: true, deltaY: 1 }],
    ['Meta', { metaKey: true, deltaY: 1 }],
    ['Shift', { shiftKey: true, deltaY: 1 }],
    ['Alt', { altKey: true, deltaY: 1 }],
    ['zero vertical', { deltaY: 0 }],
    ['horizontal', { deltaX: 1, deltaY: 1 }],
  ])('delegates %s wheel gestures and resets the fraction', (_name, init) => {
    const result = setup();
    result.terminal.wheel(
      wheelEvent({ deltaY: 0.6, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    );
    const delegated = wheelEvent({
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      ...init,
    });

    expect(result.terminal.wheel(delegated)).toBe(true);
    expect(delegated.defaultPrevented).toBe(false);
    result.terminal.wheel(
      wheelEvent({ deltaY: 0.5, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    );
    expect(result.terminal.scrollLines).not.toHaveBeenCalled();
  });

  it('installs a fresh wheel handler when settings recreate the terminal', () => {
    const result = setup();
    result.terminal.wheel(
      wheelEvent({ deltaY: 0.6, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    );

    result.rerender(
      <Terminal
        config={config}
        settings={{ ...result.settings, fontSize: 16 }}
        socket={result.socket}
        dependencies={result.dependencies}
      />,
    );
    const replacement = result.terminals[1]!;
    expect(replacement.wheelHandler).toBeDefined();
    expect(replacement.wheelHandler).not.toBe(result.terminal.wheelHandler);
    replacement.wheel(
      wheelEvent({ deltaY: 0.5, deltaMode: WheelEvent.DOM_DELTA_LINE }),
    );
    expect(replacement.scrollLines).not.toHaveBeenCalled();
  });

  it.each([
    ['Windows', 'Win32'],
    ['Linux', 'Linux x86_64'],
  ])('copies selected text for Ctrl+C on %s', (_name, platform) => {
    const clipboardWrite = setClipboard();
    setPlatform(platform);
    const result = setup();
    result.terminal.selection = 'copied terminal output';
    const event = keyEvent({ ctrlKey: true });

    const accepted = result.terminal.key(event);

    expect(clipboardWrite).toHaveBeenCalledWith('copied terminal output');
    expect(event.defaultPrevented).toBe(true);
    expect(accepted).toBe(false);
  });

  it('copies selected text for Cmd+C on macOS', () => {
    const clipboardWrite = setClipboard();
    setPlatform('MacIntel');
    const result = setup();
    result.terminal.selection = 'copied terminal output';
    const event = keyEvent({ metaKey: true });

    const accepted = result.terminal.key(event);

    expect(clipboardWrite).toHaveBeenCalledWith('copied terminal output');
    expect(event.defaultPrevented).toBe(true);
    expect(accepted).toBe(false);
  });

  it('passes selected Ctrl+C through on macOS', () => {
    const clipboardWrite = setClipboard();
    setPlatform('MacIntel');
    const result = setup();
    result.terminal.selection = 'copied terminal output';
    const event = keyEvent({ ctrlKey: true });

    const accepted = result.terminal.forwardAcceptedControlC(event);

    expect(accepted).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(result.socket.sendInput).toHaveBeenCalledWith('\x03');
  });

  it.each([
    ['Windows', 'Win32'],
    ['Linux', 'Linux x86_64'],
    ['macOS', 'MacIntel'],
  ])('forwards unselected Ctrl+C on %s', (_name, platform) => {
    const clipboardWrite = setClipboard();
    setPlatform(platform);
    const result = setup();
    const event = keyEvent({ ctrlKey: true });

    const accepted = result.terminal.forwardAcceptedControlC(event);

    expect(accepted).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(result.socket.sendInput).toHaveBeenCalledWith('\x03');
  });

  it('cancels unselected Cmd+C on macOS without copying or terminal input', () => {
    const clipboardWrite = setClipboard();
    setPlatform('MacIntel');
    const result = setup();
    const event = keyEvent({ metaKey: true });

    const accepted = result.terminal.key(event);

    expect(accepted).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(result.socket.sendInput).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects', vi.fn(async () => Promise.reject(new Error('denied')))],
    [
      'throws synchronously',
      vi.fn(() => {
        throw new Error('denied');
      }),
    ],
  ])(
    'cancels selected copy when clipboard write %s',
    async (_outcome, writeText) => {
      setClipboard(writeText);
      setPlatform('Win32');
      const result = setup();
      result.terminal.selection = 'copied terminal output';
      const event = keyEvent({ ctrlKey: true });

      expect(() => result.terminal.key(event)).not.toThrow();
      await act(async () => Promise.resolve());
      expect(writeText).toHaveBeenCalledWith('copied terminal output');
      expect(event.defaultPrevented).toBe(true);
      expect(result.socket.sendInput).not.toHaveBeenCalled();
    },
  );

  it('cancels selected copy when the clipboard is unavailable', () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    setPlatform('Win32');
    const result = setup();
    result.terminal.selection = 'copied terminal output';
    const event = keyEvent({ ctrlKey: true });

    expect(() => result.terminal.key(event)).not.toThrow();
    expect(event.defaultPrevented).toBe(true);
    expect(result.socket.sendInput).not.toHaveBeenCalled();
  });

  it.each([
    ['Alt+C', 'Win32', { altKey: true }],
    ['Ctrl+Shift+C', 'Win32', { ctrlKey: true, shiftKey: true }],
    ['Cmd+Ctrl+C', 'MacIntel', { ctrlKey: true, metaKey: true }],
    ['Cmd+Shift+C', 'MacIntel', { metaKey: true, shiftKey: true }],
  ])('does not intercept altered shortcut %s', (_name, platform, init) => {
    const clipboardWrite = setClipboard();
    setPlatform(platform);
    const result = setup();
    result.terminal.selection = 'copied terminal output';
    const event = keyEvent(init);

    const accepted = result.terminal.key(event);

    expect(accepted).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('prevents the browser context menu without changing right-click word selection', () => {
    const { getByLabelText, terminalFactory } = setup();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });

    getByLabelText('Terminal').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(terminalFactory).toHaveBeenCalledWith(
      expect.objectContaining({ rightClickSelectsWord: true }),
    );
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
        settings={result.settings}
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
        settings={result.settings}
        socket={result.socket}
        dependencies={result.dependencies}
      />,
    );
    mutableSocket.status = 'connected';
    result.rerender(
      <Terminal
        config={config}
        settings={result.settings}
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

  it('exposes focus and clear commands without recreating xterm', () => {
    const terminal = new FakeTerminal();
    const ref = createRef<{ focus(): void; clear(): void }>();
    const result = setup();
    result.unmount();
    const terminalFactory = vi.fn(() => terminal);
    const dependencies = { ...result.dependencies, terminalFactory };

    render(
      <Terminal
        ref={ref}
        config={config}
        settings={settings}
        socket={result.socket}
        dependencies={dependencies}
      />,
    );
    act(() => ref.current?.focus());
    act(() => ref.current?.clear());

    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(terminal.clear).toHaveBeenCalledOnce();
    expect(terminalFactory).toHaveBeenCalledOnce();
  });

  it('applies every constructor preference and recreates xterm without reconnecting the socket', () => {
    const result = setup('connected', {
      fontFamily: 'system-monospace',
      fontSize: 18,
      lineHeight: 1.4,
      letterSpacing: 2,
      scrollback: 4_000,
      theme: 'ubuntu',
      cursorStyle: 'bar',
      cursorBlink: false,
      bellBehavior: 'none',
    });
    expect(result.terminalFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        fontFamily: expect.stringContaining('ui-monospace'),
        fontSize: 18,
        lineHeight: 1.4,
        letterSpacing: 2,
        scrollback: 4_000,
        cursorStyle: 'bar',
        cursorBlink: false,
        theme: expect.objectContaining({ background: '#300a24' }),
      }),
    );
    result.rerender(
      <Terminal
        config={config}
        settings={{ ...result.settings, fontSize: 19 }}
        socket={result.socket}
        dependencies={result.dependencies}
      />,
    );
    expect(result.terminal.dispose).toHaveBeenCalledOnce();
    expect(result.terminalFactory).toHaveBeenCalledTimes(2);
    expect(result.terminals[1]).not.toBe(result.terminal);
    expect(result.socket.disconnect).not.toHaveBeenCalled();
    expect(result.socket.reconnect).not.toHaveBeenCalled();
  });

  it('applies changed custom terminal palettes by recreating xterm', () => {
    const palette = {
      ...MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
      background: '#123456',
      foreground: '#ABCDEF',
      cursor: '#FEDCBA',
      selectionBackground: '#654321',
      black: '#111111',
      red: '#110000',
      green: '#001100',
      yellow: '#111100',
      blue: '#000011',
      magenta: '#110011',
      cyan: '#001111',
      white: '#EEEEEE',
    };
    const result = setup('connected', {
      theme: 'custom',
      customTerminalPalette: palette,
    });

    expect(result.terminalFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({
          background: '#123456',
          foreground: '#ABCDEF',
          cursor: '#FEDCBA',
          selectionBackground: '#654321',
          black: '#111111',
          red: '#110000',
          green: '#001100',
          yellow: '#111100',
          blue: '#000011',
          magenta: '#110011',
          cyan: '#001111',
          white: '#EEEEEE',
        }),
      }),
    );

    const replacementPalette = { ...palette, background: '#A1B2C3' };
    result.rerender(
      <Terminal
        config={config}
        settings={{
          ...result.settings,
          customTerminalPalette: replacementPalette,
        }}
        socket={result.socket}
        dependencies={result.dependencies}
      />,
    );

    expect(result.terminal.dispose).toHaveBeenCalledOnce();
    expect(result.terminals[1]).not.toBe(result.terminal);
    expect(result.terminalFactory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        theme: expect.objectContaining({ background: '#A1B2C3' }),
      }),
    );
  });

  it('preserves xterm for value-equivalent custom palettes from fresh settings', () => {
    const palette = { ...MIDNIGHT_ELECTRIC_TERMINAL_PALETTE };
    const result = setup('connected', {
      theme: 'custom',
      customTerminalPalette: palette,
    });

    act(() => result.output('buffer contents'));
    result.rerender(
      <Terminal
        config={config}
        settings={{
          ...result.settings,
          staleSessionCleanupHours: 24,
          customTerminalPalette: { ...palette },
        }}
        socket={result.socket}
        dependencies={result.dependencies}
      />,
    );

    expect(result.terminalFactory).toHaveBeenCalledOnce();
    expect(result.terminals).toEqual([result.terminal]);
    expect(result.terminal.dispose).not.toHaveBeenCalled();
    expect(result.terminal.write).toHaveBeenCalledWith('buffer contents');
  });

  it('uses only the local bell asset and never stores bell or output data', async () => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const sound = setup('connected', { bellBehavior: 'sound' });
    act(() => sound.terminal.bell());
    const bellUrl = vi.mocked(sound.dependencies.audioFactory).mock
      .calls[0]![0];
    expect(new URL(bellUrl, window.location.href).origin).toBe(
      window.location.origin,
    );
    expect(new URL(bellUrl, window.location.href).pathname).toMatch(
      /terminal-bell\.wav$/,
    );
    const visual = setup('connected', { bellBehavior: 'visual' });
    act(() => visual.terminal.bell());
    expect(visual.container.querySelector('.terminal-host')).toHaveClass(
      'is-belling',
    );
    act(() => vi.advanceTimersByTime(140));
    expect(visual.container.querySelector('.terminal-host')).not.toHaveClass(
      'is-belling',
    );
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });

  it('reuses one audio resource and throttles bursty bells with an injected clock', () => {
    let now = 1_000;
    const audio = fakeAudio();
    const audioFactory = vi.fn(() => audio);
    const sound = setup('connected', { bellBehavior: 'sound' }, {
      audioFactory,
      now: () => now,
    } as Partial<TerminalDependencies>);

    act(() => {
      sound.terminal.bell();
      sound.terminal.bell();
      sound.terminal.bell();
    });
    expect(audioFactory).toHaveBeenCalledOnce();
    expect(audio.play).toHaveBeenCalledOnce();

    now += 199;
    act(() => sound.terminal.bell());
    expect(audio.play).toHaveBeenCalledOnce();
    now += 1;
    act(() => sound.terminal.bell());
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audioFactory).toHaveBeenCalledOnce();
  });

  it('contains rejected audio playback and releases audio on recreation and unmount', async () => {
    const first = fakeAudio();
    first.play.mockRejectedValueOnce(
      new DOMException('blocked', 'NotAllowedError'),
    );
    const second = fakeAudio();
    const audioFactory = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const sound = setup('connected', { bellBehavior: 'sound' }, {
      audioFactory,
      now: () => 1_000,
    } as Partial<TerminalDependencies>);

    act(() => sound.terminal.bell());
    await act(async () => Promise.resolve());

    sound.rerender(
      <Terminal
        config={config}
        settings={{ ...sound.settings, fontSize: 16 }}
        socket={sound.socket}
        dependencies={sound.dependencies}
      />,
    );
    expect(first.pause).toHaveBeenCalledOnce();
    expect(first.currentTime).toBe(0);
    expect(first.removeAttribute).toHaveBeenCalledWith('src');
    expect(first.load).toHaveBeenCalledOnce();
    expect(audioFactory).toHaveBeenCalledTimes(2);

    sound.unmount();
    expect(second.pause).toHaveBeenCalledOnce();
    expect(second.currentTime).toBe(0);
    expect(second.removeAttribute).toHaveBeenCalledWith('src');
    expect(second.load).toHaveBeenCalledOnce();
  });

  it('does not allocate audio for visual bells and preserves their timer behavior', () => {
    const audioFactory = vi.fn(() => fakeAudio());
    const visual = setup(
      'connected',
      { bellBehavior: 'visual' },
      { audioFactory },
    );

    act(() => {
      visual.terminal.bell();
      visual.terminal.bell();
    });
    expect(audioFactory).not.toHaveBeenCalled();
    expect(visual.container.querySelector('.terminal-host')).toHaveClass(
      'is-belling',
    );
    act(() => vi.advanceTimersByTime(140));
    expect(visual.container.querySelector('.terminal-host')).not.toHaveClass(
      'is-belling',
    );
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

function fakeAudio() {
  return {
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    currentTime: 27,
    removeAttribute: vi.fn(),
    load: vi.fn(),
  };
}
