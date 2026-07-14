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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsApi } from './settings-api.js';
import type { TabsApi } from './tabs-api.js';
import type { BrowserSocket } from './useTerminalSocket.js';

const terminalProbe = vi.hoisted(() => ({
  enabled: false,
  factory: vi.fn(),
}));

vi.mock('./App.js', async () => {
  const { useTerminalSocket } = await import('./useTerminalSocket.js');
  function TerminalProbe({
    config,
    api,
  }: {
    config: ClientConfig;
    api: TabsApi;
  }) {
    const controller = useTerminalSocket(
      config,
      '123e4567-e89b-42d3-a456-426614174000',
      {
        socketFactory: terminalProbe.factory,
        reconnectBehavior: 'manual',
      },
    );
    return (
      <div>
        <button
          type="button"
          onClick={() => void api.list().catch(() => undefined)}
        >
          Expire terminal auth
        </button>
        <button type="button" onClick={controller.reconnect}>
          Reconnect terminal
        </button>
      </div>
    );
  }
  return {
    App: ({
      config,
      api,
      settingsBusy,
      settingsError,
      passwordBusy,
      passwordError,
      onChangePassword,
    }: {
      config: ClientConfig;
      api: TabsApi;
      settingsBusy: boolean;
      settingsError: string | null;
      passwordBusy: boolean;
      passwordError: string | null;
      onChangePassword?: (
        current: string,
        replacement: string,
      ) => Promise<void>;
    }) =>
      terminalProbe.enabled ? (
        <TerminalProbe config={config} api={api} />
      ) : (
        <div>
          Default workspace {settingsBusy ? 'busy' : 'idle'} {settingsError}{' '}
          Password {passwordBusy ? 'busy' : 'idle'} {passwordError}
          <button
            type="button"
            onClick={() => void onChangePassword?.('current', 'replacement')}
          >
            Change local password
          </button>
        </div>
      ),
    StartupState: ({
      state,
      message,
      onRetry,
    }: {
      state: 'loading' | 'error';
      message?: string;
      onRetry?: () => void;
    }) => (
      <main role={state === 'loading' ? 'status' : 'alert'}>
        {state === 'loading'
          ? 'Loading terminal'
          : (message ?? 'Unable to start terminal.')}
        {onRetry === undefined ? null : (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        )}
      </main>
    ),
  };
});

import type { AuthApi } from './auth-api.js';
import { AuthenticatedRoot } from './AuthenticatedRoot.js';
import { SettingsApiError } from './settings-api.js';
import {
  resetTerminalAuthSuspensionsForTests,
  terminalAuthSuspensionCountsForTests,
} from './terminal-auth-suspension.js';
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

function manualSettingsApi(): SettingsApi {
  const manual = {
    ...settingsResponse,
    settings: {
      ...settingsResponse.settings,
      reconnectBehavior: 'manual' as const,
    },
  };
  return {
    load: vi.fn(async () => manual),
    replace: vi.fn(async (settings) => ({ ...manual, settings })),
  };
}

class ProbeSocket extends EventTarget implements BrowserSocket {
  readyState = 0;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  });
}

function api(result: AuthBootstrap = session): AuthApi {
  return {
    bootstrap: vi.fn(async () => result),
    setup: vi.fn(async () => session),
    login: vi.fn(async () => session),
    refresh: vi.fn(async () => session),
    logout: vi.fn(async () => undefined),
    changePassword: vi.fn(async () => undefined),
  };
}

