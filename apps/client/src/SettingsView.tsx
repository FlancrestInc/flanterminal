import type {
  AuthMode,
  NumericSettingLimit,
  SettingsResponse,
  WorkspaceSettings,
} from '@flanterminal/shared';
import { ArrowLeft, Save } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';

export type SettingsViewProps = Readonly<{
  response: SettingsResponse;
  busy: boolean;
  error: string | null;
  authMode: AuthMode;
  onSave: (settings: WorkspaceSettings) => Promise<void>;
  onBack: () => void;
  onChangePassword?: (current: string, replacement: string) => Promise<void>;
}>;

export function SettingsView({
  response,
  busy,
  error,
  authMode,
  onSave,
  onBack,
  onChangePassword,
}: SettingsViewProps) {
  const [form, setForm] = useState(response.settings);
  const [authority, setAuthority] = useState(response);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  if (authority !== response) {
    setAuthority(response);
    setForm(response.settings);
  }

  const set = <K extends keyof WorkspaceSettings>(
    key: K,
    value: WorkspaceSettings[K],
  ) => setForm((current) => ({ ...current, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
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
          <fieldset className="settings-fieldset" disabled={busy}>
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
                  'jetbrains-mono-nerd': 'JetBrainsMono Nerd Font',
                  'system-monospace': 'System monospace',
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

          {error ? (
            <p className="settings-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="settings-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              <Save size={15} aria-hidden="true" />
              {busy ? 'Saving...' : 'Save settings'}
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
                  disabled={busy}
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
                  disabled={busy}
                />
              </label>
            </SettingsSection>
            <div className="settings-actions">
              <button
                type="submit"
                disabled={busy || currentPassword === '' || newPassword === ''}
              >
                Change password
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

function humanize(value: string): string {
  return value
    .replaceAll('-', ' ')
    .replace(/^./u, (letter) => letter.toUpperCase());
}
