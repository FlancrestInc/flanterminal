import { parseSetupRequest, type AuthBootstrap } from '@flanterminal/shared';
import { useEffect, useRef, useState } from 'react';

import type { AuthStatus } from './useAuth.js';

export type LoginScreenProps = Readonly<{
  status: Extract<AuthStatus, 'unauthenticated' | 'access-error'>;
  bootstrap: AuthBootstrap | null;
  busy: boolean;
  error: string | null;
  onSetup: (password: string) => Promise<void>;
  onLogin: (username: string, password: string) => Promise<void>;
  onRetry: () => Promise<void>;
}>;

export function LoginScreen({
  status,
  bootstrap,
  busy,
  error,
  onSetup,
  onLogin,
  onRetry,
}: LoginScreenProps) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const setup = setupBootstrap(bootstrap);
  const setupUsername = setup?.username ?? null;
  const previousSetupUsernameRef = useRef(setupUsername);
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirmation, setSetupConfirmation] = useState('');
  const [setupError, setSetupError] = useState<SetupError>(null);
  const isBusy = busy || pending;

  useEffect(() => {
    if (status === 'unauthenticated' && (error !== null || setupError !== null))
      passwordRef.current?.focus();
  }, [error, setupError, status]);

  useEffect(() => {
    if (previousSetupUsernameRef.current === setupUsername) return;
    previousSetupUsernameRef.current = setupUsername;
    setSetupPassword('');
    setSetupConfirmation('');
    setSetupError(null);
  }, [setupUsername]);

  const runOnce = async (operation: () => Promise<void>) => {
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await operation();
    } catch {
      // The owning authentication state provides the bounded user-facing error.
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  if (status === 'access-error') {
    return (
      <main className="login-shell">
        <section
          className="access-state"
          aria-labelledby="access-title"
          aria-busy={isBusy}
        >
          <h1 id="access-title">Terminal access</h1>
          <p role="alert">{error ?? 'Access could not be verified.'}</p>
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void runOnce(onRetry)}
          >
            Retry
          </button>
        </section>
      </main>
    );
  }

  if (setup !== null) {
    const controllerError = boundedSetupError(error);
    const localError = setupErrorMessage(setupError);
    const visibleError = localError ?? controllerError;
    const passwordInvalid =
      setupError === 'password' ||
      (setupError === null &&
        controllerError === 'Password could not be accepted.');
    const confirmationInvalid = setupError === 'mismatch';
    const passwordDescription = passwordInvalid
      ? 'setup-requirement setup-error'
      : 'setup-requirement';

    return (
      <main className="login-shell">
        <form
          key="setup"
          className="login-form"
          aria-labelledby="setup-title"
          aria-busy={isBusy}
          onSubmit={(event) => {
            event.preventDefault();
            if (isBusy) return;
            if (setupPassword !== setupConfirmation) {
              setSetupError('mismatch');
              return;
            }
            try {
              parseSetupRequest({ password: setupPassword });
            } catch {
              setSetupError('password');
              return;
            }
            setSetupError(null);
            void runOnce(async () => {
              try {
                await onSetup(setupPassword);
              } finally {
                setSetupPassword('');
                setSetupConfirmation('');
              }
            });
          }}
        >
          <h1 id="setup-title">Set up FlanTerminal</h1>
          <label htmlFor="setup-username">Username</label>
          <input
            id="setup-username"
            name="username"
            type="text"
            value={setup.username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            readOnly
            disabled={isBusy}
          />
          <label htmlFor="setup-password">New Password</label>
          <input
            id="setup-password"
            ref={passwordRef}
            name="password"
            type="password"
            value={setupPassword}
            autoComplete="new-password"
            required
            disabled={isBusy}
            autoFocus
            aria-invalid={passwordInvalid ? true : undefined}
            aria-describedby={passwordDescription}
            onChange={(event) => {
              setSetupPassword(event.target.value);
              setSetupError(null);
            }}
          />
          <p id="setup-requirement" className="login-help">
            12 to 72 UTF-8 bytes.
          </p>
          <label htmlFor="setup-confirmation">Confirm password</label>
          <input
            id="setup-confirmation"
            name="password-confirmation"
            type="password"
            value={setupConfirmation}
            autoComplete="new-password"
            required
            disabled={isBusy}
            aria-invalid={confirmationInvalid ? true : undefined}
            aria-describedby={confirmationInvalid ? 'setup-error' : undefined}
            onChange={(event) => {
              setSetupConfirmation(event.target.value);
              setSetupError(null);
            }}
          />
          {visibleError === null ? null : (
            <p id="setup-error" role="alert">
              {visibleError}
            </p>
          )}
          <button type="submit" disabled={isBusy}>
            {isBusy ? 'Creating administrator' : 'Create administrator'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="login-shell">
      <form
        key="login"
        className="login-form"
        aria-labelledby="login-title"
        aria-busy={isBusy}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void runOnce(() =>
            onLogin(
              String(data.get('username') ?? ''),
              String(data.get('password') ?? ''),
            ),
          );
        }}
      >
        <h1 id="login-title">Sign in</h1>
        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={isBusy}
          autoFocus
        />
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          ref={passwordRef}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={isBusy}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : 'login-error'}
        />
        {error === null ? null : (
          <p id="login-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={isBusy}>
          {isBusy ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}

type SetupError = 'mismatch' | 'password' | null;

const SETUP_CONTROLLER_ERRORS = new Set([
  'Too many setup attempts. Try again shortly.',
  'Password could not be accepted.',
  'Setup could not be completed. Try again.',
  'Setup status could not be verified. Try again.',
  'Administrator already created. Sign in to continue.',
  'Administrator created. Sign in to continue.',
]);

function setupBootstrap(
  bootstrap: AuthBootstrap | null,
): Extract<AuthBootstrap, { setupRequired: true }> | null {
  return bootstrap?.authenticated === false &&
    bootstrap.mode === 'local' &&
    'setupRequired' in bootstrap &&
    bootstrap.setupRequired === true
    ? bootstrap
    : null;
}

function setupErrorMessage(error: SetupError): string | null {
  if (error === 'mismatch') return 'Passwords do not match.';
  if (error === 'password')
    return 'Password must be 12 to 72 UTF-8 bytes and contain no NUL characters.';
  return null;
}

function boundedSetupError(error: string | null): string | null {
  if (error === null) return null;
  return SETUP_CONTROLLER_ERRORS.has(error)
    ? error
    : 'Setup could not be completed. Try again.';
}
