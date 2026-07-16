import { z } from 'zod';

import { safeNormalizedStringSchema } from './safe-string.js';

const fontFamilySchema = z.enum([
  'jetbrains-mono-nerd',
  'system-monospace',
  'dejavu-sans-mono',
  'noto-sans-mono',
  'liberation-mono',
  'courier',
]);
const themeSchema = z.enum([
  'dark',
  'light',
  'ubuntu',
  'midnight-electric',
  'aurora-night',
  'carbon-violet',
  'custom',
]);
const cursorStyleSchema = z.enum(['block', 'underline', 'bar']);
const bellBehaviorSchema = z.enum(['none', 'visual', 'sound']);
const reconnectBehaviorSchema = z.enum(['automatic', 'manual']);
const workspaceShortcutModeSchema = z.enum(['default', 'disabled']);

export const terminalPaletteKeys = Object.freeze([
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const);

export const MIDNIGHT_ELECTRIC_TERMINAL_PALETTE = Object.freeze({
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
} as const);

const terminalColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const customTerminalPaletteSchema = z
  .object({
    background: terminalColorSchema,
    foreground: terminalColorSchema,
    cursor: terminalColorSchema,
    cursorAccent: terminalColorSchema,
    selectionBackground: terminalColorSchema,
    black: terminalColorSchema,
    red: terminalColorSchema,
    green: terminalColorSchema,
    yellow: terminalColorSchema,
    blue: terminalColorSchema,
    magenta: terminalColorSchema,
    cyan: terminalColorSchema,
    white: terminalColorSchema,
    brightBlack: terminalColorSchema,
    brightRed: terminalColorSchema,
    brightGreen: terminalColorSchema,
    brightYellow: terminalColorSchema,
    brightBlue: terminalColorSchema,
    brightMagenta: terminalColorSchema,
    brightCyan: terminalColorSchema,
    brightWhite: terminalColorSchema,
  })
  .strict();

const absoluteShellSchema = safeNormalizedStringSchema({
  maxUtf8Bytes: 4_096,
}).refine((value) => value.startsWith('/'), {
  message: 'Shell path must be absolute',
});

function steppedNumber(minimum: number, maximum: number, step: number) {
  return z
    .number()
    .finite()
    .min(minimum)
    .max(maximum)
    .refine((value) => isStepAligned(value, minimum, step));
}

export const workspaceSettingsSchema = z
  .object({
    version: z.literal(1),
    fontFamily: fontFamilySchema,
    fontSize: z.number().int().min(8).max(32),
    lineHeight: steppedNumber(1, 2, 0.05),
    letterSpacing: z.number().int().min(0).max(4),
    scrollback: z.number().int().min(0).max(100_000),
    theme: themeSchema,
    cursorStyle: cursorStyleSchema,
    cursorBlink: z.boolean(),
    bellBehavior: bellBehaviorSchema,
    reconnectBehavior: reconnectBehaviorSchema,
    automaticTabCreation: z.boolean(),
    workspaceShortcuts: workspaceShortcutModeSchema,
    defaultShell: absoluteShellSchema,
    tmuxHistoryLimit: z.number().int().min(0).max(1_000_000),
    staleSessionCleanupHours: z.number().int().min(0).max(8_760),
    customTerminalPalette: customTerminalPaletteSchema,
  })
  .strict();

const legacyWorkspaceSettingsMissingCustomTerminalPaletteSchema =
  workspaceSettingsSchema
    .omit({ customTerminalPalette: true })
    .extend({
      fontFamily: z.enum(['jetbrains-mono-nerd', 'system-monospace']),
      theme: z.enum(['dark', 'light', 'ubuntu']),
    })
    .strict();

export type WorkspaceSettings = Readonly<
  z.infer<typeof workspaceSettingsSchema>
>;

export const workspaceSettingsMutationSchema = z
  .object({ settings: workspaceSettingsSchema })
  .strict();

export type WorkspaceSettingsMutation = Readonly<{
  settings: WorkspaceSettings;
}>;

export const numericSettingLimitSchema = z
  .object({
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
  })
  .strict()
  .refine(({ min, max }) => min <= max);

export type NumericSettingLimit = Readonly<{
  min: number;
  max: number;
  step: number;
}>;

function uniqueOptions<T extends z.ZodType>(schema: T) {
  return z
    .array(schema)
    .min(1)
    .refine((values) => new Set(values).size === values.length);
}

function boundedLimit(
  minimum: number,
  maximum: number,
  quantum: number,
  integers: boolean,
) {
  return numericSettingLimitSchema.superRefine((limit, context) => {
    const values = [limit.min, limit.max, limit.step];
    if (
      limit.min < minimum ||
      limit.max > maximum ||
      (integers && !values.every(Number.isInteger)) ||
      !isStepAligned(limit.min, minimum, quantum) ||
      !isStepAligned(limit.max, minimum, quantum) ||
      !isStepAligned(limit.step, 0, quantum)
    ) {
      context.addIssue({ code: 'custom', message: 'Invalid setting limit' });
    }
  });
}

export const workspaceSettingsLimitsSchema = z
  .object({
    fontFamilies: uniqueOptions(fontFamilySchema),
    fontSize: boundedLimit(8, 32, 1, true),
    lineHeight: boundedLimit(1, 2, 0.05, false),
    letterSpacing: boundedLimit(0, 4, 1, true),
    scrollback: boundedLimit(0, 100_000, 1, true),
    themes: uniqueOptions(themeSchema),
    cursorStyles: uniqueOptions(cursorStyleSchema),
    bellBehaviors: uniqueOptions(bellBehaviorSchema),
    reconnectBehaviors: uniqueOptions(reconnectBehaviorSchema),
    workspaceShortcutModes: uniqueOptions(workspaceShortcutModeSchema),
    tmuxHistoryLimit: boundedLimit(0, 1_000_000, 1, true),
    staleSessionCleanupHours: boundedLimit(0, 8_760, 1, true),
  })
  .strict();

export type WorkspaceSettingsLimits = Readonly<{
  fontFamilies: readonly WorkspaceSettings['fontFamily'][];
  fontSize: NumericSettingLimit;
  lineHeight: NumericSettingLimit;
  letterSpacing: NumericSettingLimit;
  scrollback: NumericSettingLimit;
  themes: readonly WorkspaceSettings['theme'][];
  cursorStyles: readonly WorkspaceSettings['cursorStyle'][];
  bellBehaviors: readonly WorkspaceSettings['bellBehavior'][];
  reconnectBehaviors: readonly WorkspaceSettings['reconnectBehavior'][];
  workspaceShortcutModes: readonly WorkspaceSettings['workspaceShortcuts'][];
  tmuxHistoryLimit: NumericSettingLimit;
  staleSessionCleanupHours: NumericSettingLimit;
}>;

const workspaceSettingsConstraintsSchema = z
  .object({
    limits: workspaceSettingsLimitsSchema,
    allowedShells: uniqueOptions(absoluteShellSchema),
  })
  .strict();

export type WorkspaceSettingsConstraints = Readonly<{
  limits: WorkspaceSettingsLimits;
  allowedShells: readonly string[];
}>;

export const workspaceSettingsResponseSchema = z
  .object({
    settings: workspaceSettingsSchema,
    limits: workspaceSettingsLimitsSchema,
    allowedShells: uniqueOptions(absoluteShellSchema),
  })
  .strict();

export type SettingsResponse = Readonly<{
  settings: WorkspaceSettings;
  limits: WorkspaceSettingsLimits;
  allowedShells: readonly string[];
}>;

export function parseWorkspaceSettings(
  value: unknown,
  constraints?: WorkspaceSettingsConstraints,
): WorkspaceSettings {
  const settings = normalizeCursorAccent(
    workspaceSettingsSchema.parse(normalizeLegacyPalette(value)),
  );
  if (constraints !== undefined) {
    const parsedConstraints =
      workspaceSettingsConstraintsSchema.parse(constraints);
    assertWithinDeployment(settings, parsedConstraints);
  }
  return immutableCopy(settings);
}

export function parseWorkspaceSettingsMutation(
  value: unknown,
  constraints?: WorkspaceSettingsConstraints,
): WorkspaceSettingsMutation {
  const parsedMutation = workspaceSettingsMutationSchema.parse(value);
  const mutation = {
    settings: normalizeCursorAccent(parsedMutation.settings),
  };
  if (constraints !== undefined) {
    const parsedConstraints =
      workspaceSettingsConstraintsSchema.parse(constraints);
    assertWithinDeployment(mutation.settings, parsedConstraints);
  }
  return immutableCopy(mutation);
}

export function parseWorkspaceSettingsResponse(
  value: unknown,
): SettingsResponse {
  const parsedResponse = workspaceSettingsResponseSchema.parse(value);
  const response = {
    ...parsedResponse,
    settings: normalizeCursorAccent(parsedResponse.settings),
  };
  assertWithinDeployment(response.settings, response);
  return immutableCopy(response);
}

/** Returns true only for an otherwise-valid v1 document missing its palette. */
export function isLegacyWorkspaceSettingsMissingCustomTerminalPalette(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    legacyWorkspaceSettingsMissingCustomTerminalPaletteSchema.safeParse(value)
      .success
  );
}

