import type {
  AuthBootstrap,
  LoginRequest,
  PasswordChangeRequest,
  SetupRequest,
} from '@flanterminal/shared';
import { createContext, useCallback, useEffect, useRef, useState } from 'react';

import { AuthApiError, type AuthApi } from './auth-api.js';
import {
  basePathFromDocument,
  composeAbortSignals,
  privateRequestUrl,
  type PrivateRequestBoundary,
} from './private-request-authority.js';
import { suspendActiveTerminalAuthLifecycles } from './terminal-auth-suspension.js';

const REFRESH_LEAD_MS = 60_000;
// Revalidate before the server's five-minute minimum application idle bound.
const MINIMUM_APPLICATION_IDLE_MS = 5 * 60_000;
const TRUSTED_HEADER_REFRESH_MS = MINIMUM_APPLICATION_IDLE_MS - REFRESH_LEAD_MS;
const ACCESS_ERROR = 'Access could not be verified.';
const SIGN_IN_ERROR = 'Sign-in failed.';
const RATE_LIMIT_ERROR = 'Too many attempts. Try again later.';
const REQUEST_ERROR = 'Unable to complete the request.';
const PASSWORD_ERROR = 'Unable to change password.';
const SETUP_RATE_LIMIT_ERROR = 'Too many setup attempts. Try again shortly.';
const SETUP_PASSWORD_ERROR = 'Password could not be accepted.';
const SETUP_RETRY_ERROR = 'Setup could not be completed. Try again.';
const SETUP_VERIFY_ERROR = 'Setup status could not be verified. Try again.';
const SETUP_COMPLETED_ERROR =
  'Administrator already created. Sign in to continue.';
const SETUP_AMBIGUOUS_COMPLETED_ERROR =
  'Administrator created. Sign in to continue.';

export type AuthStatus =
  'loading' | 'unauthenticated' | 'authenticated' | 'access-error';

export type AuthenticationRequiredHandler = () => void;

export const AuthenticationRequiredContext =
  createContext<AuthenticationRequiredHandler | null>(null);

export type UseAuthOptions = Readonly<{
  fetchImpl?: typeof fetch;
  basePath?: string;
  baseUrl?: string;
}>;

export interface AuthController {
  readonly status: AuthStatus;
  readonly bootstrap: AuthBootstrap | null;
  readonly error: string | null;
  readonly passwordError: string | null;
  readonly busy: boolean;
  readonly epoch: number;
  readonly setup: (password: string) => Promise<void>;
  readonly login: (username: string, password: string) => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  readonly privateFetch: typeof fetch;
  readonly authenticationRequired: AuthenticationRequiredHandler;
}