describe('AuthenticatedRoot', () => {
  beforeEach(() => {
    terminalProbe.enabled = false;
    terminalProbe.factory.mockReset();
    resetTerminalAuthSuspensionsForTests();
  });
  it('selects administrator setup only for the strict setup bootstrap', async () => {
    const setupBootstrap: AuthBootstrap = {
      authenticated: false,
      mode: 'local',
      setupRequired: true,
      username: 'configured-operator',
    };
    const view = render(
      <AuthenticatedRoot
        api={api(setupBootstrap)}
        settingsApi={settingsApi()}
        loadConfig={vi.fn(async () => config)}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Set up FlanTerminal' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toHaveValue(
      'configured-operator',
    );

    view.unmount();
    render(
      <AuthenticatedRoot
        api={api({ authenticated: false, mode: 'local' })}
        settingsApi={settingsApi()}
        loadConfig={vi.fn(async () => config)}
      />,
    );
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });

  it('creates the administrator through auth setup and enters the workspace', async () => {
    const setupBootstrap: AuthBootstrap = {
      authenticated: false,
      mode: 'local',
      setupRequired: true,
      username: 'operator',
    };
    const authApi = api(setupBootstrap);
    render(
      <AuthenticatedRoot
        api={authApi}
        settingsApi={settingsApi()}
        loadConfig={vi.fn(async () => config)}
        renderWorkspace={() => <div>Private workspace</div>}
      />,
    );
    fireEvent.change(await screen.findByLabelText('New Password'), {
      target: { value: 'private-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'private-password' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Create administrator' }),
    );

    await waitFor(() =>
      expect(authApi.setup).toHaveBeenCalledWith(
        { password: 'private-password' },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText('Private workspace')).toBeInTheDocument();
  });
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

  it('retries a transient initial settings failure without mounting or overlapping the terminal', async () => {
    let resolveRetry!: (value: SettingsResponse) => void;
    const retry = new Promise<SettingsResponse>((resolve) => {
      resolveRetry = resolve;
    });
    const client = settingsApi();
    vi.mocked(client.load)
      .mockRejectedValueOnce(new Error('private settings failure'))
      .mockImplementationOnce(async () => await retry);
    render(
      <AuthenticatedRoot
        api={api()}
        loadConfig={vi.fn(async () => config)}
        settingsApi={client}
        renderWorkspace={() => <div>Terminal subtree</div>}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load settings.',
    );
    expect(screen.queryByText('Terminal subtree')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading terminal');
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
    expect(client.load).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Terminal subtree')).not.toBeInTheDocument();

    act(() => resolveRetry(settingsResponse));
    expect(await screen.findByText('Terminal subtree')).toBeInTheDocument();
  });

  it('propagates an initial settings 401 to authentication instead of retrying', async () => {
    const client = settingsApi();
    vi.mocked(client.load).mockRejectedValueOnce(
      new SettingsApiError('authentication_required', 401),
    );
    render(
      <AuthenticatedRoot
        api={api()}
        loadConfig={vi.fn(async () => config)}
        settingsApi={client}
        renderWorkspace={() => <div>Terminal subtree</div>}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Terminal subtree')).not.toBeInTheDocument();
  });

  it('keeps local password busy state separate from settings operations', async () => {
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
    expect(await screen.findByText(/Password busy/)).toBeInTheDocument();
    expect(screen.getByText(/Default workspace idle/)).toBeInTheDocument();
    act(() => release());
  });

  it('keeps a manual terminal suspended after private HTTP auth loss and login restoration', async () => {
    terminalProbe.enabled = true;
    terminalProbe.factory.mockImplementation(() => new ProbeSocket());
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: 'authentication_required' }, { status: 401 }),
    );
    render(
      <AuthenticatedRoot
        api={api()}
        fetchImpl={fetchImpl}
        loadConfig={vi.fn(async () => config)}
        settingsApi={manualSettingsApi()}
      />,
    );

    await waitFor(() =>
      expect(terminalAuthSuspensionCountsForTests()).toEqual({
        activeIds: 1,
        registrations: 1,
        suspensions: 0,
      }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Expire terminal auth' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'operator' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Reconnect terminal' });
    await waitFor(() =>
      expect(terminalAuthSuspensionCountsForTests()).toEqual({
        activeIds: 1,
        registrations: 1,
        suspensions: 1,
      }),
    );

    expect(terminalProbe.factory).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect terminal' }));
    expect(terminalProbe.factory).toHaveBeenCalledTimes(2);
    expect(terminalAuthSuspensionCountsForTests().suspensions).toBe(0);
  });
});
