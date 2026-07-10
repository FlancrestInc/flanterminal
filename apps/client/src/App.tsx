import { RefreshCw } from 'lucide-react';

import type { ClientConfig } from '@flanterminal/shared';

import { Terminal } from './Terminal.js';
import {
  useTerminalSocket,
  type ConnectionStatus,
} from './useTerminalSocket.js';

const statusLabels: Record<ConnectionStatus, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  error: 'Connection error',
};

export interface AppProps {
  readonly config: ClientConfig;
}

export function App({ config }: AppProps) {
  const socket = useTerminalSocket(config);
  const reconnecting =
    socket.status === 'connecting' || socket.status === 'reconnecting';
  const statusLabel = statusLabels[socket.status];

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="tab-strip" role="tablist" aria-label="Workspace">
          <div
            className="terminal-tab"
            role="tab"
            aria-selected="true"
            aria-controls="terminal-panel"
          >
            Terminal
          </div>
        </div>
        <div className="connection-controls">
          <div
            className={`connection-status status-${socket.status}`}
            role="status"
            aria-label={statusLabel}
          >
            <span className="status-dot" aria-hidden="true" />
            <span className="status-text">{statusLabel}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            title="Reconnect terminal"
            aria-label="Reconnect terminal"
            disabled={reconnecting}
            onClick={socket.reconnect}
          >
            <RefreshCw
              className={
                reconnecting ? 'reconnect-icon is-active' : 'reconnect-icon'
              }
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>
      <section
        id="terminal-panel"
        className="terminal-panel"
        role="tabpanel"
        aria-label="Terminal"
      >
        <Terminal config={config} socket={socket} />
      </section>
    </main>
  );
}

export function StartupState({
  state,
}: {
  readonly state: 'loading' | 'error';
}) {
  if (state === 'loading') {
    return (
      <main className="startup-state" role="status" aria-live="polite">
        <span className="startup-indicator" aria-hidden="true" />
        <span>Loading terminal</span>
      </main>
    );
  }

  return (
    <main className="startup-state startup-error" role="alert">
      Unable to start terminal.
    </main>
  );
}
