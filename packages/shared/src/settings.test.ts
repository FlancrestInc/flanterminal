import { describe, expect, it } from 'vitest';

import {
  isLegacyWorkspaceSettingsMissingCustomTerminalPalette,
  MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  parseWorkspaceSettings,
  parseWorkspaceSettingsMutation,
  parseWorkspaceSettingsResponse,
  type WorkspaceSettings,
  type WorkspaceSettingsLimits,
} from './index.js';

const customTerminalPalette = {
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
} as const;

const settings: WorkspaceSettings = {
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
  customTerminalPalette,
};

const limits: WorkspaceSettingsLimits = {
  fontFamilies: ['jetbrains-mono-nerd', 'system-monospace'],
  fontSize: { min: 8, max: 32, step: 1 },
  lineHeight: { min: 1, max: 2, step: 0.05 },
  letterSpacing: { min: 0, max: 4, step: 1 },
  scrollback: { min: 0, max: 100_000, step: 1 },
  themes: ['dark', 'light', 'ubuntu'],
  cursorStyles: ['block', 'underline', 'bar'],
  bellBehaviors: ['none', 'visual', 'sound'],
  reconnectBehaviors: ['automatic', 'manual'],
  workspaceShortcutModes: ['default', 'disabled'],
  tmuxHistoryLimit: { min: 0, max: 1_000_000, step: 1 },
  staleSessionCleanupHours: { min: 0, max: 8_760, step: 1 },
};

