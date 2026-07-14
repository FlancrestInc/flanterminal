import {
  MAX_RECONNECT_SECONDS,
  MAX_RESIZE_DEBOUNCE_MS,
  MIN_RECONNECT_SECONDS,
  MIN_RESIZE_DEBOUNCE_MS,
  basePathSchema,
  parseClientConfig,
  type ClientConfig,
} from '@flanterminal/shared';
import ipaddr from 'ipaddr.js';
import proxyaddr from 'proxy-addr';
import { z } from 'zod';

const MAX_WS_BUFFER_BYTES = 1_048_576;
const MAX_PATH_BYTES = 4_096;
const MAX_TRUST_PROXY_ENTRIES = 64;
const utf8Encoder = new TextEncoder();
const forbiddenCharacterPattern = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Cf}]/u;
const httpTokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const safeTokenPattern = /^[A-Za-z0-9_-]+$/;
const usernamePattern = /^[A-Za-z0-9._@-]+$/;
const cloudflareTeamLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const logLevels = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
] as const;

function integerString(minimum: number, maximum: number) {
  return z
    .string()
    .regex(/^-?\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));
}

function integerInput(minimum: number, maximum: number) {
  return z.union([
    z.number().int().min(minimum).max(maximum),
    integerString(minimum, maximum),
  ]);
}

function clampedIntegerInput(minimum: number, maximum: number) {
  return z
    .union([
      z.number().int().finite(),
      z
        .string()
        .regex(/^-?\d+$/)
        .transform(Number)
        .pipe(z.number().int().finite()),
    ])
    .transform((value) => Math.min(maximum, Math.max(minimum, value)));
}

const safeAbsolutePathSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .refine(
    (value) =>
      value.startsWith('/') &&
      utf8Encoder.encode(value).byteLength <= MAX_PATH_BYTES &&
      [...value].every(
        (character) => !forbiddenCharacterPattern.test(character),
      ),
  );

const publicUrlSchema = originSchema(['http:', 'https:']);
const cloudflareDomainSchema = z.string().transform((value, context) => {
  try {
    const url = new URL(value);
    const labels = url.hostname.split('.');
    if (
      url.protocol !== 'https:' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      labels.length !== 3 ||
      !cloudflareTeamLabelPattern.test(labels[0]!) ||
      labels[1] !== 'cloudflareaccess' ||
      labels[2] !== 'com'
    )
      throw new Error();
    return url.origin;
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid team origin' });
    return z.NEVER;
  }
});