export function useAuth(
  api: AuthApi,
  options: UseAuthOptions = {},
): AuthController {
  const fetchImpl = options.fetchImpl ?? fetch;
  const privateBoundaryRef = useRef<PrivateRequestBoundary>({
    basePath:
      options.basePath ??
      basePathFromDocument(options.baseUrl ?? document.baseURI),
    baseUrl: options.baseUrl ?? document.baseURI,
  });
  privateBoundaryRef.current = {
    basePath: options.basePath ?? privateBoundaryRef.current.basePath,
    baseUrl: options.baseUrl ?? privateBoundaryRef.current.baseUrl,
  };
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [bootstrap, setBootstrap] = useState<AuthBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const mountedRef = useRef(true);
  const bootstrapRef = useRef<AuthBootstrap | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const privateRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const replaceOperation = useCallback(() => {
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    return controller;
  }, []);

  const isCurrentOperation = useCallback(
    (operation: AbortController) =>
      mountedRef.current &&
      operationRef.current === operation &&
      !operation.signal.aborted,
    [],
  );

  const publish = useCallback(
    (next: AuthBootstrap, message: string | null = null) => {
      if (!mountedRef.current) return;
      cancelRefresh();
      const continuesAuthenticatedEpoch =
        bootstrapRef.current?.authenticated === true && next.authenticated;
      bootstrapRef.current = next;
      setBootstrap(next);
      setError(message);
      if (!continuesAuthenticatedEpoch) setPasswordError(null);
      if (next.authenticated) {
        if (!continuesAuthenticatedEpoch) {
          privateRef.current?.abort();
          privateRef.current = new AbortController();
          setEpoch((current) => current + 1);
        }
        setStatus('authenticated');
      } else {
        privateRef.current?.abort();
        privateRef.current = null;
        if (next.mode === 'local') {
          setStatus('unauthenticated');
        } else {
          setStatus('access-error');
          setError(ACCESS_ERROR);
        }
      }
    },
    [cancelRefresh],
  );

  const authenticationRequired = useCallback(() => {
    const previous = bootstrapRef.current;
    if (previous === null) return;
    suspendActiveTerminalAuthLifecycles();
    cancelRefresh();
    operationRef.current?.abort();
    operationRef.current = null;
    privateRef.current?.abort();
    privateRef.current = null;
    bootstrapRef.current = null;
    if (!mountedRef.current) return;
    setBootstrap(null);
    setBusy(false);
    setPasswordError(null);
    if (previous?.mode === 'local') {
      setStatus('unauthenticated');
      setError(null);
    } else {
      setStatus('access-error');
      setError(ACCESS_ERROR);
    }
  }, [cancelRefresh]);

  const bootstrapSession = useCallback(async () => {
    const operation = replaceOperation();
    if (mountedRef.current) {
      setStatus('loading');
      setError(null);
      setBusy(false);
    }
    try {
      const next = await api.bootstrap(operation.signal);
      if (isCurrentOperation(operation)) publish(next);
    } catch (reason) {
      if (isAbortError(reason) || !isCurrentOperation(operation)) return;
      bootstrapRef.current = null;
      setBootstrap(null);
      setStatus('access-error');
      setError(ACCESS_ERROR);
    } finally {
      if (operationRef.current === operation) operationRef.current = null;
    }
  }, [api, isCurrentOperation, publish, replaceOperation]);

  useEffect(() => {
    mountedRef.current = true;
    void bootstrapSession();
    return () => {
      mountedRef.current = false;
      cancelRefresh();
      operationRef.current?.abort();
      operationRef.current = null;
      privateRef.current?.abort();
      privateRef.current = null;
    };
  }, [bootstrapSession, cancelRefresh]);

  useEffect(() => {
    if (!bootstrap?.authenticated) return;
    const delay = refreshDelay(bootstrap);
    if (delay === undefined) return;
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      const operation = replaceOperation();
      void api
        .refresh(bootstrap.csrfToken, operation.signal)
        .then((next) => {
          if (!isCurrentOperation(operation)) return;
          if (!isConsistentRefresh(bootstrap, next)) {
            authenticationRequired();
            return;
          }
          publish(next);
        })
        .catch((reason: unknown) => {
          if (!isAbortError(reason) && isCurrentOperation(operation))
            authenticationRequired();
        })
        .finally(() => {
          if (operationRef.current === operation) operationRef.current = null;
        });
    }, delay);
    return cancelRefresh;
  }, [
    api,
    authenticationRequired,
    bootstrap,
    cancelRefresh,
    isCurrentOperation,
    publish,
    refreshRevision,
    replaceOperation,
  ]);

  useEffect(() => {
    const onPageHide = () => {
      cancelRefresh();
      operationRef.current?.abort();
      operationRef.current = null;
      privateRef.current?.abort();
      privateRef.current = null;
      bootstrapRef.current = null;
      setBootstrap(null);
      setBusy(false);
      setError(null);
      setPasswordError(null);
      setStatus('loading');
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void bootstrapSession();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [bootstrapSession, cancelRefresh]);

  const login = useCallback(
    async (username: string, password: string) => {
      const operation = replaceOperation();
      setBusy(true);
      setError(null);
      try {
        const input: LoginRequest = { username, password };
        const next = await api.login(input, operation.signal);
        if (isCurrentOperation(operation)) publish(next);
      } catch (reason) {
        if (isAbortError(reason) || !isCurrentOperation(operation)) return;
        setError(
          reason instanceof AuthApiError && reason.code === 'rate_limited'
            ? RATE_LIMIT_ERROR
            : SIGN_IN_ERROR,
        );
      } finally {
        const isCurrent = operationRef.current === operation;
        if (isCurrent) operationRef.current = null;
        if (isCurrent && mountedRef.current) setBusy(false);
      }
    },
    [api, isCurrentOperation, publish, replaceOperation],
  );

  const setup = useCallback(
    async (password: string) => {
      if (!isSetupRequired(bootstrapRef.current)) return;
      const operation = replaceOperation();
      setBusy(true);
      setError(null);
      try {
        const input: SetupRequest = { password };
        const next = await api.setup(input, operation.signal);
        if (isCurrentOperation(operation)) publish(next);
      } catch (reason) {
        if (isAbortError(reason) || !isCurrentOperation(operation)) return;
        if (
          reason instanceof AuthApiError &&
          (reason.code === 'rate_limited' || reason.code === 'invalid_request')
        ) {
          setError(
            reason.code === 'rate_limited'
              ? SETUP_RATE_LIMIT_ERROR
              : SETUP_PASSWORD_ERROR,
          );
          return;
        }

        const conflict =
          reason instanceof AuthApiError &&
          reason.code === 'setup_already_completed';
        try {
          const recovered = await api.bootstrap(operation.signal);
          if (!isCurrentOperation(operation)) return;
          publish(recovered, setupRecoveryMessage(recovered, conflict));
        } catch (recoveryReason) {
          if (isAbortError(recoveryReason) || !isCurrentOperation(operation))
            return;
          setError(SETUP_VERIFY_ERROR);
        }
      } finally {
        const isCurrent = operationRef.current === operation;
        if (isCurrent) operationRef.current = null;
        if (isCurrent && mountedRef.current) setBusy(false);
      }
    },
    [api, isCurrentOperation, publish, replaceOperation],
  );

  const logout = useCallback(async () => {
    const current = bootstrapRef.current;
    if (!current?.authenticated) return;
    cancelRefresh();
    const operation = replaceOperation();
    setBusy(true);
    setError(null);
    try {
      await api.logout(current.csrfToken, operation.signal);
      if (isCurrentOperation(operation)) authenticationRequired();
    } catch (reason) {
      if (isAbortError(reason) || !isCurrentOperation(operation)) return;
      if (isAuthenticationLoss(reason)) authenticationRequired();
      else {
        setError(REQUEST_ERROR);
        setRefreshRevision((revision) => revision + 1);
      }
    } finally {
      const isCurrent = operationRef.current === operation;
      if (isCurrent) operationRef.current = null;
      if (isCurrent && mountedRef.current) setBusy(false);
    }
  }, [
    api,
    authenticationRequired,
    cancelRefresh,
    isCurrentOperation,
    replaceOperation,
  ]);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      const current = bootstrapRef.current;
      if (!current?.authenticated) return;
      cancelRefresh();
      const operation = replaceOperation();
      setBusy(true);
      setPasswordError(null);
      try {
        const input: PasswordChangeRequest = {
          currentPassword,
          newPassword,
        };
        await api.changePassword(current.csrfToken, input, operation.signal);
        if (isCurrentOperation(operation)) authenticationRequired();
      } catch (reason) {
        if (isAbortError(reason) || !isCurrentOperation(operation)) return;
        if (isAuthenticationLoss(reason)) authenticationRequired();
        else {
          setPasswordError(PASSWORD_ERROR);
          setRefreshRevision((revision) => revision + 1);
        }
      } finally {
        const isCurrent = operationRef.current === operation;
        if (isCurrent) operationRef.current = null;
        if (isCurrent && mountedRef.current) setBusy(false);
      }
    },
    [
      api,
      authenticationRequired,
      cancelRefresh,
      isCurrentOperation,
      replaceOperation,
    ],
  );

  const privateFetch = useCallback<typeof fetch>(
    async (input, init) => {
      const current = bootstrapRef.current;
      const privateController = privateRef.current;
      if (!current?.authenticated || privateController === null)
        throw new AuthApiError('authentication_required', 401);
      if (privateRequestUrl(input, privateBoundaryRef.current) === undefined)
        throw new AuthApiError();
      const method = requestMethod(input, init);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      if (method !== 'GET' && method !== 'HEAD')
        headers.set('X-CSRF-Token', current.csrfToken);
      const requestSignal = input instanceof Request ? input.signal : undefined;
      const composed = composeAbortSignals(
        [privateController.signal, requestSignal, init?.signal].filter(
          (signal): signal is AbortSignal => signal !== undefined,
        ),
      );
      try {
        if (composed.signal.aborted) throw abortReason(composed.signal);
        const response = await fetchImpl(input, {
          ...init,
          cache: 'no-store',
          credentials: 'include',
          headers,
          signal: composed.signal,
        });
        if (composed.signal.aborted) throw abortReason(composed.signal);
        if (
          response.status === 401 &&
          privateRef.current === privateController &&
          !privateController.signal.aborted
        )
          authenticationRequired();
        return response;
      } catch (reason) {
        if (composed.signal.aborted) throw abortReason(composed.signal);
        if (isAbortError(reason)) throw reason;
        throw new AuthApiError();
      } finally {
        composed.dispose();
      }
    },
    [authenticationRequired, fetchImpl],
  );

  return {
    status,
    bootstrap,
    error,
    passwordError,
    busy,
    epoch,
    setup,
    login,
    retry: bootstrapSession,
    logout,
    changePassword,
    privateFetch,
    authenticationRequired,
  };
}

