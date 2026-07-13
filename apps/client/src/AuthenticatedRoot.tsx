import type { ClientConfig, SettingsResponse } from '@flanterminal/shared';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { App, StartupState } from './App.js';
import { createAuthApi, type AuthApi } from './auth-api.js';
import { loadClientConfig, type LoadClientConfigOptions } from './config.js';
import { LoginScreen } from './LoginScreen.js';
import { createSettingsApi, type SettingsApi } from './settings-api.js';
import { createTabsApi } from './tabs-api.js';
import {
  AuthenticationRequiredContext,
  useAuth,
  type AuthenticationRequiredHandler,
} from './useAuth.js';
import { useSettings } from './useSettings.js';

type ConfigLoader = (
  options?: LoadClientConfigOptions,
) => Promise<ClientConfig>;

export type AuthenticatedRootProps = Readonly<{
  api?: AuthApi;
  fetchImpl?: typeof fetch;
  loadConfig?: ConfigLoader;
  settingsApi?: SettingsApi;
  renderWorkspace?: (
    config: ClientConfig,
    privateFetch: typeof fetch,
    onAuthenticationRequired: AuthenticationRequiredHandler,
    settings: SettingsResponse,
  ) => ReactNode;
}>;

export function AuthenticatedRoot({
  api: suppliedApi,
  fetchImpl,
  loadConfig = loadClientConfig,
  settingsApi: suppliedSettingsApi,
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
  const settingsApi = useMemo(
    () =>
      suppliedSettingsApi ??
      (loaded.config === null
        ? null
        : createSettingsApi(loaded.config.basePath, auth.privateFetch)),
    [auth.privateFetch, loaded.config, suppliedSettingsApi],
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
  if (settingsApi === null) return <StartupState state="loading" />;

  return (
    <AuthenticationRequiredContext.Provider value={auth.authenticationRequired}>
      <SettingsWorkspace
        config={loaded.config}
        api={settingsApi}
        privateFetch={auth.privateFetch}
        onAuthenticationRequired={auth.authenticationRequired}
        renderWorkspace={renderWorkspace}
        tabsApi={tabsApi}
        authMode={auth.bootstrap?.mode ?? 'none'}
        authBusy={auth.busy}
        passwordError={auth.passwordError}
        onChangePassword={auth.changePassword}
      />
    </AuthenticationRequiredContext.Provider>
  );
}

function SettingsWorkspace({
  config,
  api,
  privateFetch,
  onAuthenticationRequired,
  renderWorkspace,
  tabsApi,
  authMode,
  authBusy,
  passwordError,
  onChangePassword,
}: Readonly<{
  config: ClientConfig;
  api: SettingsApi;
  privateFetch: typeof fetch;
  onAuthenticationRequired: AuthenticationRequiredHandler;
  renderWorkspace: AuthenticatedRootProps['renderWorkspace'];
  tabsApi: ReturnType<typeof createTabsApi>;
  authMode: 'local' | 'cloudflare-access' | 'trusted-header' | 'none';
  authBusy: boolean;
  passwordError: string | null;
  onChangePassword: (current: string, replacement: string) => Promise<void>;
}>) {
  const settings = useSettings(api, { onAuthenticationRequired });
  if (settings.loading && settings.response === null)
    return <StartupState state="loading" />;
  if (settings.response === null)
    return (
      <StartupState
        state="error"
        message="Unable to load settings."
        onRetry={() => void settings.retry()}
      />
    );
  return (
    renderWorkspace?.(
      config,
      privateFetch,
      onAuthenticationRequired,
      settings.response,
    ) ?? (
      <App
        config={config}
        api={tabsApi}
        settingsResponse={settings.response}
        settingsBusy={settings.busy}
        settingsError={settings.error}
        passwordBusy={authBusy}
        passwordError={passwordError}
        onSaveSettings={settings.save}
        authMode={authMode}
        onChangePassword={onChangePassword}
      />
    )
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
