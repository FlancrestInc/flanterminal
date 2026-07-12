import type { ClientConfig } from '@flanterminal/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ConfirmDialog } from './ConfirmDialog.js';
import { SessionMenu } from './SessionMenu.js';
import { TabBar } from './TabBar.js';
import { createTabsApi, type TabsApi } from './tabs-api.js';
import {
  TerminalSession,
  type TerminalSessionHandle,
} from './TerminalSession.js';
import { useTabs } from './useTabs.js';
import type { ConnectionStatus } from './useTerminalSocket.js';

export interface AppProps {
  readonly config: ClientConfig;
  readonly api?: TabsApi;
}

type Confirmation = Readonly<{
  kind: 'close' | 'terminate' | 'restart';
  id: string;
}>;

export function App({ config, api: suppliedApi }: AppProps) {
  const defaultApi = useMemo(
    () => createTabsApi(config.basePath),
    [config.basePath],
  );
  const tabs = useTabs(suppliedApi ?? defaultApi);
  const [statuses, setStatuses] = useState<
    Readonly<Record<string, ConnectionStatus>>
  >({});
  const [generations, setGenerations] = useState<
    Readonly<Record<string, number>>
  >({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const sessionRefs = useRef(new Map<string, TerminalSessionHandle>());
  const healthRef = useRef(tabs.health);
  useEffect(() => {
    healthRef.current = tabs.health;
  }, [tabs.health]);

  const selected = tabs.tabs.find((tab) => tab.id === tabs.selectedId);
  const selectedIndex = selected
    ? tabs.tabs.findIndex((tab) => tab.id === selected.id)
    : -1;

  const onStatus = useCallback((id: string, status: ConnectionStatus) => {
    setStatuses((current) =>
      current[id] === status ? current : { ...current, [id]: status },
    );
  }, []);
  const onSessionChanged = useCallback((id: string) => {
    void healthRef.current(id);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === 't') {
        event.preventDefault();
        void tabs.create();
        return;
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        key === 'w' &&
        tabs.selectedId !== null
      ) {
        event.preventDefault();
        setConfirmation({ kind: 'close', id: tabs.selectedId });
        return;
      }
      if (event.ctrlKey && key === 'tab' && tabs.tabs.length > 0) {
        event.preventDefault();
        const direction = event.shiftKey ? -1 : 1;
        const current = Math.max(
          0,
          tabs.tabs.findIndex((tab) => tab.id === tabs.selectedId),
        );
        const next =
          (current + direction + tabs.tabs.length) % tabs.tabs.length;
        tabs.select(tabs.tabs[next]!.id);
        return;
      }
      if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {
        const target = tabs.tabs[Number(event.key) - 1];
        if (target !== undefined) {
          event.preventDefault();
          tabs.select(target.id);
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [tabs]);

  if (tabs.loading) return <StartupState state="loading" />;

  const reorderBy = (offset: -1 | 1) => {
    if (selectedIndex < 0) return;
    const target = selectedIndex + offset;
    if (target < 0 || target >= tabs.tabs.length) return;
    const ids = tabs.tabs.map((tab) => tab.id);
    [ids[selectedIndex], ids[target]] = [ids[target]!, ids[selectedIndex]!];
    void tabs.reorder(ids);
  };

  const runConfirmation = async () => {
    const action = confirmation;
    setConfirmation(null);
    if (action === null) return;
    if (action.kind === 'close') await tabs.close(action.id);
    if (action.kind === 'terminate') await tabs.terminate(action.id);
    if (action.kind === 'restart' && (await tabs.restart(action.id))) {
      sessionRefs.current.get(action.id)?.reconnect();
    }
  };

  return (
    <main className="app-shell">
      <header className="top-bar">
        <TabBar
          tabs={tabs.tabs}
          selectedId={tabs.selectedId}
          statusFor={(id) => {
            const tab = tabs.tabs.find((candidate) => candidate.id === id);
            return tab?.desiredState === 'stopped'
              ? 'stopped'
              : (statuses[id] ?? 'disconnected');
          }}
          onSelect={tabs.select}
          onCreate={() => void tabs.create()}
          onRename={(id, name) => void tabs.rename(id, name)}
          onReorder={(ids) => void tabs.reorder(ids)}
          onRequestClose={(id) => setConfirmation({ kind: 'close', id })}
        />
        {selected ? (
          <SessionMenu
            desiredState={selected.desiredState}
            sessionState={selected.session.state}
            canMoveLeft={selectedIndex > 0}
            canMoveRight={selectedIndex < tabs.tabs.length - 1}
            onReconnect={() =>
              sessionRefs.current.get(selected.id)?.reconnect()
            }
            onDetach={() => sessionRefs.current.get(selected.id)?.detach()}
            onClear={() => sessionRefs.current.get(selected.id)?.clear()}
            onRestartClient={() =>
              setGenerations((current) => ({
                ...current,
                [selected.id]: (current[selected.id] ?? 0) + 1,
              }))
            }
            onRestartBridge={() => void tabs.restartBridge(selected.id)}
            onRestartSession={() =>
              setConfirmation({ kind: 'restart', id: selected.id })
            }
            onTerminate={() =>
              setConfirmation({ kind: 'terminate', id: selected.id })
            }
            onRecreate={() => void tabs.recreate(selected.id)}
            onMoveLeft={() => reorderBy(-1)}
            onMoveRight={() => reorderBy(1)}
          />
        ) : null}
      </header>

      {tabs.error ? (
        <div className="workspace-error" role="alert">
          {tabs.error}
        </div>
      ) : null}
      <div className="terminal-workspace">
        {tabs.tabs.length === 0 ? (
          <div className="empty-terminal">
            <button type="button" onClick={() => void tabs.create()}>
              New terminal
            </button>
          </div>
        ) : null}
        {tabs.tabs.map((tab) => {
          const visited = tabs.visitedIds.has(tab.id);
          const active = tab.desiredState === 'active';
          if (!visited || !active) return null;
          return (
            <section
              key={`${tab.id}:${generations[tab.id] ?? 0}`}
              className="terminal-panel"
              role="tabpanel"
              aria-label={tab.displayName}
              hidden={tab.id !== tabs.selectedId}
            >
              <TerminalSession
                ref={(handle) => {
                  if (handle === null) sessionRefs.current.delete(tab.id);
                  else sessionRefs.current.set(tab.id, handle);
                }}
                config={config}
                tabId={tab.id}
                onStatus={onStatus}
                onSessionChanged={onSessionChanged}
              />
            </section>
          );
        })}
        {selected?.desiredState === 'stopped' ? (
          <section
            className="stopped-terminal"
            role="tabpanel"
            aria-label={selected.displayName}
          >
            <span>Session stopped</span>
            <button
              type="button"
              onClick={() => void tabs.recreate(selected.id)}
            >
              Recreate session
            </button>
          </section>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmation !== null}
        title={confirmationTitle(confirmation?.kind)}
        description="This action affects the running shell in this tab."
        confirmLabel={confirmationLabel(confirmation?.kind)}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void runConfirmation()}
      />
    </main>
  );
}

function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || target.closest('[role="dialog"]') !== null))
  );
}

function confirmationTitle(kind: Confirmation['kind'] | undefined): string {
  if (kind === 'terminate') return 'Terminate session?';
  if (kind === 'restart') return 'Restart session?';
  return 'Close tab?';
}

function confirmationLabel(kind: Confirmation['kind'] | undefined): string {
  if (kind === 'terminate') return 'Terminate session';
  if (kind === 'restart') return 'Restart session';
  return 'Close tab';
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
