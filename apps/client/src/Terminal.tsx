import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import {
  Terminal as XtermTerminal,
  type ITerminalAddon,
  type ITerminalOptions,
} from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  terminalPaletteKeys,
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
  readonly hasScrollback: boolean;
  loadAddon(addon: TerminalAddonLike): void;
  open(element: HTMLElement): void;
  hasSelection(): boolean;
  getSelection(): string;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void;
  scrollLines(amount: number): void;
  focus(): void;
  clear(): void;
  write(data: string): void;
  hasSelection(): boolean;
  getSelection(): string;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
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
      get hasScrollback() {
        return terminal.buffer.active.baseY > 0;
      },
      loadAddon: (addon) => terminal.loadAddon(addon as ITerminalAddon),
      open: (element) => terminal.open(element),
      hasSelection: () => terminal.hasSelection(),
      getSelection: () => terminal.getSelection(),
      attachCustomKeyEventHandler: (handler) =>
        terminal.attachCustomKeyEventHandler(handler),
      attachCustomWheelEventHandler: (handler) =>
        terminal.attachCustomWheelEventHandler(handler),
      scrollLines: (amount) => terminal.scrollLines(amount),
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
const PALETTE_SIGNATURE_SEPARATOR = '\0';

function customPaletteSignature(
  palette: WorkspaceSettings['customTerminalPalette'],
) {
  return terminalPaletteKeys
    .map((key) => palette[key])
    .join(PALETTE_SIGNATURE_SEPARATOR);
}

function customPaletteFromSignature(
  signature: string,
): WorkspaceSettings['customTerminalPalette'] {
  const colors = signature.split(PALETTE_SIGNATURE_SEPARATOR);
  return Object.fromEntries(
    terminalPaletteKeys.map((key, index) => [key, colors[index]!]),
  ) as WorkspaceSettings['customTerminalPalette'];
}

function isCopyShortcut(event: KeyboardEvent) {
  if (
    event.key.toLowerCase() !== 'c' ||
    event.altKey ||
    event.shiftKey ||
    (event.ctrlKey && event.metaKey)
  ) {
    return false;
  }
  const isMac = navigator.platform.startsWith('Mac');
  return isMac ? event.metaKey : event.ctrlKey;
}

function copySelection(text: string, onSuccess: () => void) {
  try {
    void navigator.clipboard
      ?.writeText(text)
      ?.then(onSuccess)
      .catch(() => undefined);
  } catch {
    // Clipboard permissions and browser support must not affect terminal input.
  }
}

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
    const [copyStatusVisible, setCopyStatusVisible] = useState(false);
    const { sendInput, sendResize, subscribeOutput } = socket;
    const selectedTheme = settings.theme;
    const terminalThemeSignature =
      selectedTheme === 'custom'
        ? customPaletteSignature(settings.customTerminalPalette)
        : selectedTheme;
    const terminalTheme = useMemo(
      () =>
        selectedTheme === 'custom'
          ? customPaletteFromSignature(terminalThemeSignature)
          : themeFor(selectedTheme).terminal,
      [selectedTheme, terminalThemeSignature],
    );

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
        macOptionClickForcesSelection: true,
        rightClickSelectsWord: true,
        scrollback: settings.scrollback,
        theme: terminalTheme,
      });
      const fitAddon = dependencies.fitAddonFactory();
      const webLinksAddon = dependencies.webLinksAddonFactory();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      let copyStatusTimer: ReturnType<typeof setTimeout> | null = null;
      let isActive = true;
      const showCopyStatus = () => {
        if (!isActive) return;
        setCopyStatusVisible(true);
        if (copyStatusTimer !== null) dependencies.clearTimer(copyStatusTimer);
        copyStatusTimer = dependencies.setTimer(() => {
          copyStatusTimer = null;
          if (isActive) setCopyStatusVisible(false);
        }, 1_800);
      };
      const forceOrdinarySelection = (event: MouseEvent) => {
        if (
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        const target = event.target;
        if (!(target instanceof Element)) return;
        const screen = target.closest('.xterm-screen');
        if (screen === null || !host.contains(screen)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const isMac = navigator.platform.startsWith('Mac');
        target.dispatchEvent(
          new MouseEvent(event.type, {
            bubbles: true,
            cancelable: true,
            detail: event.detail,
            screenX: event.screenX,
            screenY: event.screenY,
            clientX: event.clientX,
            clientY: event.clientY,
            button: event.button,
            buttons: event.buttons,
            relatedTarget: event.relatedTarget,
            altKey: isMac,
            shiftKey: !isMac,
          }),
        );
      };
      host.addEventListener('mousedown', forceOrdinarySelection, true);
      const copyCompletedSelection = (event: MouseEvent) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const screen = target.closest('.xterm-screen');
        if (screen === null || !host.contains(screen)) return;
        const selection = terminal.getSelection();
        if (selection.length === 0) return;
        copySelection(selection, showCopyStatus);
      };
      host.addEventListener('mouseup', copyCompletedSelection, true);
      terminal.open(host);
      let wheelLineRemainder = 0;
      terminal.attachCustomWheelEventHandler((event) => {
        if (
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey ||
          event.deltaY === 0 ||
          Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
          !terminal.hasScrollback
        ) {
          wheelLineRemainder = 0;
          return true;
        }

        let deltaLines: number;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
          deltaLines = event.deltaY;
        } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
          deltaLines = event.deltaY * Math.max(terminal.rows - 1, 1);
        } else {
          const renderedRowHeight = host
            .querySelector<HTMLElement>('.xterm-rows > div')
            ?.getBoundingClientRect().height;
          const rowHeight =
            renderedRowHeight !== undefined &&
            Number.isFinite(renderedRowHeight) &&
            renderedRowHeight > 0
              ? renderedRowHeight
              : settings.fontSize * settings.lineHeight;
          deltaLines = event.deltaY / rowHeight;
        }

        if (
          wheelLineRemainder !== 0 &&
          Math.sign(deltaLines) !== Math.sign(wheelLineRemainder)
        ) {
          wheelLineRemainder = 0;
        }
        wheelLineRemainder += deltaLines;
        const wholeLines = Math.trunc(wheelLineRemainder);
        wheelLineRemainder -= wholeLines;
        if (wholeLines !== 0) terminal.scrollLines(wholeLines);
        event.preventDefault();
        return false;
      });
      terminal.attachCustomKeyEventHandler((event) => {
        if (!isCopyShortcut(event)) return true;
        if (!terminal.hasSelection()) {
          if (!navigator.platform.startsWith('Mac')) return true;
          event.preventDefault();
          return false;
        }
        event.preventDefault();
        copySelection(terminal.getSelection(), showCopyStatus);
        return false;
      });
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
        host.removeEventListener('mousedown', forceOrdinarySelection, true);
        host.removeEventListener('mouseup', copyCompletedSelection, true);
        isActive = false;
        if (copyStatusTimer !== null) dependencies.clearTimer(copyStatusTimer);
        setCopyStatusVisible(false);
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
      sendInput,
      sendResize,
      subscribeOutput,
      terminalTheme,
    ]);

    return (
      <div className="terminal-host-shell">
        <div
          ref={hostRef}
          className="terminal-host"
          role="region"
          aria-label="Terminal"
          tabIndex={0}
          onFocus={(event) => {
            if (event.target === event.currentTarget) focusTerminalRef.current();
          }}
          onContextMenu={(event) => event.preventDefault()}
        />
        {copyStatusVisible && (
          <div className="terminal-copy-status" role="status">
            Copied to clipboard
          </div>
        )}
      </div>
    );
  },
);
