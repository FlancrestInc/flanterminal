import {
  terminalPaletteKeys,
  type AuthMode,
  type NumericSettingLimit,
  type SettingsResponse,
  type WorkspaceSettings,
} from '@flanterminal/shared';
import { ArrowLeft, Save } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';

type EditableTerminalColorKey = Exclude<
  keyof WorkspaceSettings['customTerminalPalette'],
  'cursorAccent'
>;
const editableTerminalColorKeys = terminalPaletteKeys.filter(
  (key): key is EditableTerminalColorKey => key !== 'cursorAccent',
);
type ColorErrors = Readonly<Partial<Record<EditableTerminalColorKey, string>>>;
const hexColorPattern = /^#[0-9A-Fa-f]{6}$/;
const hexColorError = 'Enter a six-digit hex color, such as #DCE8FF.';
const paletteValidationError = 'Terminal colors contain invalid hex values.';

export type SettingsViewProps = Readonly<{
  response: SettingsResponse;
  settingsBusy: boolean;
  settingsError: string | null;
  passwordBusy: boolean;
  passwordError: string | null;
  authMode: AuthMode;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  onBack: () => void;
  onChangePassword?: (current: string, replacement: string) => Promise<void>;
}>;

export function SettingsView({
  response,
  settingsBusy,
  settingsError,
  passwordBusy,
  passwordError,
  authMode,
  onSave,
  onBack,
  onChangePassword,
}: SettingsViewProps) {
  const [form, setForm] = useState(response.settings);
  const [authority, setAuthority] = useState(response);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [colorErrors, setColorErrors] = useState<ColorErrors>({});
  const [colorValidationError, setColorValidationError] = useState<
    string | null
  >(null);

  if (authority !== response) {
    setAuthority(response);
    setForm(response.settings);
    setColorErrors({});
    setColorValidationError(null);
  }

  const set = <K extends keyof WorkspaceSettings>(
    key: K,
    value: WorkspaceSettings[K],
  ) => setForm((current) => ({ ...current, [key]: value }));
  const setTerminalColor = (key: EditableTerminalColorKey, value: string) => {
    setForm((current) => ({
      ...current,
      customTerminalPalette: {
        ...current.customTerminalPalette,
        [key]: value,
        ...(key === 'background' ? { cursorAccent: value } : {}),
      },
    }));
    setColorErrors((current) => {
      if (hexColorPattern.test(value) || current[key] === undefined) {
        const remaining = { ...current };
        delete remaining[key];
        return remaining;
      }
      return current;
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      terminalPaletteKeys.some(
        (key) => !hexColorPattern.test(form.customTerminalPalette[key]),
      )
    ) {
      const nextErrors = Object.fromEntries(
        editableTerminalColorKeys
          .filter(
            (key) => !hexColorPattern.test(form.customTerminalPalette[key]),
          )
          .map((key) => [key, hexColorError]),
      ) as ColorErrors;
      setColorErrors(nextErrors);
      setColorValidationError(paletteValidationError);
      return;
    }
    setColorValidationError(null);
    void onSave(form);
  };
  const changePassword = (event: FormEvent) => {
    event.preventDefault();
    if (onChangePassword === undefined) return;
    void onChangePassword(currentPassword, newPassword).finally(() => {
      setCurrentPassword('');
      setNewPassword('');
    });
  };
  const { limits } = response;

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <button
          className="icon-button"
          type="button"
          aria-label="Back to terminal"
          title="Back to terminal"
          onClick={onBack}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <h1>Settings</h1>
      </header>
      <div className="settings-scroll">
        <form className="settings-form" onSubmit={submit}>
          <fieldset className="settings-fieldset" disabled={settingsBusy}>
            <SettingsSection title="Appearance">
              <SegmentedField
                label="Theme"
                name="theme"
                value={form.theme}
                options={limits.themes}
                onChange={(value) =>
                  set('theme', value as WorkspaceSettings['theme'])
                }
              />
              <SelectField
                label="Font"
                value={form.fontFamily}
                options={limits.fontFamilies}
                labels={{
                  'jetbrains-mono-nerd': 'JetBrains Mono Nerd Font (bundled)',
                  'system-monospace': 'System monospace (system)',
                  'dejavu-sans-mono':
                    'DejaVu Sans Mono — uses system font when available',
                  'noto-sans-mono':
                    'Noto Sans Mono — uses system font when available',
                  'liberation-mono':
                    'Liberation Mono — uses system font when available',
                  courier: 'Courier — uses system font when available',
                }}
                onChange={(value) =>
                  set('fontFamily', value as WorkspaceSettings['fontFamily'])
                }
              />
              <NumberField
                label="Font size"
                value={form.fontSize}
                limit={limits.fontSize}
                onChange={(value) => set('fontSize', value)}
              />
              <NumberField
                label="Line height"
                value={form.lineHeight}
                limit={limits.lineHeight}
                onChange={(value) => set('lineHeight', value)}
              />
              <NumberField
                label="Letter spacing"
                value={form.letterSpacing}
                limit={limits.letterSpacing}
                onChange={(value) => set('letterSpacing', value)}
              />
              <SegmentedField
                label="Cursor style"
                name="cursor-style"
                value={form.cursorStyle}
                options={limits.cursorStyles}
                onChange={(value) =>
                  set('cursorStyle', value as WorkspaceSettings['cursorStyle'])
                }
              />
              <ToggleField
                label="Cursor blinking"
                checked={form.cursorBlink}
                onChange={(value) => set('cursorBlink', value)}
              />
              <SelectField
                label="Bell"
                value={form.bellBehavior}
                options={limits.bellBehaviors}
                onChange={(value) =>
                  set(
                    'bellBehavior',
                    value as WorkspaceSettings['bellBehavior'],
                  )
                }
              />
            </SettingsSection>

            {form.theme === 'custom' ? (
              <SettingsSection title="Terminal colors">
                <div className="terminal-colors-grid">
                  {editableTerminalColorKeys.map((key) => (
                    <TerminalColorField
                      key={key}
                      colorKey={key}
                      value={form.customTerminalPalette[key]}
                      error={colorErrors[key]}
                      onChange={(value) => setTerminalColor(key, value)}
                    />
                  ))}
                </div>
              </SettingsSection>
            ) : null}

            <SettingsSection title="Terminal behavior">
              <NumberField
                label="Scrollback lines"
                value={form.scrollback}
                limit={limits.scrollback}
                onChange={(value) => set('scrollback', value)}
              />
              <SelectField
                label="Reconnect"
                value={form.reconnectBehavior}
                options={limits.reconnectBehaviors}
                onChange={(value) =>
                  set(
                    'reconnectBehavior',
                    value as WorkspaceSettings['reconnectBehavior'],
                  )
                }
              />
              <SelectField
                label="Workspace shortcuts"
                value={form.workspaceShortcuts}
                options={limits.workspaceShortcutModes}
                onChange={(value) =>
                  set(
                    'workspaceShortcuts',
                    value as WorkspaceSettings['workspaceShortcuts'],
                  )
                }
              />
              <ToggleField
                label="Create first tab automatically"
                checked={form.automaticTabCreation}
                onChange={(value) => set('automaticTabCreation', value)}
              />
            </SettingsSection>

            <SettingsSection title="Session defaults">
              <SelectField
                label="Default shell"
                value={form.defaultShell}
                options={response.allowedShells}
                onChange={(value) => set('defaultShell', value)}
              />
              <NumberField
                label="tmux history lines"
                value={form.tmuxHistoryLimit}
                limit={limits.tmuxHistoryLimit}
                onChange={(value) => set('tmuxHistoryLimit', value)}
              />
              <NumberField
                label="Stale cleanup hours"
                value={form.staleSessionCleanupHours}
                limit={limits.staleSessionCleanupHours}
                onChange={(value) => set('staleSessionCleanupHours', value)}
              />
            </SettingsSection>
          </fieldset>

          {settingsError ? (
            <p className="settings-error" role="alert">
              {settingsError}
            </p>
          ) : null}
          {colorValidationError ? (
            <p className="settings-error" role="alert">
              {colorValidationError}
            </p>
          ) : null}
          <div className="settings-actions">
            <button
              className="primary-button"
              type="submit"
              disabled={settingsBusy}
            >
              <Save size={15} aria-hidden="true" />
              {settingsBusy ? 'Saving...' : 'Save settings'}
            </button>
          </div>
        </form>

        {authMode === 'local' && onChangePassword !== undefined ? (
          <form
            className="settings-form password-form"
            onSubmit={changePassword}
          >
            <SettingsSection title="Password">
              <label className="settings-field">
                <span>Current password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  disabled={passwordBusy}
                />
              </label>
              <label className="settings-field">
                <span>New password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  disabled={passwordBusy}
                />
              </label>
            </SettingsSection>
            {passwordError ? (
              <p className="settings-error password-error" role="alert">
                {passwordError}
              </p>
            ) : null}
            <div className="settings-actions">
              <button
                type="submit"
                disabled={
                  passwordBusy || currentPassword === '' || newPassword === ''
                }
              >
                {passwordBusy ? 'Changing password...' : 'Change password'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </main>
  );
}

function SettingsSection({
  title,
  children,
}: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      <div className="settings-grid">{children}</div>
    </section>
  );
}

function SelectField({
  label,
  value,
  options,
  labels = {},
  onChange,
}: Readonly<{
  label: string;
  value: string;
  options: readonly string[];
  labels?: Readonly<Record<string, string>>;
  onChange: (value: string) => void;
}>) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option] ?? humanize(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function SegmentedField({
  label,
  name,
  value,
  options,
  labels = {},
  onChange,
}: Readonly<{
  label: string;
  name: string;
  value: string;
  options: readonly string[];
  labels?: Readonly<Record<string, string>>;
  onChange: (value: string) => void;
}>) {
  return (
    <fieldset className="settings-segmented-field" role="radiogroup">
      <legend>{label}</legend>
      <div className="settings-segments">
        {options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            <span>{labels[option] ?? humanize(option)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NumberField({
  label,
  value,
  limit,
  onChange,
}: Readonly<{
  label: string;
  value: number;
  limit: NumericSettingLimit;
  onChange: (value: number) => void;
}>) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={limit.min}
        max={limit.max}
        step={limit.step}
        required
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: Readonly<{
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}>) {
  return (
    <label className="settings-toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function TerminalColorField({
  colorKey,
  value,
  error,
  onChange,
}: Readonly<{
  colorKey: EditableTerminalColorKey;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}>) {
  const label = humanize(colorKey);
  const colorLabel = `${label} color`;
  const hexLabel = `${label} hex`;
  const errorId = `terminal-color-${colorKey}-error`;
  const colorValue = hexColorPattern.test(value) ? value : '#000000';

  return (
    <div className="terminal-color-field">
      <span className="terminal-color-label">{label}</span>
      <input
        aria-label={colorLabel}
        type="color"
        value={colorValue}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <input
        aria-label={hexLabel}
        type="text"
        value={value}
        inputMode="text"
        spellCheck={false}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error === undefined ? null : (
        <p id={errorId} className="terminal-color-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function humanize(value: string): string {
  return value
    .replaceAll('-', ' ')
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/^./u, (letter) => letter.toUpperCase());
}