function normalizeLegacyPalette(value: unknown): unknown {
  if (!isLegacyWorkspaceSettingsMissingCustomTerminalPalette(value)) {
    return value;
  }

  return {
    ...value,
    customTerminalPalette: MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
  };
}

function normalizeCursorAccent<
  T extends z.infer<typeof workspaceSettingsSchema>,
>(settings: T): T {
  if (settings.theme !== 'custom') {
    return {
      ...settings,
      customTerminalPalette: MIDNIGHT_ELECTRIC_TERMINAL_PALETTE,
    };
  }

  return {
    ...settings,
    customTerminalPalette: {
      ...settings.customTerminalPalette,
      cursorAccent: settings.customTerminalPalette.background,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWithinDeployment(
  settings: z.infer<typeof workspaceSettingsSchema>,
  constraints: z.infer<typeof workspaceSettingsConstraintsSchema>,
): void {
  const { limits } = constraints;
  assertOption(settings.fontFamily, limits.fontFamilies);
  assertNumeric(settings.fontSize, limits.fontSize);
  assertNumeric(settings.lineHeight, limits.lineHeight);
  assertNumeric(settings.letterSpacing, limits.letterSpacing);
  assertNumeric(settings.scrollback, limits.scrollback);
  assertOption(settings.theme, limits.themes);
  assertOption(settings.cursorStyle, limits.cursorStyles);
  assertOption(settings.bellBehavior, limits.bellBehaviors);
  assertOption(settings.reconnectBehavior, limits.reconnectBehaviors);
  assertOption(settings.workspaceShortcuts, limits.workspaceShortcutModes);
  assertNumeric(settings.tmuxHistoryLimit, limits.tmuxHistoryLimit);
  assertNumeric(
    settings.staleSessionCleanupHours,
    limits.staleSessionCleanupHours,
  );
  assertOption(settings.defaultShell, constraints.allowedShells);
}

function assertNumeric(value: number, limit: NumericSettingLimit): void {
  if (
    value < limit.min ||
    value > limit.max ||
    !isStepAligned(value, limit.min, limit.step)
  ) {
    throw new Error('Setting is outside deployment limits');
  }
}

function assertOption<T>(value: T, options: readonly T[]): void {
  if (!options.includes(value)) {
    throw new Error('Setting is outside deployment limits');
  }
}

function isStepAligned(value: number, minimum: number, step: number): boolean {
  const steps = (value - minimum) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

function immutableCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