function originSchema(protocols: readonly string[]) {
  return z.string().transform((value, context) => {
    try {
      const url = new URL(value);
      if (
        !protocols.includes(url.protocol) ||
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
      context.addIssue({ code: 'custom', message: 'invalid origin' });
      return z.NEVER;
    }
  });
}

const trustProxySchema = z
  .union([
    z.literal(false),
    z.literal('false').transform(() => false as const),
    integerInput(1, 8),
    z.string().transform(parseProxyList),
    z.array(z.string()).transform(parseProxyList),
  ])
  .transform((value) => (Array.isArray(value) ? Object.freeze(value) : value));

const allowedShellsSchema = z
  .union([
    z.string().transform((value) => value.split(',')),
    z.array(z.string()),
  ])
  .transform((values, context) => {
    const shells: string[] = [];
    for (const value of values) {
      const parsed = safeAbsolutePathSchema.safeParse(value.trim());
      if (!parsed.success) {
        context.addIssue({ code: 'custom', message: 'invalid shell path' });
        return z.NEVER;
      }
      shells.push(parsed.data);
    }
    if (shells.length === 0 || new Set(shells).size !== shells.length) {
      context.addIssue({ code: 'custom', message: 'invalid shell list' });
      return z.NEVER;
    }
    return Object.freeze(shells);
  });

const localUsernameSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .refine(
    (value) =>
      [...value].length >= 1 &&
      [...value].length <= 64 &&
      usernamePattern.test(value),
  );

const fileValuesSchema = z
  .object({
    port: z.number().int().optional(),
    bindHost: z.string().optional(),
    basePath: z.string().optional(),
    publicUrl: z.string().optional(),
    defaultShell: z.string().optional(),
    defaultFontSize: z.number().int().optional(),
    xtermScrollback: z.number().int().optional(),
    tmuxHistoryLimit: z.number().int().optional(),
    wsHeartbeatSeconds: z.number().int().optional(),
    wsMaxBufferBytes: z.number().int().optional(),
    resizeDebounceMs: z.number().int().optional(),
    reconnectMaxSeconds: z.number().int().optional(),
    logLevel: z.string().optional(),
    homeDir: z.string().optional(),
    dataDir: z.string().optional(),
    sessionMaxCount: z.number().int().optional(),
    authMode: z.string().optional(),
    localAuthUsername: z.string().optional(),
    bcryptCost: z.number().int().optional(),
    authIdleMinutes: z.number().int().optional(),
    authAbsoluteHours: z.number().int().optional(),
    authSessionMaxCount: z.number().int().optional(),
    cloudflareTeamDomain: z.string().optional(),
    cloudflareAccessAud: z.string().optional(),
    trustProxy: z
      .union([z.literal(false), z.number().int(), z.array(z.string())])
      .optional(),
    trustedAuthHeader: z.string().optional(),
    allowedShells: z.array(z.string()).optional(),
    maxFontSize: z.number().int().optional(),
    maxXtermScrollback: z.number().int().optional(),
    maxTmuxHistoryLimit: z.number().int().optional(),
    maxStaleSessionCleanupHours: z.number().int().optional(),
    sessionCleanupIntervalMinutes: z.number().int().optional(),
  })
  .strict();

const mergedSchema = z
  .object({
    APP_CONFIG_FILE: safeAbsolutePathSchema.optional(),
    APP_PORT: integerInput(1, 65_535),
    APP_BIND_HOST: z.string().min(1).max(255),
    APP_BASE_PATH: basePathSchema,
    APP_PUBLIC_URL: publicUrlSchema,
    DEFAULT_SHELL: safeAbsolutePathSchema,
    DEFAULT_FONT_SIZE: integerInput(8, 32),
    XTERM_SCROLLBACK: clampedIntegerInput(0, 100_000),
    TMUX_HISTORY_LIMIT: integerInput(0, 1_000_000),
    WS_HEARTBEAT_SECONDS: integerInput(5, 300),
    WS_MAX_BUFFER_BYTES: integerInput(65_536, MAX_WS_BUFFER_BYTES),
    RESIZE_DEBOUNCE_MS: integerInput(
      MIN_RESIZE_DEBOUNCE_MS,
      MAX_RESIZE_DEBOUNCE_MS,
    ),
    RECONNECT_MAX_SECONDS: integerInput(
      MIN_RECONNECT_SECONDS,
      MAX_RECONNECT_SECONDS,
    ),
    LOG_LEVEL: z.enum(logLevels),
    HOME_DIR: safeAbsolutePathSchema,
    DATA_DIR: safeAbsolutePathSchema,
    SESSION_MAX_COUNT: integerInput(1, 20),
    AUTH_MODE: z.enum(['local', 'cloudflare-access', 'trusted-header', 'none']),
    LOCAL_AUTH_USERNAME: localUsernameSchema,
    BCRYPT_COST: integerInput(10, 15),
    AUTH_IDLE_MINUTES: integerInput(5, 1_440),
    AUTH_ABSOLUTE_HOURS: integerInput(1, 168),
    AUTH_SESSION_MAX_COUNT: integerInput(1, 256),
    CLOUDFLARE_TEAM_DOMAIN: cloudflareDomainSchema.optional(),
    CLOUDFLARE_ACCESS_AUD: z
      .string()
      .min(1)
      .max(256)
      .regex(safeTokenPattern)
      .optional(),
    TRUST_PROXY: trustProxySchema,
    TRUSTED_AUTH_HEADER: z.string().min(1).max(128).regex(httpTokenPattern),
    ALLOWED_SHELLS: allowedShellsSchema,
    MAX_FONT_SIZE: integerInput(8, 32),
    MAX_XTERM_SCROLLBACK: integerInput(0, 100_000),
    MAX_TMUX_HISTORY_LIMIT: integerInput(0, 1_000_000),
    MAX_STALE_SESSION_CLEANUP_HOURS: integerInput(0, 8_760),
    SESSION_CLEANUP_INTERVAL_MINUTES: integerInput(5, 1_440),
  })
  .strict()
  .superRefine((config, context) => {
    if (
      config.AUTH_MODE === 'cloudflare-access' &&
      (config.CLOUDFLARE_TEAM_DOMAIN === undefined ||
        config.CLOUDFLARE_ACCESS_AUD === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'missing Cloudflare settings',
      });
    }
    if (
      config.AUTH_MODE === 'trusted-header' &&
      !Array.isArray(config.TRUST_PROXY)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'explicit trusted proxy ranges required',
      });
    }
    if (!config.ALLOWED_SHELLS.includes(config.DEFAULT_SHELL)) {
      context.addIssue({
        code: 'custom',
        message: 'default shell not allowed',
      });
    }
  });

