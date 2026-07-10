import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  Terminal as XtermTerminal,
  type ITerminalAddon,
  type ITerminalOptions,
} from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

import type { ClientConfig } from '@flanterminal/shared';

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
  setTimer: setTimeout,
  clearTimer: clearTimeout,
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
  const { sendInput, sendResize, subscribeOutput } = socket;

  useEffect(() => {
    statusRef.current = socket.status;
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

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastDimensions: string | null = null;
    const fitAndScheduleResize = () => {
      fitAddon.fit();
      if (resizeTimer !== null) dependencies.clearTimer(resizeTimer);
      resizeTimer = dependencies.setTimer(() => {
        resizeTimer = null;
        const dimensions = `${terminal.cols}x${terminal.rows}`;
        if (dimensions === lastDimensions) return;
        if (sendResize(terminal.cols, terminal.rows)) {
          lastDimensions = dimensions;
        }
      }, config.resizeDebounceMs);
    };

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
      if (resizeTimer !== null) dependencies.clearTimer(resizeTimer);
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
    />
  );
}
