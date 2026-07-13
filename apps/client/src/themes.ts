import type { ITheme } from '@xterm/xterm';
import type { WorkspaceSettings } from '@flanterminal/shared';

export const FONT_STACKS: Readonly<
  Record<WorkspaceSettings['fontFamily'], string>
> = Object.freeze({
  'jetbrains-mono-nerd':
    "'JetBrainsMono Nerd Font', ui-monospace, 'Noto Sans Mono', 'Symbols Nerd Font', 'Noto Color Emoji', monospace",
  'system-monospace':
    "ui-monospace, 'Noto Sans Mono', 'Segoe UI Symbol', 'Noto Color Emoji', monospace",
});

type UiTokens = Readonly<{
  canvas: string;
  surface: string;
  raised: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  danger: string;
  dangerBg: string;
  dangerText: string;
  dangerHover: string;
  dangerBorder: string;
  dangerFocus: string;
}>;

export type AppTheme = Readonly<{ ui: UiTokens; terminal: ITheme }>;

export const THEMES: Readonly<Record<WorkspaceSettings['theme'], AppTheme>> =
  Object.freeze({
    dark: Object.freeze({
      ui: Object.freeze({
        canvas: '#101112',
        surface: '#191b1c',
        raised: '#242627',
        border: '#3b3d3d',
        text: '#dddcd7',
        muted: '#9fa09d',
        accent: '#b88732',
        danger: '#c84e49',
        dangerBg: '#8f302c',
        dangerText: '#ffffff',
        dangerHover: '#a33b35',
        dangerBorder: '#df6a64',
        dangerFocus: '#ef7770',
      }),
      terminal: Object.freeze({
        background: '#101112',
        foreground: '#dddcd7',
        cursor: '#e0b35b',
        cursorAccent: '#101112',
        selectionBackground: '#5b4a2d',
        black: '#202223',
        red: '#d45b55',
        green: '#7f9d63',
        yellow: '#d0a34b',
        blue: '#6896c7',
        magenta: '#a879b0',
        cyan: '#63a5a5',
        white: '#dddcd7',
        brightBlack: '#747774',
        brightRed: '#ef7770',
        brightGreen: '#9aba78',
        brightYellow: '#e8bf68',
        brightBlue: '#85b2df',
        brightMagenta: '#c397ca',
        brightCyan: '#80c1c1',
        brightWhite: '#ffffff',
      }),
    }),
    light: Object.freeze({
      ui: Object.freeze({
        canvas: '#f4f4f1',
        surface: '#ffffff',
        raised: '#ecece8',
        border: '#c8c9c4',
        text: '#242625',
        muted: '#626560',
        accent: '#8a5b12',
        danger: '#a33b35',
        dangerBg: '#a33b35',
        dangerText: '#ffffff',
        dangerHover: '#862c28',
        dangerBorder: '#862c28',
        dangerFocus: '#862c28',
      }),
      terminal: Object.freeze({
        background: '#fbfbf8',
        foreground: '#242625',
        cursor: '#8a5b12',
        cursorAccent: '#fbfbf8',
        selectionBackground: '#dfcba6',
        black: '#242625',
        red: '#a33b35',
        green: '#4d751f',
        yellow: '#8a6500',
        blue: '#28669c',
        magenta: '#7b4389',
        cyan: '#237477',
        white: '#d7d8d3',
        brightBlack: '#656862',
        brightRed: '#c84e49',
        brightGreen: '#638f2c',
        brightYellow: '#aa7d00',
        brightBlue: '#3a7eb8',
        brightMagenta: '#9655a5',
        brightCyan: '#348e91',
        brightWhite: '#ffffff',
      }),
    }),
    ubuntu: Object.freeze({
      ui: Object.freeze({
        canvas: '#22151f',
        surface: '#2c1b29',
        raised: '#3b2637',
        border: '#65445c',
        text: '#eeeeec',
        muted: '#b7aab4',
        accent: '#e95420',
        danger: '#ef5350',
        dangerBg: '#a62f2d',
        dangerText: '#ffffff',
        dangerHover: '#bd3934',
        dangerBorder: '#ef6d65',
        dangerFocus: '#ff786c',
      }),
      terminal: Object.freeze({
        background: '#300a24',
        foreground: '#eeeeec',
        cursor: '#f08763',
        cursorAccent: '#300a24',
        selectionBackground: '#5e2750',
        black: '#2e3436',
        red: '#cc0000',
        green: '#4e9a06',
        yellow: '#c4a000',
        blue: '#3465a4',
        magenta: '#75507b',
        cyan: '#06989a',
        white: '#d3d7cf',
        brightBlack: '#555753',
        brightRed: '#ef2929',
        brightGreen: '#8ae234',
        brightYellow: '#fce94f',
        brightBlue: '#729fcf',
        brightMagenta: '#ad7fa8',
        brightCyan: '#34e2e2',
        brightWhite: '#eeeeec',
      }),
    }),
  });

export function themeFor(theme: WorkspaceSettings['theme']): AppTheme {
  return THEMES[theme];
}
