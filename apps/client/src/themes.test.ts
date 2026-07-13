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
});
