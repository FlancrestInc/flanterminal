// @vitest-environment jsdom

import type { ClientConfig, WorkspaceSettings } from '@flanterminal/shared';
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
  readonly dispose = vi.fn();
  readonly dataListeners = new Set<(data: string) => void>();
  readonly bellListeners = new Set<() => void>();
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;

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
  bell() {
    for (const listener of this.bellListeners) listener();
  }

  input(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  key(event: KeyboardEvent) {
    return this.keyHandler?.(event) ?? true;
  }
  controlC(event: KeyboardEvent) {
    const accepted = this.key(event);
    if (accepted) this.input('\x03');
    return accepted;
  }
}

function keyEvent(modifiers: KeyboardEventInit = {}) {
  return new KeyboardEvent('keydown', {
    key: 'c',
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
}

function setPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: platform,
  });
}

function setup(
  status: TerminalSocketController['status'] = 'connected',
  overrides: Partial<WorkspaceSettings> = {},
  dependencyOverrides: Partial<TerminalDependencies> = {},
) {
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
    settings: effectiveSettings,
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

  it('copies selected terminal output with Ctrl+C on Windows and Linux', () => {
    setPlatform('Win32');
    const clipboardWrite = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const { terminal } = setup();
    terminal.selection = 'copied terminal output';
    const event = keyEvent({ ctrlKey: true });

    expect(terminal.key(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardWrite).toHaveBeenCalledWith('copied terminal output');
  });

  it('copies selected terminal output with Cmd+C on macOS', () => {
    setPlatform('MacIntel');
    const clipboardWrite = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const { terminal } = setup();
    terminal.selection = 'copied terminal output';
    const event = keyEvent({ metaKey: true });

    expect(terminal.key(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardWrite).toHaveBeenCalledWith('copied terminal output');
  });

  it.each([
    () => Promise.reject(new Error('permission denied')),
    () => {
      throw new Error('clipboard unavailable');
    },
  ])('keeps selected copy canceled when clipboard write fails', (writeText) => {
    setPlatform('Linux x86_64');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(writeText) },
    });
    const { terminal } = setup();
    terminal.selection = 'copied terminal output';
    const event = keyEvent({ ctrlKey: true });

    expect(terminal.key(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps selected copy canceled when the clipboard API is unavailable', () => {
    setPlatform('Linux x86_64');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const { terminal } = setup();
    terminal.selection = 'copied terminal output';
    const event = keyEvent({ ctrlKey: true });

    expect(terminal.key(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it('forwards unselected Ctrl+C through xterm to the socket', () => {
    setPlatform('Linux x86_64');
    const { terminal, socket } = setup();
    const event = keyEvent({ ctrlKey: true });

    expect(terminal.controlC(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(socket.sendInput).toHaveBeenCalledWith('\x03');
  });

  it('forwards Ctrl+C, but only copies Cmd+C, when macOS text is selected', () => {
    setPlatform('MacIntel');
    const clipboardWrite = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const { terminal, socket } = setup();
    terminal.selection = 'copied terminal output';
    const controlEvent = keyEvent({ ctrlKey: true });
    const commandEvent = keyEvent({ metaKey: true });

    expect(terminal.controlC(controlEvent)).toBe(true);
    expect(controlEvent.defaultPrevented).toBe(false);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(socket.sendInput).toHaveBeenCalledWith('\x03');
    expect(terminal.key(commandEvent)).toBe(false);
    expect(commandEvent.defaultPrevented).toBe(true);
    expect(clipboardWrite).toHaveBeenCalledWith('copied terminal output');
  });

  it('does not intercept unselected or altered copy shortcuts', () => {
    setPlatform('MacIntel');
    const clipboardWrite = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const { terminal } = setup();
    terminal.selection = 'copied terminal output';
    const altered = [
      keyEvent({ metaKey: true, altKey: true }),
      keyEvent({ metaKey: true, shiftKey: true }),
      keyEvent({ metaKey: true, ctrlKey: true }),
    ];

    for (const event of altered) {
      expect(terminal.key(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
    terminal.selection = '';
    const commandEvent = keyEvent({ metaKey: true });
    expect(terminal.key(commandEvent)).toBe(true);
    expect(commandEvent.defaultPrevented).toBe(false);
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
    expect(result.socket.disconnect).not.toHaveBeenCalled();
    expect(result.socket.reconnect).not.toHaveBeenCalled();
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
