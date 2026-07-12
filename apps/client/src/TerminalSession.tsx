import type { ClientConfig } from '@flanterminal/shared';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';

import { Terminal, type TerminalHandle } from './Terminal.js';
import {
  useTerminalSocket,
  type ConnectionStatus,
} from './useTerminalSocket.js';

export interface TerminalSessionHandle {
  reconnect(): void;
  detach(): void;
  clear(): void;
  focus(): void;
}

export type TerminalSessionProps = Readonly<{
  config: ClientConfig;
  tabId: string;
  onStatus: (
    id: string,
    status: ConnectionStatus,
    error: string | null,
  ) => void;
  onSessionChanged: (id: string) => void;
}>;

export const TerminalSession = forwardRef<
  TerminalSessionHandle,
  TerminalSessionProps
>(function TerminalSession({ config, tabId, onStatus, onSessionChanged }, ref) {
  const terminalRef = useRef<TerminalHandle>(null);
  const dependencies = useMemo(
    () => ({
      onSessionStopped: () => onSessionChanged(tabId),
      onSessionRestarting: () => onSessionChanged(tabId),
    }),
    [onSessionChanged, tabId],
  );
  const socket = useTerminalSocket(config, tabId, dependencies);

  useEffect(() => {
    onStatus(tabId, socket.status, socket.error);
  }, [onStatus, socket.error, socket.status, tabId]);

  useImperativeHandle(
    ref,
    () => ({
      reconnect: socket.reconnect,
      detach: socket.disconnect,
      clear: () => terminalRef.current?.clear(),
      focus: () => terminalRef.current?.focus(),
    }),
    [socket.disconnect, socket.reconnect],
  );

  return <Terminal ref={terminalRef} config={config} socket={socket} />;
});