type LogLevel = (typeof logLevels)[number];
export type AuthMode =
  'local' | 'cloudflare-access' | 'trusted-header' | 'none';
export type TrustProxy = false | number | readonly string[];

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
  appConfigFile?: string;
  authMode: AuthMode;
  localAuthUsername: string;
  bcryptCost: number;
  authIdleMinutes: number;
  authAbsoluteHours: number;
  authSessionMaxCount: number;
  cloudflareTeamDomain?: string;
  cloudflareAccessAud?: string;
  trustProxy: TrustProxy;
  trustedAuthHeader: string;
  allowedShells: readonly string[];
  maxFontSize: number;
  maxXtermScrollback: number;
  maxTmuxHistoryLimit: number;
  maxStaleSessionCleanupHours: number;
  sessionCleanupIntervalMinutes: number;
}>;

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;
export type ConfigFileValues = Readonly<Record<string, unknown>>;

export function loadConfig(
  env: ConfigEnvironment,
  fileValues: ConfigFileValues = {},
): AppConfig {
  try {
    const file = fileValuesSchema.parse(fileValues);
    const pick = <K extends keyof typeof file>(
      environmentKey: string,
      fileKey: K,
      fallback: unknown,
    ): unknown => env[environmentKey] ?? file[fileKey] ?? fallback;
    const parsed = mergedSchema.parse({
      ...(env.APP_CONFIG_FILE === undefined
        ? {}
        : { APP_CONFIG_FILE: env.APP_CONFIG_FILE }),
      APP_PORT: pick('APP_PORT', 'port', 3000),
      APP_BIND_HOST: pick('APP_BIND_HOST', 'bindHost', '0.0.0.0'),
      APP_BASE_PATH: pick('APP_BASE_PATH', 'basePath', '/'),
      APP_PUBLIC_URL: pick(
        'APP_PUBLIC_URL',
        'publicUrl',
        'http://localhost:3000',
      ),
      DEFAULT_SHELL: pick('DEFAULT_SHELL', 'defaultShell', '/bin/bash'),
      DEFAULT_FONT_SIZE: pick('DEFAULT_FONT_SIZE', 'defaultFontSize', 14),
      XTERM_SCROLLBACK: pick('XTERM_SCROLLBACK', 'xtermScrollback', 10_000),
      TMUX_HISTORY_LIMIT: pick(
        'TMUX_HISTORY_LIMIT',
        'tmuxHistoryLimit',
        20_000,
      ),
      WS_HEARTBEAT_SECONDS: pick(
        'WS_HEARTBEAT_SECONDS',
        'wsHeartbeatSeconds',
        30,
      ),
      WS_MAX_BUFFER_BYTES: pick(
        'WS_MAX_BUFFER_BYTES',
        'wsMaxBufferBytes',
        1_048_576,
      ),
      RESIZE_DEBOUNCE_MS: pick('RESIZE_DEBOUNCE_MS', 'resizeDebounceMs', 100),
      RECONNECT_MAX_SECONDS: pick(
        'RECONNECT_MAX_SECONDS',
        'reconnectMaxSeconds',
        15,
      ),
      LOG_LEVEL: pick('LOG_LEVEL', 'logLevel', 'info'),
      HOME_DIR: pick('HOME_DIR', 'homeDir', '/home/webterm'),
      DATA_DIR: pick('DATA_DIR', 'dataDir', '/app/data'),
      SESSION_MAX_COUNT: pick('SESSION_MAX_COUNT', 'sessionMaxCount', 10),
      AUTH_MODE: pick('AUTH_MODE', 'authMode', 'local'),
      LOCAL_AUTH_USERNAME: pick(
        'LOCAL_AUTH_USERNAME',
        'localAuthUsername',
        'webterm',
      ),
      BCRYPT_COST: pick('BCRYPT_COST', 'bcryptCost', 12),
      AUTH_IDLE_MINUTES: pick('AUTH_IDLE_MINUTES', 'authIdleMinutes', 60),
      AUTH_ABSOLUTE_HOURS: pick('AUTH_ABSOLUTE_HOURS', 'authAbsoluteHours', 24),
      AUTH_SESSION_MAX_COUNT: pick(
        'AUTH_SESSION_MAX_COUNT',
        'authSessionMaxCount',
        32,
      ),
      ...(pick('CLOUDFLARE_TEAM_DOMAIN', 'cloudflareTeamDomain', undefined) ===
      undefined
        ? {}
        : {
            CLOUDFLARE_TEAM_DOMAIN: pick(
              'CLOUDFLARE_TEAM_DOMAIN',
              'cloudflareTeamDomain',
              undefined,
            ),
          }),
      ...(pick('CLOUDFLARE_ACCESS_AUD', 'cloudflareAccessAud', undefined) ===
      undefined
        ? {}
        : {
            CLOUDFLARE_ACCESS_AUD: pick(
              'CLOUDFLARE_ACCESS_AUD',
              'cloudflareAccessAud',
              undefined,
            ),
          }),
      TRUST_PROXY: pick('TRUST_PROXY', 'trustProxy', false),
      TRUSTED_AUTH_HEADER: pick(
        'TRUSTED_AUTH_HEADER',
        'trustedAuthHeader',
        'X-Auth-User',
      ),
      ALLOWED_SHELLS: pick('ALLOWED_SHELLS', 'allowedShells', ['/bin/bash']),
      MAX_FONT_SIZE: pick('MAX_FONT_SIZE', 'maxFontSize', 32),
      MAX_XTERM_SCROLLBACK: pick(
        'MAX_XTERM_SCROLLBACK',
        'maxXtermScrollback',
        100_000,
      ),
      MAX_TMUX_HISTORY_LIMIT: pick(
        'MAX_TMUX_HISTORY_LIMIT',
        'maxTmuxHistoryLimit',
        1_000_000,
      ),
      MAX_STALE_SESSION_CLEANUP_HOURS: pick(
        'MAX_STALE_SESSION_CLEANUP_HOURS',
        'maxStaleSessionCleanupHours',
        8_760,
      ),
      SESSION_CLEANUP_INTERVAL_MINUTES: pick(
        'SESSION_CLEANUP_INTERVAL_MINUTES',
        'sessionCleanupIntervalMinutes',
        15,
      ),
    });
    const publicUrl = new URL(parsed.APP_PUBLIC_URL);
    return deepFreeze({
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
      ...(parsed.APP_CONFIG_FILE === undefined
        ? {}
        : { appConfigFile: parsed.APP_CONFIG_FILE }),
      authMode: parsed.AUTH_MODE,
      localAuthUsername: parsed.LOCAL_AUTH_USERNAME,
      bcryptCost: parsed.BCRYPT_COST,
      authIdleMinutes: parsed.AUTH_IDLE_MINUTES,
      authAbsoluteHours: parsed.AUTH_ABSOLUTE_HOURS,
      authSessionMaxCount: parsed.AUTH_SESSION_MAX_COUNT,
      ...(parsed.CLOUDFLARE_TEAM_DOMAIN === undefined
        ? {}
        : { cloudflareTeamDomain: parsed.CLOUDFLARE_TEAM_DOMAIN }),
      ...(parsed.CLOUDFLARE_ACCESS_AUD === undefined
        ? {}
        : { cloudflareAccessAud: parsed.CLOUDFLARE_ACCESS_AUD }),
      trustProxy: parsed.TRUST_PROXY,
      trustedAuthHeader: parsed.TRUSTED_AUTH_HEADER,
      allowedShells: parsed.ALLOWED_SHELLS,
      maxFontSize: parsed.MAX_FONT_SIZE,
      maxXtermScrollback: parsed.MAX_XTERM_SCROLLBACK,
      maxTmuxHistoryLimit: parsed.MAX_TMUX_HISTORY_LIMIT,
      maxStaleSessionCleanupHours: parsed.MAX_STALE_SESSION_CLEANUP_HOURS,
      sessionCleanupIntervalMinutes: parsed.SESSION_CLEANUP_INTERVAL_MINUTES,
    });
  } catch {
    throw new Error('Invalid server configuration');
  }
}

