// @vitest-environment jsdom

import type { AuthBootstrap, ClientConfig } from '@flanterminal/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./App.js', () => ({
  App: () => <div>Default workspace</div>,
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
  fontSize: 14,
  scrollback: 10_000,
  resizeDebounceMs: 100,
  reconnectMaxSeconds: 8,
};

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
});