describe('workspace settings contracts', () => {
  it('parses the exact versioned settings document into a frozen copy', () => {
    const parsed = parseWorkspaceSettings(settings);

    expect(parsed).toEqual(settings);
    expect(parsed).not.toBe(settings);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    [
      'fontFamily',
      [
        'jetbrains-mono-nerd',
        'system-monospace',
        'dejavu-sans-mono',
        'noto-sans-mono',
        'liberation-mono',
        'courier',
      ],
    ],
    [
      'theme',
      [
        'dark',
        'light',
        'ubuntu',
        'midnight-electric',
        'aurora-night',
        'carbon-violet',
        'custom',
      ],
    ],
    ['cursorStyle', ['block', 'underline', 'bar']],
    ['bellBehavior', ['none', 'visual', 'sound']],
    ['reconnectBehavior', ['automatic', 'manual']],
    ['workspaceShortcuts', ['default', 'disabled']],
  ] as const)('accepts every approved %s value', (field, values) => {
    for (const value of values) {
      expect(
        parseWorkspaceSettings({ ...settings, [field]: value })[field],
      ).toBe(value);
    }
  });

  it.each([
    ['fontSize', 8],
    ['fontSize', 32],
    ['lineHeight', 1],
    ['lineHeight', 2],
    ['letterSpacing', 0],
    ['letterSpacing', 4],
    ['scrollback', 0],
    ['scrollback', 100_000],
    ['tmuxHistoryLimit', 0],
    ['tmuxHistoryLimit', 1_000_000],
    ['staleSessionCleanupHours', 0],
    ['staleSessionCleanupHours', 8_760],
  ] as const)('accepts the %s boundary %s', (field, value) => {
    expect(parseWorkspaceSettings({ ...settings, [field]: value })[field]).toBe(
      value,
    );
  });

  it.each([
    ['version', 2],
    ['fontFamily', 'remote-font'],
    ['fontSize', 7],
    ['fontSize', 14.5],
    ['fontSize', 33],
    ['lineHeight', 0.95],
    ['lineHeight', 1.01],
    ['lineHeight', 2.05],
    ['letterSpacing', -1],
    ['letterSpacing', 1.5],
    ['letterSpacing', 5],
    ['scrollback', -1],
    ['scrollback', 100_001],
    ['tmuxHistoryLimit', -1],
    ['tmuxHistoryLimit', 1_000_001],
    ['staleSessionCleanupHours', -1],
    ['staleSessionCleanupHours', 8_761],
    ['defaultShell', 'bin/bash'],
    ['defaultShell', '/bin/bash\u0000--login'],
  ] as const)('rejects malformed %s value %s', (field, value) => {
    expect(() =>
      parseWorkspaceSettings({ ...settings, [field]: value }),
    ).toThrow();
  });

  it('rejects missing and unknown fields', () => {
    const missingTheme: Record<string, unknown> = { ...settings };
    delete missingTheme.theme;
    expect(() => parseWorkspaceSettings(missingTheme)).toThrow();
    expect(() =>
      parseWorkspaceSettings({ ...settings, secret: 'nope' }),
    ).toThrow();
  });

  it('rejects incomplete, unknown, and malformed terminal palettes', () => {
    const missingBrightWhite: Record<string, unknown> = {
      ...customTerminalPalette,
    };
    delete missingBrightWhite.brightWhite;

    expect(() =>
      parseWorkspaceSettings({
        ...settings,
        customTerminalPalette: missingBrightWhite,
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettings({
        ...settings,
        customTerminalPalette: {
          ...customTerminalPalette,
          chartreuse: '#00FF00',
        },
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettings({
        ...settings,
        customTerminalPalette: { ...customTerminalPalette, red: '#f00' },
      }),
    ).toThrow();
  });

  it('normalizes a legacy v1 document without a palette to frozen Midnight Electric', () => {
    const legacySettings: Record<string, unknown> = { ...settings };
    delete legacySettings.customTerminalPalette;

    expect(
      isLegacyWorkspaceSettingsMissingCustomTerminalPalette(legacySettings),
    ).toBe(true);

    const parsed = parseWorkspaceSettings(legacySettings);

    expect(parsed.customTerminalPalette).toEqual(
      MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
    );
    expect(Object.isFrozen(parsed.customTerminalPalette)).toBe(true);
  });

  it.each([
    ['custom theme', { theme: 'custom' }],
    ['new preset', { theme: 'midnight-electric' }],
    ['new font', { fontFamily: 'dejavu-sans-mono' }],
  ] as const)('rejects a palette-less document using a %s', (_name, changes) => {
    const paletteLessSettings: Record<string, unknown> = {
      ...settings,
      ...changes,
    };
    delete paletteLessSettings.customTerminalPalette;

    expect(
      isLegacyWorkspaceSettingsMissingCustomTerminalPalette(
        paletteLessSettings,
      ),
    ).toBe(false);
    expect(() => parseWorkspaceSettings(paletteLessSettings)).toThrow();
  });

  it('requires a complete palette when custom is selected', () => {
    const incompletePalette: Record<string, unknown> = {
      ...customTerminalPalette,
    };
    delete incompletePalette.brightWhite;

    expect(() =>
      parseWorkspaceSettings({
        ...settings,
        theme: 'custom',
        customTerminalPalette: incompletePalette,
      }),
    ).toThrow();
  });

  it.each([
    'dark',
    'light',
    'ubuntu',
    'midnight-electric',
    'aurora-night',
    'carbon-violet',
  ] as const)('normalizes the palette for the %s preset', (theme) => {
    const parsed = parseWorkspaceSettings({
      ...settings,
      theme,
      customTerminalPalette: {
        ...customTerminalPalette,
        background: '#FFFFFF',
        cursorAccent: '#000000',
      },
    });

    expect(parsed.customTerminalPalette).toEqual(
      MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
    );
  });

  it('derives a custom palette cursor accent from its background', () => {
    const parsed = parseWorkspaceSettings({
      ...settings,
      theme: 'custom',
      customTerminalPalette: {
        ...customTerminalPalette,
        background: '#FFFFFF',
        cursorAccent: '#000000',
      },
    });

    expect(parsed.customTerminalPalette.cursorAccent).toBe('#FFFFFF');
  });

  it('parses only a full strict settings mutation', () => {
    const parsed = parseWorkspaceSettingsMutation({ settings });

    expect(parsed).toEqual({ settings });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.settings)).toBe(true);
    expect(() => parseWorkspaceSettingsMutation(settings)).toThrow();
    expect(() =>
      parseWorkspaceSettingsMutation({ settings, merge: true }),
    ).toThrow();
  });

  it('parses a strict response and deeply freezes limits and shells', () => {
    const response = parseWorkspaceSettingsResponse({
      settings,
      limits,
      allowedShells: ['/bin/bash', '/bin/zsh'],
    });

    expect(response.settings).toEqual(settings);
    expect(response.limits).toEqual(limits);
    expect(response.allowedShells).toEqual(['/bin/bash', '/bin/zsh']);
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(response.limits.scrollback)).toBe(true);
    expect(Object.isFrozen(response.limits.themes)).toBe(true);
    expect(Object.isFrozen(response.allowedShells)).toBe(true);
  });

  it('enforces response and explicit deployment limits', () => {
    const deployed = {
      limits: {
        ...limits,
        scrollback: { min: 0, max: 5_000, step: 1 },
        tmuxHistoryLimit: { min: 0, max: 10_000, step: 1 },
      },
      allowedShells: ['/bin/bash'],
    };

    expect(() =>
      parseWorkspaceSettings({ ...settings, scrollback: 5_001 }, deployed),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettings(
        { ...settings, defaultShell: '/bin/zsh' },
        deployed,
      ),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettingsResponse({
        settings: { ...settings, scrollback: 5_001 },
        ...deployed,
      }),
    ).toThrow();
  });

  it('rejects malformed limits, duplicate enum options, unsafe shells, and unknowns', () => {
    expect(() =>
      parseWorkspaceSettingsResponse({
        settings,
        limits: { ...limits, fontSize: { min: 32, max: 8, step: 1 } },
        allowedShells: ['/bin/bash'],
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettingsResponse({
        settings,
        limits: { ...limits, scrollback: { min: 0, max: 100_001, step: 1 } },
        allowedShells: ['/bin/bash'],
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettingsResponse({
        settings,
        limits: { ...limits, lineHeight: { min: 1, max: 2, step: 0.03 } },
        allowedShells: ['/bin/bash'],
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettingsResponse({
        settings,
        limits: { ...limits, themes: ['dark', 'dark'] },
        allowedShells: ['/bin/bash'],
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettingsResponse({
        settings,
        limits,
        allowedShells: ['bin/bash'],
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettingsResponse({
        settings,
        limits,
        allowedShells: ['/bin/bash'],
        password: 'secret',
      }),
    ).toThrow();
  });

  it('NFC-normalizes default and allowed shell paths', () => {
    expect(
      parseWorkspaceSettings({ ...settings, defaultShell: '/bin/Cafe\u0301' })
        .defaultShell,
    ).toBe('/bin/Caf\u00e9');
    expect(
      parseWorkspaceSettingsResponse({
        settings: { ...settings, defaultShell: '/bin/Cafe\u0301' },
        limits,
        allowedShells: ['/bin/Cafe\u0301'],
      }).allowedShells,
    ).toEqual(['/bin/Caf\u00e9']);
  });

  it.each([
    '/bin/bash\n--login',
    '/bin/override\u202eeman',
    '/bin/zero\u200bwidth',
    `/${'\ud83d\ude80'.repeat(1_024)}`,
  ])('rejects unsafe or over-4096-byte shell path %j', (defaultShell) => {
    expect(() =>
      parseWorkspaceSettings({ ...settings, defaultShell }),
    ).toThrow();
    expect(() =>
      parseWorkspaceSettingsResponse({
        settings,
        limits,
        allowedShells: ['/bin/bash', defaultShell],
      }),
    ).toThrow();
  });
});