export function toClientConfig(config: AppConfig): ClientConfig {
  return parseClientConfig({
    basePath: config.basePath,
    resizeDebounceMs: config.resizeDebounceMs,
    reconnectMaxSeconds: config.reconnectMaxSeconds,
  });
}

function parseProxyList(
  values: string | readonly string[],
  context: z.RefinementCtx,
) {
  const candidates = (
    typeof values === 'string' ? values.split(',') : values
  ).map((value) => value.trim().toLowerCase());
  if (candidates.length === 0 || candidates.length > MAX_TRUST_PROXY_ENTRIES) {
    context.addIssue({ code: 'custom', message: 'invalid proxy value' });
    return z.NEVER;
  }
  try {
    const normalized = [...new Set(candidates.map(normalizeProxyEntry))];
    proxyaddr.compile(normalized);
    return normalized;
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid proxy value' });
    return z.NEVER;
  }
}

function normalizeProxyEntry(value: string): string {
  const slash = value.lastIndexOf('/');
  let address: ipaddr.IPv4 | ipaddr.IPv6;
  let prefix: number;
  if (slash === -1) {
    address = ipaddr.parse(value);
    prefix = address.kind() === 'ipv4' ? 32 : 128;
  } else {
    if (slash !== value.indexOf('/')) throw new Error('invalid CIDR');
    [address, prefix] = ipaddr.parseCIDR(value);
  }

  if (
    address.kind() === 'ipv6' &&
    (address as ipaddr.IPv6).isIPv4MappedAddress() &&
    prefix >= 96
  ) {
    address = (address as ipaddr.IPv6).toIPv4Address();
    prefix -= 96;
  }

  const cidr = `${address.toString()}/${prefix}`;
  const network =
    address.kind() === 'ipv4'
      ? ipaddr.IPv4.networkAddressFromCIDR(cidr)
      : ipaddr.IPv6.networkAddressFromCIDR(cidr);
  return `${network.toString()}/${prefix}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
