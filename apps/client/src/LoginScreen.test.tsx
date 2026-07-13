// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LoginScreen, type LoginScreenProps } from './LoginScreen.js';
import './test/setup.js';

function props(override: Partial<LoginScreenProps> = {}): LoginScreenProps {
  return {
    status: 'unauthenticated',
    busy: false,
    error: null,
    onLogin: vi.fn(async () => undefined),
    onRetry: vi.fn(async () => undefined),
    ...override,
  };
}

describe('LoginScreen', () => {
  it('renders a focused password-manager-friendly local login form', () => {
    render(<LoginScreen {...props()} />);

    const username = screen.getByLabelText('Username');
    const password = screen.getByLabelText('Password');
    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(username).toHaveFocus();
  });

  it('submits on the form action and blocks a duplicate while pending', async () => {
    let finish!: () => void;
    const onLogin = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<LoginScreen {...props({ onLogin })} />);
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'operator' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'private-password' },
    });
    const form = screen
      .getByRole('button', { name: 'Sign in' })
      .closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onLogin).toHaveBeenCalledOnce();
    expect(onLogin).toHaveBeenCalledWith('operator', 'private-password');
    expect(screen.getByRole('button', { name: 'Signing in' })).toBeDisabled();
    finish();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled(),
    );
  });

  it('announces a bounded login error and returns focus to the password', () => {
    const view = render(<LoginScreen {...props()} />);
    const password = screen.getByLabelText('Password');
    fireEvent.focus(password);
    fireEvent.blur(password);

    view.rerender(<LoginScreen {...props({ error: 'Sign-in failed.' })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in failed.');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveFocus();
  });

  it('shows only a concise retry action for an upstream access failure', () => {
    const onRetry = vi.fn(async () => undefined);
    render(
      <LoginScreen
        {...props({
          status: 'access-error',
          error: 'Access could not be verified.',
          onRetry,
        })}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Access could not be verified.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /Cloudflare|proxy|JWT|deployment/i,
    );
  });

  it('honors an external busy state for both authentication surfaces', () => {
    const view = render(<LoginScreen {...props({ busy: true })} />);
    expect(screen.getByLabelText('Username')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Signing in' })).toBeDisabled();

    view.rerender(
      <LoginScreen
        {...props({ status: 'access-error', busy: true, error: null })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });
});
