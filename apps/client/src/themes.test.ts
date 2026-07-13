// @ts-expect-error Node types are intentionally excluded from the browser app.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FONT_STACKS, THEMES, themeFor } from './themes.js';

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

  it('uses the bundled font only when selected and provides broad fallbacks', () => {
    expect(FONT_STACKS['jetbrains-mono-nerd']).toContain(
      "'JetBrainsMono Nerd Font'",
    );
    expect(FONT_STACKS['jetbrains-mono-nerd']).toContain("'Noto Color Emoji'");
    expect(FONT_STACKS['system-monospace']).not.toContain(
      'JetBrainsMono Nerd Font',
    );
    expect(FONT_STACKS['system-monospace']).toContain('ui-monospace');
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
