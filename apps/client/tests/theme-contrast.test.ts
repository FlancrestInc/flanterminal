import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stylesheet = readFileSync(
  new URL('../src/theme.css', import.meta.url),
  'utf8',
);

describe('login theme contrast', () => {
  const colors = cssColors(stylesheet);

  it.each([
    ['normal', '--login-button-fg', '--login-button-bg'],
    ['hover', '--login-button-fg', '--login-button-hover-bg'],
  ] as const)(
    'keeps %s button text at WCAG AA contrast',
    (_, foreground, background) => {
      expect(
        contrast(colors[foreground]!, colors[background]!),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each([
    ['field', '--login-control-border', '--login-input-bg'],
    ['page', '--login-control-border', '--login-page-bg'],
  ] as const)(
    'keeps the input boundary distinguishable from the %s',
    (_, foreground, background) => {
      expect(
        contrast(colors[foreground]!, colors[background]!),
      ).toBeGreaterThanOrEqual(3);
    },
  );
});

function cssColors(css: string): Record<string, string> {
  const colors = Object.fromEntries(
    [...css.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\s*;/giu)].map(
      ([, name, value]) => [name, value],
    ),
  );
  if (Object.keys(colors).length === 0)
    throw new Error(
      `No theme colors found in ${JSON.stringify(css.slice(0, 80))}`,
    );
  return colors;
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort(
    (left, right) => right - left,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

function luminance(color: string): number {
  const channels = color
    .slice(1)
    .match(/.{2}/gu)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4),
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
