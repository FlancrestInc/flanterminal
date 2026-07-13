import { useEffect, useRef, useState } from 'react';

import type { AuthStatus } from './useAuth.js';

export type LoginScreenProps = Readonly<{
  status: Extract<AuthStatus, 'unauthenticated' | 'access-error'>;
  busy: boolean;
  error: string | null;
  onLogin: (username: string, password: string) => Promise<void>;
  onRetry: () => Promise<void>;
}>;

export function LoginScreen({
  status,
  busy,
  error,
  onLogin,
  onRetry,
}: LoginScreenProps) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const isBusy = busy || pending;

  useEffect(() => {
    if (status === 'unauthenticated' && error !== null)
      passwordRef.current?.focus();
  }, [error, status]);

  const runOnce = async (operation: () => Promise<void>) => {
    if (pendingRef.current || busy) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await operation();
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

  return (
    <main className="login-shell">
      <form
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
