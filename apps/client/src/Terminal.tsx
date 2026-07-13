import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  Terminal as XtermTerminal,
  type ITerminalAddon,
  type ITerminalOptions,
} from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import {
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  type ClientConfig,
  type WorkspaceSettings,
} from '@flanterminal/shared';

import { FONT_STACKS, themeFor } from './themes.js';
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
  clear(): void;
  write(data: string): void;
  onData(listener: (data: string) => void): DisposableLike;
  onBell(listener: () => void): DisposableLike;
}

export interface ResizeObserverLike {
  observe(element: Element): void;
  disconnect(): void;
}

export interface AudioLike {
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  load(): void;
}

export interface TerminalDependencies {
  readonly terminalFactory: (options: ITerminalOptions) => TerminalLike;
  readonly fitAddonFactory: () => FitAddonLike;
  readonly webLinksAddonFactory: () => TerminalAddonLike;
  readonly resizeObserverFactory: (callback: () => void) => ResizeObserverLike;
  readonly scheduleInitialFit: (callback: () => void) => () => void;
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
  readonly audioFactory: (url: string) => AudioLike;
  readonly now: () => number;
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
      clear: () => terminal.clear(),
      write: (data) => terminal.write(data),
      onData: (listener) => terminal.onData(listener),
      onBell: (listener) => terminal.onBell(listener),
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
  audioFactory: (url) => new Audio(url),
  now: () => performance.now(),
};

export interface TerminalProps {
  readonly config: ClientConfig;
  readonly settings: WorkspaceSettings;
  readonly socket: TerminalSocketController;
  readonly dependencies?: TerminalDependencies;
}

export interface TerminalHandle {
  focus(): void;
  clear(): void;
}

const BELL_URL = new URL('./assets/sounds/terminal-bell.wav', import.meta.url)
  .href;
const SOUND_BELL_MIN_INTERVAL_MS = 200;

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(
  function Terminal(
    { config, settings, socket, dependencies = defaultDependencies },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const statusRef = useRef(socket.status);
    const focusTerminalRef = useRef<() => void>(() => undefined);
    const clearTerminalRef = useRef<() => void>(() => undefined);
    const syncResizeRef = useRef<(force: boolean) => void>(() => undefined);
    const cancelResizeRef = useRef<() => void>(() => undefined);
    const { sendInput, sendResize, subscribeOutput } = socket;

    useImperativeHandle(
      ref,
      () => ({
        focus: () => focusTerminalRef.current(),
        clear: () => clearTerminalRef.current(),
      }),
      [],
    );

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
        cursorBlink: settings.cursorBlink,
        cursorStyle: settings.cursorStyle,
        fontFamily: FONT_STACKS[settings.fontFamily],
        fontSize: settings.fontSize,
        letterSpacing: settings.letterSpacing,
        lineHeight: settings.lineHeight,
        rightClickSelectsWord: true,
        scrollback: settings.scrollback,
        theme: themeFor(settings.theme).terminal,
      });
      const fitAddon = dependencies.fitAddonFactory();
      const webLinksAddon = dependencies.webLinksAddonFactory();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.open(host);
      focusTerminalRef.current = () => terminal.focus();
      clearTerminalRef.current = () => terminal.clear();

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
      const audio =
        settings.bellBehavior === 'sound'
          ? dependencies.audioFactory(BELL_URL)
          : null;
      let lastSoundBellAt = Number.NEGATIVE_INFINITY;
      let bellTimer: ReturnType<typeof setTimeout> | null = null;
      const bellSubscription = terminal.onBell(() => {
        if (settings.bellBehavior === 'none') return;
        if (audio !== null) {
          const now = dependencies.now();
          if (now - lastSoundBellAt < SOUND_BELL_MIN_INTERVAL_MS) return;
          lastSoundBellAt = now;
          audio.currentTime = 0;
          try {
            void audio.play().catch(() => undefined);
          } catch {
            // Browser media policies may reject or throw without affecting xterm.
          }
          return;
        }
        host.classList.add('is-belling');
        if (bellTimer !== null) dependencies.clearTimer(bellTimer);
        bellTimer = dependencies.setTimer(() => {
          bellTimer = null;
          host.classList.remove('is-belling');
        }, 140);
      });

      return () => {
        observer.disconnect();
        cancelInitialFit();
        cancelResize();
        focusTerminalRef.current = () => undefined;
        clearTerminalRef.current = () => undefined;
        syncResizeRef.current = () => undefined;
        cancelResizeRef.current = () => undefined;
        dataSubscription.dispose();
        outputSubscription();
        bellSubscription.dispose();
        if (bellTimer !== null) dependencies.clearTimer(bellTimer);
        host.classList.remove('is-belling');
        if (audio !== null) {
          audio.pause();
          audio.currentTime = 0;
          audio.removeAttribute('src');
          audio.load();
        }
        fitAddon.dispose();
        webLinksAddon.dispose();
        terminal.dispose();
      };
    }, [
      config.resizeDebounceMs,
      dependencies,
      settings.bellBehavior,
      settings.cursorBlink,
      settings.cursorStyle,
      settings.fontFamily,
      settings.fontSize,
      settings.letterSpacing,
      settings.lineHeight,
      settings.scrollback,
      settings.theme,
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
  },
);
