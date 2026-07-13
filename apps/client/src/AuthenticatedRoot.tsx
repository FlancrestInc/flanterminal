import type { ClientConfig } from '@flanterminal/shared';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { App, StartupState } from './App.js';
import { createAuthApi, type AuthApi } from './auth-api.js';
import { loadClientConfig, type LoadClientConfigOptions } from './config.js';
import { LoginScreen } from './LoginScreen.js';
import { createTabsApi } from './tabs-api.js';
import {
  AuthenticationRequiredContext,
  useAuth,
  type AuthenticationRequiredHandler,
} from './useAuth.js';

type ConfigLoader = (
  options?: LoadClientConfigOptions,
) => Promise<ClientConfig>;

export type AuthenticatedRootProps = Readonly<{
  api?: AuthApi;
  fetchImpl?: typeof fetch;
  loadConfig?: ConfigLoader;
  renderWorkspace?: (
    config: ClientConfig,
    privateFetch: typeof fetch,
    onAuthenticationRequired: AuthenticationRequiredHandler,
  ) => ReactNode;
}>;

export function AuthenticatedRoot({
  api: suppliedApi,
  fetchImpl,
  loadConfig = loadClientConfig,
  renderWorkspace,
}: AuthenticatedRootProps) {
  const [loaded, setLoaded] = useState<{
    readonly epoch: number;
    readonly config: ClientConfig | null;
    readonly failed: boolean;
  }>({ epoch: 0, config: null, failed: false });
  const api = useMemo(
    () =>
      suppliedApi ??
      createAuthApi(fetchImpl === undefined ? {} : { fetchImpl }),
    [fetchImpl, suppliedApi],
  );
  const auth = useAuth(api, {
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(loaded.config === null ? {} : { basePath: loaded.config.basePath }),
  });
  const tabsApi = useMemo(
    () =>
      loaded.config === null
        ? null
        : createTabsApi(loaded.config.basePath, auth.privateFetch),
    [auth.privateFetch, loaded.config],
  );

  useEffect(() => {
    if (auth.status !== 'authenticated') return;
    const controller = new AbortController();
    void loadConfig({
      fetchImpl: auth.privateFetch,
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted)
          setLoaded({ epoch: auth.epoch, config: next, failed: false });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && !isAbortError(reason))
          setLoaded({ epoch: auth.epoch, config: null, failed: true });
      });
    return () => controller.abort();
  }, [auth.epoch, auth.privateFetch, auth.status, loadConfig]);

  if (auth.status === 'loading') return <StartupState state="loading" />;
  if (auth.status === 'unauthenticated' || auth.status === 'access-error') {
    return (
      <LoginScreen
        status={auth.status}
        busy={auth.busy}
        error={auth.error}
        onLogin={auth.login}
        onRetry={auth.retry}
      />
    );
  }
  if (loaded.epoch !== auth.epoch) return <StartupState state="loading" />;
  if (loaded.failed) return <StartupState state="error" />;
  if (loaded.config === null) return <StartupState state="loading" />;
  if (tabsApi === null) return <StartupState state="loading" />;

  const workspace = renderWorkspace?.(
    loaded.config,
    auth.privateFetch,
    auth.authenticationRequired,
  ) ?? <App config={loaded.config} api={tabsApi} />;
  return (
    <AuthenticationRequiredContext.Provider value={auth.authenticationRequired}>
      {workspace}
    </AuthenticationRequiredContext.Provider>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
