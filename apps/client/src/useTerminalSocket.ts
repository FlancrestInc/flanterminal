import {
  BRIDGE_RESTART,
  PROTOCOL_VERSION,
  SESSION_REPLACED,
  SESSION_RESTARTING,
  SESSION_STOPPED,
  parseServerMessage,
  type ClientConfig,
  type ClientMessage,
} from '@flanterminal/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

export type ConnectionStatus =
  'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

export interface BrowserSocket extends EventTarget {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => BrowserSocket;

export interface TerminalSocketDependencies {
  readonly socketFactory?: SocketFactory;
  readonly location?: Pick<Location, 'host' | 'protocol'>;
  readonly onSessionStopped?: () => void;
  readonly onSessionRestarting?: () => void;
}

export interface TerminalSocketController {
  readonly status: ConnectionStatus;
  readonly error: string | null;
  readonly sendInput: (data: string) => boolean;
  readonly sendResize: (cols: number, rows: number) => boolean;
  readonly subscribeOutput: (listener: (data: string) => void) => () => void;
  readonly reconnect: () => void;
  readonly disconnect: () => void;
}

const OPEN = 1;
const INITIAL_RETRY_DELAY_MS = 500;
const INITIAL_RETRY_STEPS = 5;
const PROTOCOL_ERROR = 'Terminal connection protocol error.';
const SERVER_ERROR = 'Terminal server reported an error.';
const SESSION_REPLACED_ERROR =
  'Terminal opened in another browser. Reconnect to take control.';
const defaultSocketFactory: SocketFactory = (url) => new WebSocket(url);

export function terminalSocketUrl(
  config: Pick<ClientConfig, 'basePath'>,
  sessionId: string,
  location: Pick<Location, 'host' | 'protocol'> = window.location,
): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = config.basePath === '/' ? '' : config.basePath;
  return `${protocol}//${location.host}${basePath}/ws/sessions/${encodeURIComponent(sessionId)}`;
}

export function useTerminalSocket(
  config: ClientConfig,
  sessionId: string,
  dependencies: TerminalSocketDependencies = {},
): TerminalSocketController {
  const onSessionStopped = dependencies.onSessionStopped;
  const onSessionRestarting = dependencies.onSessionRestarting;
  const factory = dependencies.socketFactory ?? defaultSocketFactory;
  const location = dependencies.location ?? window.location;
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<BrowserSocket | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const generationRef = useRef(0);
  const stoppedRef = useRef(false);
  const outputListenersRef = useRef(new Set<(data: string) => void>());
  const connectRef = useRef<() => void>(() => undefined);

  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const scheduleRetry = useCallback(
    (message?: string) => {
      if (stoppedRef.current) {
        setStatus('disconnected');
        return;
      }
      cancelRetry();
      setStatus('reconnecting');
      if (message !== undefined) setError(message);
      const configuredCap = config.reconnectMaxSeconds * 1_000;
      const delay =
        retryAttemptRef.current < INITIAL_RETRY_STEPS
          ? Math.min(
              INITIAL_RETRY_DELAY_MS * 2 ** retryAttemptRef.current,
              configuredCap,
            )
          : configuredCap;
      retryAttemptRef.current += 1;
      retryTimerRef.current = setTimeout(() => connectRef.current(), delay);
    },
    [cancelRetry, config.reconnectMaxSeconds],
  );

  const connect = useCallback(() => {
    if (stoppedRef.current) return;
    cancelRetry();
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    setStatus(retryAttemptRef.current === 0 ? 'connecting' : 'reconnecting');
    setError(null);

    let socket: BrowserSocket;
    try {
      socket = factory(
        terminalSocketUrl({ basePath: config.basePath }, sessionId, location),
      );
    } catch {
      socketRef.current = null;
      scheduleRetry('Unable to open terminal connection.');
      return;
    }
    socketRef.current = socket;

    const onOpen = () => {
      if (isCurrent()) retryAttemptRef.current = 0;
    };
    const onMessage = (event: Event) => {
      if (!isCurrent()) return;
      const result = parseServerMessage((event as MessageEvent<unknown>).data);
      if (!result.success) {
        setStatus('error');
        setError(PROTOCOL_ERROR);
        socket.close(1002, 'Protocol error');
        return;
      }
      if (result.data.sessionId !== sessionId) {
        setStatus('error');
        setError(PROTOCOL_ERROR);
        socket.close(1002, 'Protocol error');
        return;
      }
      if (result.data.type === 'ready') {
        retryAttemptRef.current = 0;
        setStatus('connected');
        setError(null);
      } else if (result.data.type === 'output') {
        for (const listener of outputListenersRef.current) {
          listener(result.data.data);
        }
      } else {
        setStatus('error');
        setError(SERVER_ERROR);
        socket.close(1011, 'Server error');
      }
    };
    const onError = () => {
      if (!isCurrent()) return;
      setError('Terminal connection interrupted.');
    };
    const onClose = (event: Event) => {
      if (!isCurrent()) return;
      socketRef.current = null;
      const code = (event as CloseEvent).code;
      if (code === SESSION_REPLACED) {
        stoppedRef.current = true;
        cancelRetry();
        setStatus('disconnected');
        setError(SESSION_REPLACED_ERROR);
        return;
      }
      if (code === SESSION_STOPPED || code === SESSION_RESTARTING) {
        stoppedRef.current = true;
        cancelRetry();
        setStatus('disconnected');
        setError(null);
        if (code === SESSION_STOPPED) onSessionStopped?.();
        else onSessionRestarting?.();
        return;
      }
      if (code === BRIDGE_RESTART) {
        scheduleRetry();
        return;
      }
      if (stoppedRef.current) {
        setStatus('disconnected');
        return;
      }
      scheduleRetry();
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  }, [
    cancelRetry,
    config.basePath,
    factory,
    location,
    onSessionRestarting,
    onSessionStopped,
    scheduleRetry,
    sessionId,
  ]);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    stoppedRef.current = false;
    connectRef.current();
    return () => {
      stoppedRef.current = true;
      cancelRetry();
      generationRef.current += 1;
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(1000, 'Client disconnect');
    };
  }, [cancelRetry, connect]);

  const send = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const sendInput = useCallback(
    (data: string) =>
      send({
        v: PROTOCOL_VERSION,
        type: 'input',
        sessionId,
        data,
      }),
    [send, sessionId],
  );

  const sendResize = useCallback(
    (cols: number, rows: number) =>
      send({
        v: PROTOCOL_VERSION,
        type: 'resize',
        sessionId,
        cols,
        rows,
      }),
    [send, sessionId],
  );

  const subscribeOutput = useCallback((listener: (data: string) => void) => {
    outputListenersRef.current.add(listener);
    return () => outputListenersRef.current.delete(listener);
  }, []);

  const disconnect = useCallback(() => {
    stoppedRef.current = true;
    cancelRetry();
    generationRef.current += 1;
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Client disconnect');
    setStatus('disconnected');
  }, [cancelRetry]);

  const reconnect = useCallback(() => {
    stoppedRef.current = false;
    cancelRetry();
    generationRef.current += 1;
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close(1000, 'Client reconnect');
    retryAttemptRef.current = 0;
    setStatus('connecting');
    connectRef.current();
  }, [cancelRetry]);

  return {
    status,
    error,
    sendInput,
    sendResize,
    subscribeOutput,
    reconnect,
    disconnect,
  };
}
