// @vitest-environment jsdom

import type {
  ClientConfig,
  SettingsResponse,
  TabView,
} from '@flanterminal/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import './test/setup.js';
import type { TabsApi } from './tabs-api.js';
import type { TerminalSessionHandle } from './TerminalSession.js';

const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '223e4567-e89b-42d3-a456-426614174000';
const C = '323e4567-e89b-42d3-a456-426614174000';
const config: ClientConfig = {
  basePath: '/terminal',
  resizeDebounceMs: 100,
  reconnectMaxSeconds: 8,
};
const settingsResponse = {
  settings: {
    version: 1,
    fontFamily: 'jetbrains-mono-nerd',
    fontSize: 14,
    lineHeight: 1.2,
    letterSpacing: 0,
    scrollback: 5_000,
    theme: 'dark',
    cursorStyle: 'block',
    cursorBlink: true,
    bellBehavior: 'visual',
    reconnectBehavior: 'automatic',
    automaticTabCreation: true,
    workspaceShortcuts: 'default',
    defaultShell: '/bin/bash',
    tmuxHistoryLimit: 20_000,
    staleSessionCleanupHours: 0,
  },
  limits: {
    fontFamilies: ['jetbrains-mono-nerd', 'system-monospace'],
    fontSize: { min: 8, max: 32, step: 1 },
    lineHeight: { min: 1, max: 2, step: 0.05 },
    letterSpacing: { min: 0, max: 4, step: 1 },
    scrollback: { min: 0, max: 100_000, step: 1 },
    themes: ['dark', 'light', 'ubuntu'],
    cursorStyles: ['block', 'underline', 'bar'],
    bellBehaviors: ['none', 'visual', 'sound'],
    reconnectBehaviors: ['automatic', 'manual'],
    workspaceShortcutModes: ['default', 'disabled'],
    tmuxHistoryLimit: { min: 0, max: 1_000_000, step: 1 },
    staleSessionCleanupHours: { min: 0, max: 8_760, step: 1 },
  },
  allowedShells: ['/bin/bash'],
} satisfies SettingsResponse;
const settingsProps = {
  settingsResponse,
  settingsBusy: false,
  settingsError: null,
  onSaveSettings: vi.fn(async () => undefined),
  authMode: 'local' as const,
};
const commands = vi.hoisted(() => ({
  reconnect: vi.fn(),
  detach: vi.fn(),
  clear: vi.fn(),
  focus: vi.fn(),
}));

vi.mock('./TerminalSession.js', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    TerminalSession: forwardRef<TerminalSessionHandle, { tabId: string }>(
      function MockSession({ tabId }, ref) {
        useImperativeHandle(ref, () => commands, []);
        return (
          <div className="terminal-host" aria-label={`Terminal ${tabId}`}>
            <textarea aria-label={`Shell input ${tabId}`} />
          </div>
        );
      },
    ),
  };
});

import { App, StartupState } from './App.js';

function tab(
  id: string,
  position: number,
  state: 'active' | 'stopped' = 'active',
): TabView {
  return {
    id,
    displayName: `Terminal ${position + 1}`,
    position,
    createdAt: '2026-07-11T00:00:00.000Z',
    lastActivityAt: '2026-07-11T00:00:00.000Z',
    desiredState: state,
    session: {
      state: state === 'active' ? 'running' : 'stopped',
      attached: false,
      bridgePid: null,
    },
  };
}

