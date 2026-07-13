import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  AUTHENTICATION_REQUIRED,
  AUTHENTICATION_REQUIRED_REASON,
  MAX_WS_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@flanterminal/shared';
import WebSocket, { WebSocketServer, type RawData } from 'ws';

import type { BridgeRegistry } from './bridge-registry.js';
import type { WebSocketUpgradeAuthenticator } from './auth-middleware.js';
import type { LifecycleLogger } from './logger.js';
import { authorizeUpgrade } from './origin.js';
import type { AttachToken, SessionManager } from './session-manager.js';
import type { BridgeOwner, SocketPort } from './terminal-bridge.js';
import type {
  ApplicationSessionAuthority,
  WebSocketAuthIndex,
} from './websocket-auth-index.js';

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
  upgradeAuthenticator?: WebSocketUpgradeAuthenticator;
  authIndex?: WebSocketAuthIndex;
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
  readonly authenticatedInput;

  constructor(
    private readonly socket: WebSocket,
    authenticateInput: () => boolean,
  ) {
    this.authenticatedInput = Object.freeze({
      authenticate: authenticateInput,
    });
  }

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

  terminate(): void {
    this.socket.terminate();
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
  const upgradeAuthenticator = options.upgradeAuthenticator;
  const authIndex = options.authIndex;
  const connections = new WeakMap<
    WebSocket,
    Readonly<{
      sessionId: string;
      token: AttachToken;
      authority: ApplicationSessionAuthority;
      port: WsSocketPort;
    }>
  >();
  let accepting = true;
  let heartbeat: unknown;
  let closePromise: Promise<void> | undefined;

  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    void acceptUpgrade(request, socket, head).catch(() =>
      rejectUpgrade(socket, 401),
    );
  };

  const acceptUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    if (!accepting) {
      rejectUpgrade(socket, 503);
      return;
    }
    const authorization = authorizeUpgrade(
      {
        origin: request.headers.origin,
        rawHeaders: request.rawHeaders,
        requestUrl: request.url,
      },
      { publicOrigin: options.publicOrigin, basePath: options.basePath },
    );
    if (!authorization.allowed) {
      rejectUpgrade(socket, authorization.status);
      return;
    }
    if (upgradeAuthenticator === undefined || authIndex === undefined) {
      rejectUpgrade(socket, 503);
      return;
    }
    const authority = await upgradeAuthenticator.authenticate(request);
    if (authority === undefined || !authIndex.isActive(authority)) {
      rejectUpgrade(socket, 401);
      return;
    }
    const token = options.sessionManager.authorize(authorization.sessionId);
    if (token === undefined) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!accepting || !authIndex.isActive(authority)) {
      rejectUpgrade(socket, accepting ? 401 : 503);
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const port = new WsSocketPort(websocket, () =>
        upgradeAuthenticator.touchInput(authority),
      );
      if (
        !authIndex.isActive(authority) ||
        !authIndex.registerIfActive(authority, authorization.sessionId, port)
      ) {
        closeAuthenticationRequired(port);
        return;
      }
      connections.set(websocket, {
        sessionId: authorization.sessionId,
        token,
        authority,
        port,
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
    const onPong = (): void => {
      alive.set(socket, true);
    };
    socket.on('pong', onPong);
    const port = connection.port;
    let owner: BridgeOwner | undefined;
    let ended = false;
    let authenticationEnded = false;
    let cleanupPromise: Promise<void> | undefined;
    let listenersDisposed = false;

    const cleanupOwner = (code: number, reason: string): Promise<void> => {
      if (cleanupPromise !== undefined) return cleanupPromise;
      if (owner === undefined) return Promise.resolve();
      const target = owner;
      cleanupPromise = (async () => {
        try {
          await target.close(code, reason);
        } catch {
          // Registry removal must still run after a failed owner close.
        }
        try {
          await options.registry.remove(connection.sessionId, target);
        } catch {
          // Cleanup is contained because the socket is already unavailable.
        }
      })();
      return cleanupPromise;
    };
    const removeRegistration = (): void => {
      disposeSocketListeners();
      ended = true;
      authenticationEnded = !authIndex?.isActive(connection.authority);
      authIndex?.unregister(port);
      void cleanupOwner(
        authenticationEnded ? AUTHENTICATION_REQUIRED : 1001,
        authenticationEnded ? AUTHENTICATION_REQUIRED_REASON : 'socket_closed',
      );
    };
    const onSocketError = (): void => {
      removeRegistration();
      if (port.readyState === port.OPEN) {
        try {
          port.close(1011, 'socket_error');
        } catch {
          // Registration and any late owner cleanup are already contained.
        }
      }
    };
    const disposeSocketListeners = (): void => {
      if (listenersDisposed) return;
      listenersDisposed = true;
      socket.off('pong', onPong);
      socket.off('close', removeRegistration);
      socket.off('error', onSocketError);
    };
    socket.once('close', removeRegistration);
    socket.once('error', onSocketError);

    void Promise.resolve()
      .then(() =>
        options.sessionManager.connect(connection.token, port, {
          cols: 80,
          rows: 24,
        }),
      )
      .then(async (connectedOwner) => {
        owner = connectedOwner;
        if (!authIndex?.isActive(connection.authority)) {
          authenticationEnded = true;
          ended = true;
          authIndex?.closeAuthenticationRequired(port);
        }
        if (ended || socket.readyState !== WebSocket.OPEN) {
          await cleanupOwner(
            authenticationEnded ? AUTHENTICATION_REQUIRED : 1001,
            authenticationEnded
              ? AUTHENTICATION_REQUIRED_REASON
              : 'socket_closed',
          );
          return;
        }
        sendReady(socket, connection.sessionId);
      })
      .catch(() => {
        if (ended || !authIndex?.isActive(connection.authority)) {
          authIndex?.closeAuthenticationRequired(port);
          return;
        }
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
    authIndex?.sweepExpired();
    for (const client of websocketServer.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
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
  const disposeAuthentication = (): void => authIndex?.dispose();
  const onHttpServerClose = (): void => {
    stopAccepting();
    stopHeartbeat();
    disposeAuthentication();
    restoreHttpServerClose();
  };
  const originalHttpServerClose = options.server.close;
  const hookedHttpServerClose = new Proxy(originalHttpServerClose, {
    apply(target, thisArgument, argumentsList) {
      onHttpServerClose();
      return Reflect.apply(target, thisArgument, argumentsList) as Server;
    },
  }) as Server['close'];
  function restoreHttpServerClose(): void {
    if (options.server.close === hookedHttpServerClose)
      options.server.close = originalHttpServerClose;
  }
  options.server.close = hookedHttpServerClose;
  options.server.once('close', onHttpServerClose);

  return {
    connectedCount: () => authIndex?.connectedCount() ?? 0,
    stopAccepting,
    stopHeartbeat,
    closeClients,
    async close() {
      if (closePromise !== undefined) return await closePromise;
      stopAccepting();
      stopHeartbeat();
      closeClients();
      disposeAuthentication();
      restoreHttpServerClose();
      options.server.off('close', onHttpServerClose);
      closePromise = new Promise<void>((resolve) =>
        websocketServer.close(() => resolve()),
      );
      await closePromise;
    },
  };
}

function closeAuthenticationRequired(socket: SocketPort): void {
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.close(AUTHENTICATION_REQUIRED, AUTHENTICATION_REQUIRED_REASON);
  } catch {
    // Termination below is the guaranteed fallback before index insertion.
  }
  if (socket.readyState !== socket.OPEN) return;
  try {
    socket.terminate();
  } catch {
    // The accepted socket has no bridge or authentication registration yet.
  }
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

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404 | 503): void {
  const reason =
    status === 401
      ? 'Unauthorized'
      : status === 403
        ? 'Forbidden'
        : status === 404
          ? 'Not Found'
          : 'Service Unavailable';
  const body = `${status} ${reason}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
