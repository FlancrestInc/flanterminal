import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  MAX_WS_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@flanterminal/shared';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import type { BridgeRegistry } from './bridge-registry.js';
import type { LifecycleLogger } from './logger.js';
import { authorizeUpgrade } from './origin.js';
import type { AttachToken, SessionManager } from './session-manager.js';
import type { BridgeOwner, SocketPort } from './terminal-bridge.js';

export interface HeartbeatScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

const nativeScheduler: HeartbeatScheduler = {
  setInterval(callback, milliseconds) {
    return setInterval(callback, milliseconds);
  },
  clearInterval(handle) {
    clearInterval(handle as NodeJS.Timeout);
  },
};

export type TerminalWebSocketServerOptions = Readonly<{
  server: Server;
  publicOrigin: string;
  basePath: string;
  sessionManager: Pick<SessionManager, 'authorize' | 'connect'>;
  registry: BridgeRegistry;
  logger: LifecycleLogger;
  heartbeatIntervalMs: number;
  scheduler?: HeartbeatScheduler;
}>;

export interface TerminalWebSocketServer {
  connectedCount(): number;
  stopAccepting(): void;
  stopHeartbeat(): void;
  closeClients(): void;
  close(): Promise<void>;
}

class WsSocketPort implements SocketPort {
  readonly OPEN = WebSocket.OPEN;

  constructor(private readonly socket: WebSocket) {}

  get readyState(): number {
    return this.socket.readyState;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
  }

  onMessage(listener: (data: unknown, isBinary: boolean) => void) {
    const wrapped = (data: RawData, isBinary: boolean) =>
      listener(data, isBinary);
    this.socket.on('message', wrapped);
    return { dispose: () => this.socket.off('message', wrapped) };
  }

  onClose(listener: () => void) {
    this.socket.on('close', listener);
    return { dispose: () => this.socket.off('close', listener) };
  }

  onError(listener: () => void) {
    const wrapped = () => listener();
    this.socket.on('error', wrapped);
    return { dispose: () => this.socket.off('error', wrapped) };
  }
}

export function createTerminalWebSocketServer(
  options: TerminalWebSocketServerOptions,
): TerminalWebSocketServer {
  const scheduler = options.scheduler ?? nativeScheduler;
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });
  const alive = new WeakMap<WebSocket, boolean>();
  const connections = new WeakMap<
    WebSocket,
    Readonly<{ sessionId: string; token: AttachToken }>
  >();
  let accepting = true;
  let heartbeat: unknown;

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (!accepting) {
      rejectUpgrade(socket, 503);
      return;
    }
    const authorization = authorizeUpgrade(
      { origin: request.headers.origin, requestUrl: request.url },
      { publicOrigin: options.publicOrigin, basePath: options.basePath },
    );
    if (!authorization.allowed) {
      rejectUpgrade(socket, authorization.status);
      return;
    }
    const token = options.sessionManager.authorize(authorization.sessionId);
    if (token === undefined) {
      rejectUpgrade(socket, 404);
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      connections.set(websocket, {
        sessionId: authorization.sessionId,
        token,
      });
      websocketServer.emit('connection', websocket, request);
    });
  };

  options.server.on('upgrade', onUpgrade);
  websocketServer.on('connection', (socket) => {
    const connection = connections.get(socket);
    if (connection === undefined) {
      socket.close(1011, 'terminal_unavailable');
      return;
    }
    alive.set(socket, true);
    socket.on('pong', () => alive.set(socket, true));
    const port = new WsSocketPort(socket);
    let owner: BridgeOwner | undefined;
    let ended = false;
    let removed = false;

    const removeRegistration = (): void => {
      ended = true;
      if (owner === undefined || removed) return;
      removed = true;
      void options.registry.remove(connection.sessionId, owner);
    };
    socket.once('close', removeRegistration);
    socket.once('error', removeRegistration);

    void Promise.resolve()
      .then(() =>
        options.sessionManager.connect(connection.token, port, {
          cols: 80,
          rows: 24,
        }),
      )
      .then(async (connectedOwner) => {
        owner = connectedOwner;
        if (ended) {
          await owner.close(1001, 'socket_closed');
          removeRegistration();
          return;
        }
        sendReady(socket, connection.sessionId);
      })
      .catch(() => {
        options.logger.error('terminal_connection_failed', {
          sessionId: connection.sessionId,
        });
        sendConnectionError(socket, connection.sessionId);
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1011, 'terminal_unavailable');
        }
      });
  });

  heartbeat = scheduler.setInterval(() => {
    for (const client of websocketServer.clients) {
      if (alive.get(client) === false) {
        client.terminate();
        continue;
      }
      alive.set(client, false);
      client.ping();
    }
  }, options.heartbeatIntervalMs);

  const stopAccepting = (): void => {
    if (!accepting) return;
    accepting = false;
    options.server.off('upgrade', onUpgrade);
  };
  const stopHeartbeat = (): void => {
    if (heartbeat === undefined) return;
    scheduler.clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const closeClients = (): void => {
    for (const client of websocketServer.clients) client.terminate();
  };

  return {
    connectedCount: () => websocketServer.clients.size,
    stopAccepting,
    stopHeartbeat,
    closeClients,
    async close() {
      stopAccepting();
      stopHeartbeat();
      closeClients();
      await new Promise<void>((resolve) =>
        websocketServer.close(() => resolve()),
      );
    },
  };
}

function sendReady(socket: WebSocket, sessionId: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const message: ServerMessage = {
    v: PROTOCOL_VERSION,
    type: 'ready',
    sessionId,
  };
  socket.send(JSON.stringify(message));
}

function sendConnectionError(socket: WebSocket, sessionId: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const message: ServerMessage = {
    v: PROTOCOL_VERSION,
    type: 'error',
    sessionId,
    code: 'terminal_unavailable',
  };
  socket.send(JSON.stringify(message));
}

function rejectUpgrade(socket: Duplex, status: 403 | 404 | 503): void {
  const reason =
    status === 403
      ? 'Forbidden'
      : status === 404
        ? 'Not Found'
        : 'Service Unavailable';
  const body = `${status} ${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
