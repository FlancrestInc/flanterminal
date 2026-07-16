// @ts-expect-error Node types are intentionally excluded from the browser app.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FONT_STACKS, THEMES, terminalThemeFor, themeFor } from './themes.js';

const midnightElectric = {
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

const auroraNight = {
  background: '#071B1C',
  foreground: '#D6F5EF',
  cursor: '#70E1C2',
  cursorAccent: '#071B1C',
  selectionBackground: '#164A49',
  black: '#102A2B',
  red: '#FF7B89',
  green: '#75E6A6',
  yellow: '#F5D06F',
  blue: '#75BFFF',
  magenta: '#D7A5FF',
  cyan: '#65D9DF',
  white: '#D6F5EF',
  brightBlack: '#416B6B',
  brightRed: '#FFA0AA',
  brightGreen: '#A2F2BF',
  brightYellow: '#FFE09A',
  brightBlue: '#A4D5FF',
  brightMagenta: '#ECBFFF',
  brightCyan: '#99EEF1',
  brightWhite: '#FFFFFF',
} as const;

const carbonViolet = {
  background: '#15111F',
  foreground: '#EEE5FF',
  cursor: '#B99CFF',
  cursorAccent: '#15111F',
  selectionBackground: '#3B2C59',
  black: '#272035',
  red: '#FF7D9A',
  green: '#8DDEA8',
  yellow: '#F1C76A',
  blue: '#9CB7FF',
  magenta: '#D6A5F4',
  cyan: '#7EDBE5',
  white: '#EEE5FF',
  brightBlack: '#625574',
  brightRed: '#FFA4B7',
  brightGreen: '#AFECC3',
  brightYellow: '#FFE09A',
  brightBlue: '#C0D0FF',
  brightMagenta: '#E7C4FF',
  brightCyan: '#A9EEF3',
  brightWhite: '#FFFFFF',
} as const;

describe('terminal themes', () => {
  it('defines exact dark, light, and Ubuntu UI tokens and xterm palettes', () => {
    expect(THEMES.dark).toMatchObject({
      ui: {
        canvas: '#101112',
        surface: '#191b1c',
        text: '#dddcd7',
        accent: '#b88732',
      },
      terminal: { background: '#101112', foreground: '#dddcd7' },
    });
    expect(THEMES.light).toMatchObject({
      ui: {
        canvas: '#f4f4f1',
        surface: '#ffffff',
        text: '#242625',
        accent: '#8a5b12',
      },
      terminal: { background: '#fbfbf8', foreground: '#242625' },
    });
    expect(THEMES.ubuntu).toMatchObject({
      ui: {
        canvas: '#22151f',
        surface: '#2c1b29',
        text: '#eeeeec',
        accent: '#e95420',
      },
      terminal: { background: '#300a24', foreground: '#eeeeec' },
    });
    expect(themeFor('ubuntu')).toBe(THEMES.ubuntu);
  });

  it('defines all seven theme identifiers and exact new terminal palettes', () => {
    expect(Object.keys(THEMES)).toEqual([
      'dark',
      'light',
      'ubuntu',
      'midnight-electric',
      'aurora-night',
      'carbon-violet',
      'custom',
    ]);
    expect(THEMES['midnight-electric'].terminal).toEqual(midnightElectric);
    expect(THEMES['aurora-night'].terminal).toEqual(auroraNight);
    expect(THEMES['carbon-violet'].terminal).toEqual(carbonViolet);
    expect(THEMES.custom.terminal).toEqual(midnightElectric);
  });

  it('uses complete ordered practical fallbacks for system font stacks', () => {
    expect(FONT_STACKS['dejavu-sans-mono']).toBe(
      "'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono', 'Courier New', monospace",
    );
    expect(FONT_STACKS['noto-sans-mono']).toBe(
      "'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', monospace",
    );
    expect(FONT_STACKS['liberation-mono']).toBe(
      "'Liberation Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Courier New', monospace",
    );
    expect(FONT_STACKS.courier).toBe(
      "'Courier', 'Courier New', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace",
    );
    expect(FONT_STACKS['jetbrains-mono-nerd']).toMatch(
      /^'JetBrainsMono Nerd Font'/u,
    );
    expect(FONT_STACKS['system-monospace']).not.toContain('JetBrainsMono');
  });

  it('resolves preset terminal palettes independently from custom palette values', () => {
    const settings = {
      fontFamily: 'dejavu-sans-mono',
      fontSize: 14,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 1_000,
      cursorStyle: 'block',
      cursorBlink: true,
      bellBehavior: 'none',
      reconnectBehavior: 'automatic',
      automaticTabCreation: true,
      workspaceShortcuts: 'default',
      defaultShell: '/bin/bash',
      tmuxHistoryLimit: 1_000,
      staleSessionCleanupHours: 24,
      version: 1,
      customTerminalPalette: { ...carbonViolet, red: '#123456' },
    } as const;
    expect(terminalThemeFor({ ...settings, theme: 'aurora-night' })).toEqual(
      auroraNight,
    );
    expect(terminalThemeFor({ ...settings, theme: 'custom' })).toEqual(
      settings.customTerminalPalette,
    );
    expect(themeFor('custom').ui).toBe(THEMES['midnight-electric'].ui);
  });

  it('keeps destructive button text and boundaries at measured WCAG contrast', () => {
    for (const theme of Object.values(THEMES)) {
      expect(
        contrast(theme.ui.dangerText, theme.ui.dangerBg),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(theme.ui.dangerText, theme.ui.dangerHover),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(theme.ui.dangerBorder, theme.ui.surface),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(theme.ui.dangerFocus, theme.ui.surface),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps administration error text readable on every actual surface', () => {
    for (const theme of Object.values(THEMES)) {
      expect(
        contrast(theme.ui.errorText, theme.ui.surface),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(theme.ui.errorText, theme.ui.canvas),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses semantic destructive tokens for normal, hover, and focus states', () => {
    const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
    expect(css).toContain('background: var(--ui-danger-bg);');
    expect(css).toContain('color: var(--ui-danger-text);');
    expect(css).toContain('background: var(--ui-danger-hover);');
    expect(css).toContain('outline-color: var(--ui-danger-focus);');
  });

  it('uses the semantic error token for all administration error text', () => {
    const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\.admin-row-error[\s\S]*?color: var\(--ui-error-text\)/u,
    );
    expect(css).toMatch(
      /\.admin-state-error,[\s\S]*?\.admin-inline-error[\s\S]*?color: var\(--ui-error-text\)/u,
    );
  });

  it('does not reference undefined UI custom properties', () => {
    const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
    const declarations = new Set(
      [...css.matchAll(/(--ui-[\w-]+)\s*:/gu)].map((match) => match[1]),
    );
    const references = new Set(
      [...css.matchAll(/var\((--ui-[\w-]+)\)/gu)].map((match) => match[1]),
    );

    expect(
      [...references].filter((reference) => !declarations.has(reference)),
    ).toEqual([]);
  });
});

function contrast(first: string, second: string): number {
  const brighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (brighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../gu)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
