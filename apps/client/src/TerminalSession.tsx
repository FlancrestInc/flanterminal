import type { ClientConfig, WorkspaceSettings } from '@flanterminal/shared';
import {
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';

import { Terminal, type TerminalHandle } from './Terminal.js';
import { AuthenticationRequiredContext } from './useAuth.js';
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
  settings: WorkspaceSettings;
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
>(function TerminalSession(
  { config, settings, tabId, onStatus, onSessionChanged },
  ref,
) {
  const terminalRef = useRef<TerminalHandle>(null);
  const onAuthenticationRequired = useContext(AuthenticationRequiredContext);
  const dependencies = useMemo(
    () => ({
      onSessionStopped: () => onSessionChanged(tabId),
      onSessionRestarting: () => onSessionChanged(tabId),
      ...(onAuthenticationRequired === null
        ? {}
        : { onAuthenticationRequired }),
    }),
    [onAuthenticationRequired, onSessionChanged, tabId],
  );
  const socket = useTerminalSocket(config, tabId, {
    ...dependencies,
    reconnectBehavior: settings.reconnectBehavior,
  });

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

  return (
    <Terminal
      ref={terminalRef}
      config={config}
      settings={settings}
      socket={socket}
    />
  );
});