function isSetupRequired(
  bootstrap: AuthBootstrap | null,
): bootstrap is Extract<AuthBootstrap, { setupRequired: true }> {
  return (
    bootstrap?.authenticated === false &&
    'setupRequired' in bootstrap &&
    bootstrap.setupRequired
  );
}

function setupRecoveryMessage(
  bootstrap: AuthBootstrap,
  conflict: boolean,
): string | null {
  if (bootstrap.authenticated) return null;
  if (isSetupRequired(bootstrap)) return SETUP_RETRY_ERROR;
  return conflict ? SETUP_COMPLETED_ERROR : SETUP_AMBIGUOUS_COMPLETED_ERROR;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (
    init?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Request cancelled', 'AbortError');
}

function isAuthenticationLoss(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 401;
}

function isConsistentRefresh(
  previous: Extract<AuthBootstrap, { authenticated: true }>,
  next: AuthBootstrap,
): next is Extract<AuthBootstrap, { authenticated: true }> {
  if (
    !next.authenticated ||
    next.mode !== previous.mode ||
    next.identityLabel !== previous.identityLabel
  )
    return false;
  if (previous.upstreamExpiresAt === undefined) return true;
  return (
    next.upstreamExpiresAt !== undefined &&
    Date.parse(next.upstreamExpiresAt) > Date.parse(previous.upstreamExpiresAt)
  );
}

function refreshDelay(
  bootstrap: Extract<AuthBootstrap, { authenticated: true }>,
): number | undefined {
  if (
    bootstrap.mode !== 'cloudflare-access' &&
    bootstrap.mode !== 'trusted-header'
  )
    return undefined;
  if (bootstrap.upstreamExpiresAt !== undefined) {
    return Math.max(
      0,
      Date.parse(bootstrap.upstreamExpiresAt) - Date.now() - REFRESH_LEAD_MS,
    );
  }
  return bootstrap.mode === 'trusted-header'
    ? TRUSTED_HEADER_REFRESH_MS
    : undefined;
}
