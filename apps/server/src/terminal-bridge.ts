import { Buffer } from 'node:buffer';

import {
  FIXED_SESSION_ID,
  PROTOCOL_VERSION,
  isSessionId,
  type ServerMessage,
} from '@flanterminal/shared';

import type { LifecycleLogger } from './logger.js';
import type { Disposable, PtyProcess } from './pty.js';

export const OPEN_SOCKET_STATE = 1;
const MAX_BUFFER_BYTES = 1_048_576;

export interface SocketPort {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
  onClose(listener: () => void): Disposable;
  onError(listener: () => void): Disposable;
}

export interface BridgeOwner {
  close(code?: number, reason?: string): Promise<void>;
}

export type TerminalBridgeOptions = Readonly<{
  sessionId: string;
  socket: SocketPort;
  pty: PtyProcess;
  logger: LifecycleLogger;
  maxBufferedBytes: number;
}>;

export class TerminalBridge implements BridgeOwner {
  private readonly disposables: Disposable[] = [];
  private readonly maxBufferedBytes: number;
  private closed = false;

  constructor(private readonly options: TerminalBridgeOptions) {
    if (!isSessionId(options.sessionId)) throw new Error('Invalid session');
    if (
      !Number.isInteger(options.maxBufferedBytes) ||
      options.maxBufferedBytes <= 0
    ) {
      throw new Error('Invalid buffer limit');
    }
    this.maxBufferedBytes = Math.min(
      options.maxBufferedBytes,
      MAX_BUFFER_BYTES,
    );

    try {
      this.disposables.push(
        options.pty.onData((data) => this.handleOutput(data)),
      );
      this.disposables.push(
        options.pty.onExit((event) => {
          if (this.closed) return;
          options.logger.warn('terminal_exited', {
            sessionId: options.sessionId,
            exitCode: event.exitCode,
            signal: event.signal,
          });
          this.sendLifecycleError();
          this.shutdown(1011, 'terminal_exited', true);
        }),
      );
      this.disposables.push(
        options.socket.onClose(() =>
          this.shutdown(1000, 'socket_closed', false),
        ),
      );
      this.disposables.push(
        options.socket.onError(() => {
          if (this.closed) return;
          options.logger.warn('socket_error', {
            sessionId: options.sessionId,
          });
          this.shutdown(1011, 'socket_error', false);
        }),
      );
    } catch {
      options.logger.error('terminal_setup_failed', {
        sessionId: options.sessionId,
      });
      this.shutdown(1011, 'terminal_setup_failed', true);
      throw new Error('Terminal bridge setup failed');
    }
    options.logger.info('terminal_opened', { sessionId: options.sessionId });
  }

  write(data: string): void {
    if (this.closed) return;
    try {
      this.options.pty.write(data);
    } catch {
      this.options.logger.error('terminal_write_failed', {
        sessionId: this.options.sessionId,
      });
      this.shutdown(1011, 'terminal_write_failed', true);
    }
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    try {
      this.options.pty.resize(cols, rows);
    } catch {
      this.options.logger.error('terminal_resize_failed', {
        sessionId: this.options.sessionId,
      });
      this.shutdown(1011, 'terminal_resize_failed', true);
    }
  }

  async close(code = 1000, reason = 'terminal_closed'): Promise<void> {
    this.shutdown(code, reason, true);
  }

  private handleOutput(data: string): void {
    if (this.closed || !this.socketIsOpen()) return;
    const message: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: 'output',
      sessionId: FIXED_SESSION_ID,
      data,
    };
    const serialized = JSON.stringify(message);
    const pendingBytes =
      this.options.socket.bufferedAmount +
      Buffer.byteLength(serialized, 'utf8');
    if (pendingBytes >= this.maxBufferedBytes) {
      this.options.logger.warn('terminal_backpressure', {
        sessionId: this.options.sessionId,
        bufferedAmount: this.options.socket.bufferedAmount,
      });
      this.shutdown(4002, 'terminal_backpressure', true);
      return;
    }

    try {
      this.options.socket.send(serialized);
    } catch {
      this.options.logger.error('terminal_send_failed', {
        sessionId: this.options.sessionId,
      });
      this.shutdown(1011, 'terminal_send_failed', true);
    }
  }

  private sendLifecycleError(): void {
    if (this.closed || !this.socketIsOpen()) return;
    if (this.options.socket.bufferedAmount > this.maxBufferedBytes) return;
    const message: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: 'error',
      sessionId: FIXED_SESSION_ID,
      code: 'terminal_unavailable',
    };
    try {
      this.options.socket.send(JSON.stringify(message));
    } catch {
      this.options.logger.error('terminal_send_failed', {
        sessionId: this.options.sessionId,
      });
    }
  }

  private socketIsOpen(): boolean {
    return this.options.socket.readyState === this.options.socket.OPEN;
  }

  private shutdown(code: number, reason: string, closeSocket: boolean): void {
    if (this.closed) return;
    this.closed = true;

    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch {
        this.options.logger.warn('subscription_dispose_failed', {
          sessionId: this.options.sessionId,
        });
      }
    }
    try {
      this.options.pty.kill();
    } catch {
      this.options.logger.warn('terminal_kill_failed', {
        sessionId: this.options.sessionId,
      });
    }
    if (closeSocket && this.socketIsOpen()) {
      try {
        this.options.socket.close(code, reason);
      } catch {
        this.options.logger.warn('socket_close_failed', {
          sessionId: this.options.sessionId,
        });
      }
    }
    this.options.logger.info('terminal_closed', {
      sessionId: this.options.sessionId,
      code,
    });
  }
}