function api(initial = [tab(A, 0), tab(B, 1), tab(C, 2, 'stopped')]) {
  const client: TabsApi = {
    list: vi.fn(async () => ({ structureRevision: 1, tabs: initial })),
    create: vi.fn(async () =>
      tab('423e4567-e89b-42d3-a456-426614174000', initial.length),
    ),
    rename: vi.fn(async (id, name) => ({
      ...initial.find((item) => item.id === id)!,
      displayName: name,
    })),
    reorder: vi.fn(async (revision: number, ids: readonly string[]) => ({
      structureRevision: revision + 1,
      tabs: ids.map((id, position) => ({
        ...initial.find((item) => item.id === id)!,
        position,
      })),
    })),
    close: vi.fn(async () => undefined),
    health: vi.fn(async (id) => initial.find((item) => item.id === id)!),
    terminate: vi.fn(async (id) => ({
      ...initial.find((item) => item.id === id)!,
      desiredState: 'stopped' as const,
    })),
    recreate: vi.fn(async (id) => ({
      ...initial.find((item) => item.id === id)!,
      desiredState: 'active' as const,
    })),
    restart: vi.fn(async (id) => initial.find((item) => item.id === id)!),
    restartBridge: vi.fn(async (id) => initial.find((item) => item.id === id)!),
  };
  return client;
}

beforeEach(() => vi.clearAllMocks());

describe('App', () => {
  it('loads tabs, lazily mounts selected terminals, and retains visited sessions', async () => {
    render(<App config={config} api={api()} {...settingsProps} />);
    await screen.findByRole('tab', { name: 'Terminal 1' });
    expect(await screen.findByLabelText(`Terminal ${A}`)).toBeInTheDocument();
    expect(screen.queryByLabelText(`Terminal ${B}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Terminal 2' }));
    expect(screen.getByLabelText(`Terminal ${A}`)).toBeInTheDocument();
    expect(screen.getByLabelText(`Terminal ${B}`)).toBeInTheDocument();
  });

  it('selects stopped tabs without mounting a socket and recreates on command', async () => {
    const client = api();
    render(<App config={config} api={client} {...settingsProps} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Terminal 3' }));
    expect(screen.queryByLabelText(`Terminal ${C}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recreate session' }));
    await waitFor(() => expect(client.recreate).toHaveBeenCalledWith(C));
  });

  it('confirms closing a tab before terminating its backend session', async () => {
    const client = api();
    render(<App config={config} api={client} {...settingsProps} />);
    await screen.findByRole('tab', { name: 'Terminal 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    expect(client.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(client.close).toHaveBeenCalledWith(A));
  });

  it('reconnects the waiting client only after a session restart succeeds', async () => {
    const client = api();
    render(<App config={config} api={client} {...settingsProps} />);
    await screen.findByLabelText(`Terminal ${A}`);
    fireEvent.click(screen.getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restart session' }));
    expect(client.restart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart session' }));

    await waitFor(() => expect(client.restart).toHaveBeenCalledWith(A));
    expect(commands.reconnect).toHaveBeenCalledOnce();
  });

  it('supports new-tab, selection, and close shortcuts without intercepting inputs', async () => {
    const client = api();
    render(<App config={config} api={client} {...settingsProps} />);
    await screen.findByRole('tab', { name: 'Terminal 1' });
    fireEvent.keyDown(document, { key: 't', ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    fireEvent.keyDown(document, { key: '2', altKey: true });
    expect(screen.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(screen.getByLabelText(`Shell input ${B}`), {
      key: 'w',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('opens settings as a full workspace and returns to the terminal', async () => {
    render(<App config={config} api={api()} {...settingsProps} />);
    await screen.findByRole('tab', { name: 'Terminal 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(
      screen.getByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('tab', { name: 'Terminal 1' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to terminal' }));
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toBeInTheDocument();
  });

  it('does not intercept workspace shortcuts when they are disabled', async () => {
    const client = api();
    render(
      <App
        config={config}
        api={client}
        {...settingsProps}
        settingsResponse={{
          ...settingsResponse,
          settings: {
            ...settingsResponse.settings,
            workspaceShortcuts: 'disabled',
          },
        }}
      />,
    );
    await screen.findByRole('tab', { name: 'Terminal 1' });
    fireEvent.keyDown(document, { key: 't', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: '2', altKey: true });
    expect(client.create).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Terminal 1' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('StartupState', () => {
  it('provides compact accessible loading and safe error states', () => {
    const { rerender } = render(<StartupState state="loading" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading terminal');
    rerender(<StartupState state="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to start terminal.',
    );
  });
});
