import type { ITheme } from '@xterm/xterm';
import type { WorkspaceSettings } from '@flanterminal/shared';

export const FONT_STACKS: Readonly<
  Record<WorkspaceSettings['fontFamily'], string>
> = Object.freeze({
  'jetbrains-mono-nerd':
    "'JetBrainsMono Nerd Font', ui-monospace, 'Noto Sans Mono', 'Symbols Nerd Font', 'Noto Color Emoji', monospace",
  'system-monospace':
    "ui-monospace, 'Noto Sans Mono', 'Segoe UI Symbol', 'Noto Color Emoji', monospace",
  'dejavu-sans-mono':
    "'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono', 'Courier New', 'Courier', monospace",
  'noto-sans-mono':
    "'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', 'Courier New', 'Courier', monospace",
  'liberation-mono':
    "'Liberation Mono', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Courier New', 'Courier', monospace",
  courier:
    "'Courier', 'Courier New', 'Noto Sans Mono', 'DejaVu Sans Mono', 'Liberation Mono', monospace",
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
  errorText: string;
}>;

export type AppTheme = Readonly<{ ui: UiTokens; terminal: ITheme }>;

const midnightElectricTerminal = Object.freeze({
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
} satisfies ITheme);

const midnightElectricUi = Object.freeze({
  canvas: '#101827',
  surface: '#17243A',
  raised: '#223452',
  border: '#3B5480',
  text: '#DCE8FF',
  muted: '#A9BAD6',
  accent: '#82B1FF',
  danger: '#FF7B8B',
  dangerBg: '#A63449',
  dangerText: '#FFFFFF',
  dangerHover: '#8E293D',
  dangerBorder: '#FF9EAA',
  dangerFocus: '#FF9EAA',
  errorText: '#FF9EAA',
} satisfies UiTokens);

const auroraNightTerminal = Object.freeze({
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
} satisfies ITheme);

const carbonVioletTerminal = Object.freeze({
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
} satisfies ITheme);

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
        errorText: '#ef7770',
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
        errorText: '#a33b35',
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
        errorText: '#ff786c',
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
    'midnight-electric': Object.freeze({
      ui: midnightElectricUi,
      terminal: midnightElectricTerminal,
    }),
    'aurora-night': Object.freeze({
      ui: midnightElectricUi,
      terminal: auroraNightTerminal,
    }),
    'carbon-violet': Object.freeze({
      ui: midnightElectricUi,
      terminal: carbonVioletTerminal,
    }),
    custom: Object.freeze({
      ui: midnightElectricUi,
      terminal: midnightElectricTerminal,
    }),
  });

export function themeFor(theme: WorkspaceSettings['theme']): AppTheme {
  return THEMES[theme];
}

export function terminalThemeFor(settings: WorkspaceSettings): ITheme {
  return settings.theme === 'custom'
    ? settings.customTerminalPalette
    : THEMES[settings.theme].terminal;
}
