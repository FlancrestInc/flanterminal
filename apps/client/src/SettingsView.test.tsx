// @vitest-environment jsdom

import type { SettingsResponse, WorkspaceSettings } from '@flanterminal/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SettingsView } from './SettingsView.js';
import './test/setup.js';

const response = {
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
    fontSize: { min: 10, max: 24, step: 1 },
    lineHeight: { min: 1, max: 1.5, step: 0.05 },
    letterSpacing: { min: 0, max: 2, step: 1 },
    scrollback: { min: 1000, max: 50_000, step: 1000 },
    themes: ['dark', 'light', 'ubuntu'],
    cursorStyles: ['block', 'underline', 'bar'],
    bellBehaviors: ['none', 'visual', 'sound'],
    reconnectBehaviors: ['automatic', 'manual'],
    workspaceShortcutModes: ['default', 'disabled'],
    tmuxHistoryLimit: { min: 0, max: 100_000, step: 1000 },
    staleSessionCleanupHours: { min: 0, max: 168, step: 1 },
  },
  allowedShells: ['/bin/bash', '/bin/zsh'],
} satisfies SettingsResponse;

describe('SettingsView', () => {
  it('renders bounded, labeled settings and submits a complete replacement', async () => {
    const onSave = vi.fn<(settings: WorkspaceSettings) => Promise<void>>(
      async () => undefined,
    );
    render(
      <SettingsView
        response={response}
        busy={false}
        error={null}
        authMode="cloudflare-access"
        onSave={onSave}
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Settings' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Font size')).toHaveAttribute('min', '10');
    expect(screen.getByLabelText('Font size')).toHaveAttribute('max', '24');
    expect(screen.getByLabelText('Scrollback lines')).toHaveAttribute(
      'step',
      '1000',
    );
    fireEvent.change(screen.getByLabelText('Theme'), {
      target: { value: 'ubuntu' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor blinking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0]).toEqual({
      ...response.settings,
      theme: 'ubuntu',
      cursorBlink: false,
    });
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  });

  it('keeps passwords local to the form and clears them after local password change', async () => {
    const onChangePassword = vi.fn(async () => undefined);
    render(
      <SettingsView
        response={response}
        busy={false}
        error={null}
        authMode="local"
        onSave={vi.fn()}
        onBack={vi.fn()}
        onChangePassword={onChangePassword}
      />,
    );
    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'current secret' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'replacement secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() =>
      expect(onChangePassword).toHaveBeenCalledWith(
        'current secret',
        'replacement secret',
      ),
    );
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });

  it('replaces form authority when a server response arrives and exposes busy/error states', () => {
    const view = render(
      <SettingsView
        response={response}
        busy={false}
        error={null}
        authMode="none"
        onSave={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Font size'), {
      target: { value: '18' },
    });
    view.rerender(
      <SettingsView
        response={{
          ...response,
          settings: { ...response.settings, fontSize: 16 },
        }}
        busy
        error="Unable to save settings."
        authMode="none"
        onSave={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Font size')).toHaveValue(16);
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to save settings.',
    );
  });
});
