import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  Terminal as XtermTerminal,
  type ITerminalAddon,
  type ITerminalOptions,
} from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

import {
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  type ClientConfig,
} from '@flanterminal/shared';

import type { TerminalSocketController } from './useTerminalSocket.js';

export interface DisposableLike {
  dispose(): void;
}

export type TerminalAddonLike = DisposableLike;

export interface FitAddonLike extends TerminalAddonLike {
  fit(): void;
}

export interface TerminalLike extends DisposableLike {
  readonly cols: number;
  readonly rows: number;
  loadAddon(addon: TerminalAddonLike): void;
  open(element: HTMLElement): void;
  focus(): void;
  write(data: string): void;
  onData(listener: (data: string) => void): DisposableLike;
}

export interface ResizeObserverLike {
  observe(element: Element): void;
  disconnect(): void;
}

export interface TerminalDependencies {
  readonly terminalFactory: (options: ITerminalOptions) => TerminalLike;
  readonly fitAddonFactory: () => FitAddonLike;
  readonly webLinksAddonFactory: () => TerminalAddonLike;
  readonly resizeObserverFactory: (callback: () => void) => ResizeObserverLike;
  readonly scheduleInitialFit: (callback: () => void) => () => void;
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
}

const defaultDependencies: TerminalDependencies = {
  terminalFactory: (options) => {
    const terminal = new XtermTerminal(options);
    return {
      get cols() {
        return terminal.cols;
      },
      get rows() {
        return terminal.rows;
      },
      loadAddon: (addon) => terminal.loadAddon(addon as ITerminalAddon),
      open: (element) => terminal.open(element),
      focus: () => terminal.focus(),
      write: (data) => terminal.write(data),
      onData: (listener) => terminal.onData(listener),
      dispose: () => terminal.dispose(),
    };
  },
  fitAddonFactory: () => new FitAddon(),
  webLinksAddonFactory: () => new WebLinksAddon(),
  resizeObserverFactory: (callback) => new ResizeObserver(() => callback()),
  scheduleInitialFit: (callback) => {
    let cancelled = false;
    let frame: number | null = null;
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    void fontsReady.then(() => {
      if (cancelled) return;
      frame = requestAnimationFrame(callback);
    });
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  },
  setTimer: (callback, delay, ...args) => setTimeout(callback, delay, ...args),
  clearTimer: (timer) => clearTimeout(timer),
};

export interface TerminalProps {
  readonly config: ClientConfig;
  readonly socket: TerminalSocketController;
  readonly dependencies?: TerminalDependencies;
}

const FONT_FAMILY =
  "'JetBrainsMono Nerd Font', ui-monospace, 'Noto Sans Mono', 'Symbols Nerd Font', 'Noto Color Emoji', monospace";

export function Terminal({
  config,
  socket,
  dependencies = defaultDependencies,
}: TerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef(socket.status);
  const focusTerminalRef = useRef<() => void>(() => undefined);
  const syncResizeRef = useRef<(force: boolean) => void>(() => undefined);
  const cancelResizeRef = useRef<() => void>(() => undefined);
  const { sendInput, sendResize, subscribeOutput } = socket;

  useEffect(() => {
    statusRef.current = socket.status;
    if (socket.status === 'connected') {
      syncResizeRef.current(true);
    } else {
      cancelResizeRef.current();
    }
  }, [socket.status]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const terminal = dependencies.terminalFactory({
      allowTransparency: false,
      altClickMovesCursor: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: FONT_FAMILY,
      fontSize: config.fontSize,
      letterSpacing: 0,
      lineHeight: 1.2,
      rightClickSelectsWord: true,
      scrollback: config.scrollback,
    });
    const fitAddon = dependencies.fitAddonFactory();
    const webLinksAddon = dependencies.webLinksAddonFactory();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);
    focusTerminalRef.current = () => terminal.focus();

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDimensions: string | null = null;
    const cancelResize = () => {
      if (resizeTimer === null) return;
      dependencies.clearTimer(resizeTimer);
      resizeTimer = null;
    };
    const fitAndScheduleResize = (force = false) => {
      fitAddon.fit();
      cancelResize();
      if (statusRef.current !== 'connected') return;
      if (force) lastDimensions = null;
      resizeTimer = dependencies.setTimer(() => {
        resizeTimer = null;
        if (statusRef.current !== 'connected') return;
        if (
          terminal.cols < MIN_COLS ||
          terminal.cols > MAX_COLS ||
          terminal.rows < MIN_ROWS ||
          terminal.rows > MAX_ROWS
        ) {
          return;
        }
        const dimensions = `${terminal.cols}x${terminal.rows}`;
        if (dimensions === lastDimensions) return;
        if (sendResize(terminal.cols, terminal.rows)) {
          lastDimensions = dimensions;
        }
      }, config.resizeDebounceMs);
    };
    syncResizeRef.current = fitAndScheduleResize;
    cancelResizeRef.current = cancelResize;

    const observer = dependencies.resizeObserverFactory(fitAndScheduleResize);
    observer.observe(host);
    const cancelInitialFit = dependencies.scheduleInitialFit(() => {
      fitAndScheduleResize();
      terminal.focus();
    });
    const dataSubscription = terminal.onData((data) => {
      if (statusRef.current === 'connected') sendInput(data);
    });
    const outputSubscription = subscribeOutput((data) => {
      terminal.write(data);
    });

    return () => {
      observer.disconnect();
      cancelInitialFit();
      cancelResize();
      focusTerminalRef.current = () => undefined;
      syncResizeRef.current = () => undefined;
      cancelResizeRef.current = () => undefined;
      dataSubscription.dispose();
      outputSubscription();
      fitAddon.dispose();
      webLinksAddon.dispose();
      terminal.dispose();
    };
  }, [
    config.fontSize,
    config.resizeDebounceMs,
    config.scrollback,
    dependencies,
    sendInput,
    sendResize,
    subscribeOutput,
  ]);

  return (
    <div
      ref={hostRef}
      className="terminal-host"
      role="region"
      aria-label="Terminal"
      tabIndex={0}
      onFocus={(event) => {
        if (event.target === event.currentTarget) focusTerminalRef.current();
      }}
    />
  );
}
