// @vitest-environment jsdom

import type {
  AuthBootstrap,
  ClientConfig,
  SettingsResponse,
} from '@flanterminal/shared';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsApi } from './settings-api.js';

vi.mock('./App.js', () => ({
  App: ({
    settingsBusy,
    settingsError,
    onChangePassword,
  }: {
    settingsBusy: boolean;
    settingsError: string | null;
    onChangePassword?: (current: string, replacement: string) => Promise<void>;
  }) => (
    <div>
      Default workspace {settingsBusy ? 'busy' : 'idle'} {settingsError}
      <button
        type="button"
        onClick={() => void onChangePassword?.('current', 'replacement')}
      >
        Change local password
      </button>
    </div>
  ),
  StartupState: ({ state }: { state: 'loading' | 'error' }) => (
    <main role={state === 'loading' ? 'status' : 'alert'}>
      {state === 'loading' ? 'Loading terminal' : 'Unable to start terminal.'}
    </main>
  ),
}));

import type { AuthApi } from './auth-api.js';
import { AuthenticatedRoot } from './AuthenticatedRoot.js';
import './test/setup.js';

const session: AuthBootstrap = {
  authenticated: true,
  mode: 'local',
  identityLabel: 'operator',
  csrfToken: 'csrf-token',
};
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
    scrollback: 10_000,
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
function settingsApi(): SettingsApi {
  return {
    load: vi.fn(async () => settingsResponse),
    replace: vi.fn(async (settings) => ({ ...settingsResponse, settings })),
  };
}

function api(result: AuthBootstrap = session): AuthApi {
  return {
    bootstrap: vi.fn(async () => result),
    login: vi.fn(async () => session),
    refresh: vi.fn(async () => session),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
  };
}

describe('AuthenticatedRoot', () => {
  it('loads private config only after authentication and mounts the workspace', async () => {
    const loadConfig = vi.fn(async () => config);
    render(
      <AuthenticatedRoot
        api={api()}
        settingsApi={settingsApi()}
        loadConfig={loadConfig}
        renderWorkspace={(value) => <div>Workspace {value.basePath}</div>}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Loading terminal');
    expect(await screen.findByText('Workspace /terminal')).toBeInTheDocument();
    expect(loadConfig).toHaveBeenCalledWith(
      expect.objectContaining({ fetchImpl: expect.any(Function) }),
    );
  });

  it('unmounts the complete private subtree before exposing login after a private 401', async () => {
    const disposed = vi.fn();
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'authentication_required' }, { status: 401 }),
    );
    function Private({ request }: { request: typeof fetch }) {
      useEffect(() => disposed, []);
      return (
        <button onClick={() => void request('/terminal/api/tabs')}>
          Expire
        </button>
      );
    }
    render(
      <AuthenticatedRoot
        api={api()}
        settingsApi={settingsApi()}
        fetchImpl={fetchImpl}
        loadConfig={vi.fn(async () => config)}
        renderWorkspace={(_value, privateFetch) => (
          <Private request={privateFetch} />
        )}
      />,
    );

    const expire = await screen.findByRole('button', { name: 'Expire' });
    act(() => expire.click());
    await waitFor(() => expect(disposed).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole('button', { name: 'Expire' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });

  it('shows a retry-only bounded access state when bootstrap identity fails', async () => {
    const broken = api();
    vi.mocked(broken.bootstrap).mockRejectedValue(
      new Error('private assertion'),
    );
    render(
      <AuthenticatedRoot
        api={broken}
        settingsApi={settingsApi()}
        loadConfig={vi.fn(async () => config)}
        renderWorkspace={() => <div>Private workspace</div>}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Access could not be verified.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('private assertion');
  });

  it('does not leave workspace state mounted when config loading returns 401', async () => {
    window.history.replaceState({}, '', '/terminal/');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    render(
      <AuthenticatedRoot
        api={api()}
        settingsApi={settingsApi()}
        fetchImpl={fetchImpl}
        loadConfig={async (options) => {
          await options!.fetchImpl!('/terminal/api/config');
          return config;
        }}
        renderWorkspace={() => <div>Private workspace</div>}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Sign in' }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Private workspace')).not.toBeInTheDocument();
  });

  it('does not mount any private workspace subtree before settings load', async () => {
    let resolve!: (value: SettingsResponse) => void;
    const pending = new Promise<SettingsResponse>((next) => {
      resolve = next;
    });
    const client: SettingsApi = {
      load: vi.fn(() => pending),
      replace: vi.fn(),
    };
    render(
      <AuthenticatedRoot
        api={api()}
        loadConfig={vi.fn(async () => config)}
        settingsApi={client}
        renderWorkspace={() => <div>Terminal subtree</div>}
      />,
    );
    await waitFor(() => expect(client.load).toHaveBeenCalledOnce());
    expect(screen.queryByText('Terminal subtree')).not.toBeInTheDocument();
    act(() => resolve(settingsResponse));
    expect(await screen.findByText('Terminal subtree')).toBeInTheDocument();
  });

  it('passes local password operation busy state into the settings workspace', async () => {
    let release!: () => void;
    const authApi = api();
    vi.mocked(authApi.changePassword).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    render(
      <AuthenticatedRoot
        api={authApi}
        loadConfig={vi.fn(async () => config)}
        settingsApi={settingsApi()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Change local password' }),
    );
    expect(
      await screen.findByText(/Default workspace busy/),
    ).toBeInTheDocument();
    act(() => release());
  });
});
