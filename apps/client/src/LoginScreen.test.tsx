// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LoginScreen, type LoginScreenProps } from './LoginScreen.js';
import './test/setup.js';

const setupRequired = {
  authenticated: false,
  mode: 'local',
  setupRequired: true,
  username: 'operator',
} as const;

function props(override: Partial<LoginScreenProps> = {}): LoginScreenProps {
  return {
    status: 'unauthenticated',
    busy: false,
    error: null,
    bootstrap: { authenticated: false, mode: 'local' },
    onSetup: vi.fn(async () => undefined),
    onLogin: vi.fn(async () => undefined),
    onRetry: vi.fn(async () => undefined),
    ...override,
  };
}

describe('LoginScreen', () => {
  it('renders a focused password-manager-friendly administrator setup form', () => {
    render(<LoginScreen {...props({ bootstrap: setupRequired })} />);

    expect(
      screen.getByRole('heading', { name: 'Set up FlanTerminal' }),
    ).toBeInTheDocument();
    const username = screen.getByLabelText('Username');
    expect(username).toHaveValue('operator');
    expect(username).toHaveAttribute('readonly');
    expect(username).toHaveAttribute('autocomplete', 'username');

    const password = screen.getByLabelText('New Password');
    const confirmation = screen.getByLabelText('Confirm password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    expect(confirmation).toHaveAttribute('type', 'password');
    expect(confirmation).toHaveAttribute('autocomplete', 'new-password');
    expect(password).toHaveFocus();
    expect(screen.getByText('12 to 72 UTF-8 bytes.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create administrator' }),
    ).toBeEnabled();
  });

  it('keeps sign-in for local bootstrap states without the exact setup discriminant', () => {
    render(
      <LoginScreen
        {...props({
          bootstrap: {
            authenticated: false,
            mode: 'cloudflare-access',
          },
        })}
      />,
    );

    expect(
      screen.getByRole('heading', { name: 'Sign in' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Set up FlanTerminal' }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['too few bytes', '12345678901'],
    ['too many bytes', 'a'.repeat(73)],
    ['a NUL character', 'valid-password\0'],
    ['too many multibyte bytes', 'é'.repeat(37)],
  ])('rejects %s before setup submission', async (_case, passwordValue) => {
    const onSetup = vi.fn(async () => undefined);
    render(<LoginScreen {...props({ bootstrap: setupRequired, onSetup })} />);
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: passwordValue },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: passwordValue },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Create administrator' }),
    );

    expect(onSetup).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Password must be 12 to 72 UTF-8 bytes and contain no NUL characters.',
    );
    expect(screen.getByLabelText('New Password')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('New Password')).toHaveFocus();
  });

  it.each([
    ['ASCII minimum', 'a'.repeat(12)],
    ['ASCII maximum', 'a'.repeat(72)],
    ['multibyte minimum', 'é'.repeat(6)],
    ['multibyte maximum', 'é'.repeat(36)],
  ])('accepts the %s UTF-8 boundary', async (_case, passwordValue) => {
    const onSetup = vi.fn(async () => undefined);
    render(<LoginScreen {...props({ bootstrap: setupRequired, onSetup })} />);
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: passwordValue },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: passwordValue },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Create administrator' }),
    );

    await waitFor(() => expect(onSetup).toHaveBeenCalledWith(passwordValue));
  });

  it('announces a mismatch locally without clearing a useful correction', async () => {
    const onSetup = vi.fn(async () => undefined);
    render(<LoginScreen {...props({ bootstrap: setupRequired, onSetup })} />);
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'first-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'second-password' },
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Create administrator' }),
    );

    expect(onSetup).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Passwords do not match.',
    );
    expect(screen.getByLabelText('New Password')).toHaveValue('first-password');
    expect(screen.getByLabelText('Confirm password')).toHaveValue(
      'second-password',
    );
    expect(screen.getByLabelText('New Password')).toHaveFocus();
  });

  it('locks duplicate setup submissions and clears credentials when completed', async () => {
    let finish!: () => void;
    const onSetup = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<LoginScreen {...props({ bootstrap: setupRequired, onSetup })} />);
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'private-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'private-password' },
    });
    const form = screen
      .getByRole('button', { name: 'Create administrator' })
      .closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onSetup).toHaveBeenCalledOnce();
    expect(onSetup).toHaveBeenCalledWith('private-password');
    expect(
      screen.getByRole('button', { name: 'Creating administrator' }),
    ).toBeDisabled();
    finish();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create administrator' }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText('New Password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
  });

  it.each([
    'Too many setup attempts. Try again shortly.',
    'Password could not be accepted.',
    'Setup could not be completed. Try again.',
    'Setup status could not be verified. Try again.',
    'Administrator already created. Sign in to continue.',
    'Administrator created. Sign in to continue.',
  ])('announces the bounded controller setup error: %s', (error) => {
    render(<LoginScreen {...props({ bootstrap: setupRequired, error })} />);

    expect(screen.getByRole('alert')).toHaveTextContent(error);
    expect(screen.getByLabelText('New Password')).toHaveFocus();
    expect(screen.getByLabelText('New Password')).toHaveAttribute(
      'aria-describedby',
      expect.stringContaining('setup-error'),
    );
  });

  it('bounds unexpected setup error text and clears fields after external setup transition', () => {
    const view = render(
      <LoginScreen
        {...props({ bootstrap: setupRequired, error: 'private server detail' })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Setup could not be completed. Try again.',
    );
    expect(document.body.textContent).not.toContain('private server detail');
    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'private-password' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'private-password' },
    });

    view.rerender(
      <LoginScreen
        {...props({
          bootstrap: { authenticated: false, mode: 'local' },
          error: null,
        })}
      />,
    );

    expect(screen.getByLabelText('Password')).toHaveValue('');
    view.rerender(<LoginScreen {...props({ bootstrap: setupRequired })} />);
    expect(screen.getByLabelText('New Password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm password')).toHaveValue('');
  });

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

  it('contains a rejected callback and restores the form controls', async () => {
    const onLogin = vi.fn(async () => {
      throw new Error('private callback detail');
    });
    render(<LoginScreen {...props({ onLogin })} />);
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'operator' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'private-password' },
    });

    fireEvent.submit(
      screen.getByRole('button', { name: 'Sign in' }).closest('form')!,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled(),
    );
    expect(document.body.textContent).not.toContain('private callback detail');
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
