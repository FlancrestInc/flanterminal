import {
  MAX_FONT_SIZE,
  MAX_RECONNECT_SECONDS,
  MAX_RESIZE_DEBOUNCE_MS,
  MAX_SCROLLBACK,
  MIN_FONT_SIZE,
  MIN_RECONNECT_SECONDS,
  MIN_RESIZE_DEBOUNCE_MS,
  MIN_SCROLLBACK,
  basePathSchema,
  parseClientConfig,
  type ClientConfig,
} from '@flanterminal/shared';
import { z } from 'zod';

const MAX_WS_BUFFER_BYTES = 1_048_576;
const logLevels = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
] as const;
const absolutePathSchema = z.string().startsWith('/');

function integerString(minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^-?\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));
}

function clampedIntegerString(minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^-?\d+$/)
    .transform(Number)
    .pipe(z.number().int().finite())
    .transform((value) => Math.min(maximum, Math.max(minimum, value)));
}

const publicUrlSchema = z.string().transform((value, context) => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error('invalid URL');
    }
    return url.origin;
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid public URL' });
    return z.NEVER;
  }
});

const envSchema = z
  .object({
    APP_PORT: integerString(1, 65_535),
    APP_BIND_HOST: z.string().min(1).max(255),
    APP_BASE_PATH: basePathSchema,
    APP_PUBLIC_URL: publicUrlSchema,
    DEFAULT_SHELL: absolutePathSchema,
    DEFAULT_FONT_SIZE: integerString(MIN_FONT_SIZE, MAX_FONT_SIZE),
    XTERM_SCROLLBACK: clampedIntegerString(MIN_SCROLLBACK, MAX_SCROLLBACK),
    TMUX_HISTORY_LIMIT: integerString(0, 1_000_000),
    WS_HEARTBEAT_SECONDS: integerString(5, 300),
    WS_MAX_BUFFER_BYTES: integerString(65_536, MAX_WS_BUFFER_BYTES),
    RESIZE_DEBOUNCE_MS: integerString(
      MIN_RESIZE_DEBOUNCE_MS,
      MAX_RESIZE_DEBOUNCE_MS,
    ),
    RECONNECT_MAX_SECONDS: integerString(
      MIN_RECONNECT_SECONDS,
      MAX_RECONNECT_SECONDS,
    ),
    LOG_LEVEL: z.enum(logLevels),
    HOME_DIR: absolutePathSchema,
    DATA_DIR: absolutePathSchema,
    SESSION_MAX_COUNT: integerString(1, 20),
  })
  .strict();

type LogLevel = (typeof logLevels)[number];

export type AppConfig = Readonly<{
  port: number;
  bindHost: string;
  basePath: string;
  publicUrl: string;
  publicOrigin: string;
  publicHost: string;
  defaultShell: string;
  defaultFontSize: number;
  xtermScrollback: number;
  tmuxHistoryLimit: number;
  wsHeartbeatSeconds: number;
  wsMaxBufferBytes: number;
  resizeDebounceMs: number;
  reconnectMaxSeconds: number;
  logLevel: LogLevel;
  homeDir: string;
  dataDir: string;
  sessionMaxCount: number;
}>;

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: ConfigEnvironment): AppConfig {
  try {
    const parsed = envSchema.parse({
      APP_PORT: env.APP_PORT ?? '3000',
      APP_BIND_HOST: env.APP_BIND_HOST ?? '0.0.0.0',
      APP_BASE_PATH: env.APP_BASE_PATH ?? '/',
      APP_PUBLIC_URL: env.APP_PUBLIC_URL ?? 'http://localhost:3000',
      DEFAULT_SHELL: env.DEFAULT_SHELL ?? '/bin/bash',
      DEFAULT_FONT_SIZE: env.DEFAULT_FONT_SIZE ?? '14',
      XTERM_SCROLLBACK: env.XTERM_SCROLLBACK ?? '10000',
      TMUX_HISTORY_LIMIT: env.TMUX_HISTORY_LIMIT ?? '20000',
      WS_HEARTBEAT_SECONDS: env.WS_HEARTBEAT_SECONDS ?? '30',
      WS_MAX_BUFFER_BYTES: env.WS_MAX_BUFFER_BYTES ?? '1048576',
      RESIZE_DEBOUNCE_MS: env.RESIZE_DEBOUNCE_MS ?? '100',
      RECONNECT_MAX_SECONDS: env.RECONNECT_MAX_SECONDS ?? '15',
      LOG_LEVEL: env.LOG_LEVEL ?? 'info',
      HOME_DIR: env.HOME_DIR ?? '/home/webterm',
      DATA_DIR: env.DATA_DIR ?? '/app/data',
      SESSION_MAX_COUNT: env.SESSION_MAX_COUNT ?? '10',
    });
    const publicUrl = new URL(parsed.APP_PUBLIC_URL);

    return Object.freeze({
      port: parsed.APP_PORT,
      bindHost: parsed.APP_BIND_HOST,
      basePath: parsed.APP_BASE_PATH,
      publicUrl: parsed.APP_PUBLIC_URL,
      publicOrigin: publicUrl.origin,
      publicHost: publicUrl.host,
      defaultShell: parsed.DEFAULT_SHELL,
      defaultFontSize: parsed.DEFAULT_FONT_SIZE,
      xtermScrollback: parsed.XTERM_SCROLLBACK,
      tmuxHistoryLimit: parsed.TMUX_HISTORY_LIMIT,
      wsHeartbeatSeconds: parsed.WS_HEARTBEAT_SECONDS,
      wsMaxBufferBytes: parsed.WS_MAX_BUFFER_BYTES,
      resizeDebounceMs: parsed.RESIZE_DEBOUNCE_MS,
      reconnectMaxSeconds: parsed.RECONNECT_MAX_SECONDS,
      logLevel: parsed.LOG_LEVEL,
      homeDir: parsed.HOME_DIR,
      dataDir: parsed.DATA_DIR,
      sessionMaxCount: parsed.SESSION_MAX_COUNT,
    });
  } catch {
    throw new Error('Invalid server configuration');
  }
}

export function toClientConfig(config: AppConfig): ClientConfig {
  return parseClientConfig({
    basePath: config.basePath,
    fontSize: config.defaultFontSize,
    scrollback: config.xtermScrollback,
    resizeDebounceMs: config.resizeDebounceMs,
    reconnectMaxSeconds: config.reconnectMaxSeconds,
  });
}
