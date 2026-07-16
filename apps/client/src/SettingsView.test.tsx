// @vitest-environment jsdom

import {
  terminalPaletteKeys,
  type SettingsResponse,
  type WorkspaceSettings,
} from '@flanterminal/shared';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
    customTerminalPalette: {
      background: '#101827',
      foreground: '#DCE8FF',
      cursor: '#82B1FF',
      cursorAccent: '#101827',
      selectionBackground: '#294A82',
      black: '#152238',
      red: '#FF7B8B',
      green: '#74D99F',
      yellow: '#F6CB6C',
      blue: '#82B1FF',
      magenta: '#D8A0FF',
      cyan: '#76D7EA',
      white: '#DCE8FF',
      brightBlack: '#4A5D80',
      brightRed: '#FF9EAA',
      brightGreen: '#99E9B6',
      brightYellow: '#FFDA91',
      brightBlue: '#A8C8FF',
      brightMagenta: '#EDB9FF',
      brightCyan: '#A8E8F5',
      brightWhite: '#FFFFFF',
    },
  },
  limits: {
    fontFamilies: [
      'jetbrains-mono-nerd',
      'system-monospace',
      'dejavu-sans-mono',
      'noto-sans-mono',
      'liberation-mono',
      'courier',
    ],
    fontSize: { min: 10, max: 24, step: 1 },
    lineHeight: { min: 1, max: 1.5, step: 0.05 },
    letterSpacing: { min: 0, max: 2, step: 1 },
    scrollback: { min: 1000, max: 50_000, step: 1000 },
    themes: [
      'dark',
      'light',
      'ubuntu',
      'midnight-electric',
      'aurora-night',
      'carbon-violet',
      'custom',
    ],
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
        settingsBusy={false}
        settingsError={null}
        passwordBusy={false}
        passwordError={null}
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
    expect(
      screen.getByRole('radiogroup', { name: 'Theme' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Ubuntu' }));
    expect(screen.getByRole('radio', { name: 'Ubuntu' })).toBeChecked();
    expect(
      screen.getByRole('radiogroup', { name: 'Cursor style' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Bar' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cursor blinking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0]).toEqual({
      ...response.settings,
      theme: 'ubuntu',
      cursorStyle: 'bar',
      cursorBlink: false,
    });
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
  });

  it('labels font availability and edits custom terminal colors', async () => {
    const onSave = vi.fn<(settings: WorkspaceSettings) => Promise<void>>(
      async () => undefined,
    );
    render(
      <SettingsView
        response={response}
        settingsBusy={false}
        settingsError={null}
        passwordBusy={false}
        passwordError={null}
        authMode="none"
        onSave={onSave}
        onBack={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('option', {
        name: 'JetBrains Mono Nerd Font (bundled)',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: 'DejaVu Sans Mono — uses system font when available',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: 'Noto Sans Mono — uses system font when available',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: 'Liberation Mono — uses system font when available',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: 'Courier — uses system font when available',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Terminal colors' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(
      screen.getByRole('heading', { name: 'Terminal colors' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Background color')).toHaveAttribute(
      'type',
      'color',
    );
    expect(screen.getByLabelText('Background hex')).toHaveValue('#101827');
    expect(screen.getByLabelText('Bright White hex')).toHaveValue('#FFFFFF');
    expect(
      screen.queryByLabelText('Cursor accent hex'),
    ).not.toBeInTheDocument();
    for (const key of terminalPaletteKeys.filter(
      (paletteKey) => paletteKey !== 'cursorAccent',
    )) {
      const label = key
        .replace(/([a-z])([A-Z])/gu, '$1 $2')
        .replace(/^./u, (letter) => letter.toUpperCase());
      expect(screen.getByLabelText(`${label} color`)).toHaveAttribute(
        'type',
        'color',
      );
      expect(screen.getByLabelText(`${label} hex`)).toBeInTheDocument();
    }

    fireEvent.change(screen.getByLabelText('Background hex'), {
      target: { value: '#123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0]![0].customTerminalPalette).toMatchObject({
      background: '#123456',
      cursorAccent: '#123456',
    });
  });

  it('blocks a malformed custom terminal color with an accessible error', () => {
    const onSave = vi.fn();
    render(
      <SettingsView
        response={response}
        settingsBusy={false}
        settingsError={null}
        passwordBusy={false}
        passwordError={null}
        authMode="none"
        onSave={onSave}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Foreground hex'), {
      target: { value: '#invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Foreground hex')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(
      screen.getByText('Enter a six-digit hex color, such as #DCE8FF.'),
    ).toHaveAttribute('role', 'alert');
  });

  it('blocks invalid palette values after switching from Custom to a preset', () => {
    const onSave = vi.fn();
    render(
      <SettingsView
        response={response}
        settingsBusy={false}
        settingsError={null}
        passwordBusy={false}
        passwordError={null}
        authMode="none"
        onSave={onSave}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Foreground hex'), {
      target: { value: '#invalid' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Terminal colors contain invalid hex values.',
    );
  });

  it('keeps passwords local to the form and clears them after local password change', async () => {
    const onChangePassword = vi.fn(async () => undefined);
    render(
      <SettingsView
        response={response}
        settingsBusy={false}
        settingsError={null}
        passwordBusy={false}
        passwordError={null}
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
        settingsBusy={false}
        settingsError={null}
        passwordBusy={false}
        passwordError={null}
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
          settings: {
            ...response.settings,
            fontSize: 16,
            theme: 'light',
            cursorStyle: 'underline',
          },
        }}
        settingsBusy
        settingsError="Unable to save settings."
        passwordBusy={false}
        passwordError={null}
        authMode="none"
        onSave={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Font size')).toHaveValue(16);
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Light' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Underline' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Underline' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to save settings.',
    );
  });

  it('keeps settings and password errors adjacent to their independent forms', () => {
    const view = render(
      <SettingsView
        response={response}
        settingsBusy={false}
        settingsError="Unable to save settings."
        passwordBusy={false}
        passwordError="Unable to change password."
        authMode="local"
        onSave={vi.fn()}
        onBack={vi.fn()}
        onChangePassword={vi.fn()}
      />,
    );
    const forms = document.querySelectorAll('form');
    expect(within(forms[0]!).getByRole('alert')).toHaveTextContent(
      'Unable to save settings.',
    );
    expect(within(forms[1]!).getByRole('alert')).toHaveTextContent(
      'Unable to change password.',
    );

    view.rerender(
      <SettingsView
        response={response}
        settingsBusy={false}
        settingsError={null}
        passwordBusy={false}
        passwordError="Unable to change password."
        authMode="local"
        onSave={vi.fn()}
        onBack={vi.fn()}
        onChangePassword={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to change password.',
    );
    expect(forms[1]).toContainElement(screen.getByRole('alert'));
  });
});
