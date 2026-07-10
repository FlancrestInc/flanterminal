import pino, { type DestinationStream } from 'pino';

export type LifecycleMetadata = Readonly<Record<string, unknown>>;

export interface LifecycleLogger {
  info(event: string, metadata?: LifecycleMetadata): void;
  warn(event: string, metadata?: LifecycleMetadata): void;
  error(event: string, metadata?: LifecycleMetadata): void;
}

const sensitiveKeys = [
  'password',
  'token',
  'authorization',
  'cookie',
  'privateKey',
  'env',
];
const sensitiveKeySet = new Set([
  ...sensitiveKeys.map((key) => key.toLowerCase()),
  'secret',
  'apikey',
  'accesstoken',
]);
const redactPaths = sensitiveKeys.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
]);
const MAX_METADATA_DEPTH = 8;
const MAX_CONTAINER_ENTRIES = 100;

function sanitizeValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular]';
  if (depth >= MAX_METADATA_DEPTH) return '[Truncated]';

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const sanitized = value
        .slice(0, MAX_CONTAINER_ENTRIES)
        .map((entry) => sanitizeValue(entry, depth + 1, ancestors));
      if (value.length > MAX_CONTAINER_ENTRIES) sanitized.push('[Truncated]');
      return sanitized;
    }

    const sanitized = Object.create(null) as Record<string, unknown>;
    const keys = Object.keys(value).slice(0, MAX_CONTAINER_ENTRIES);
    for (const key of keys) {
      if (sensitiveKeySet.has(key.toLowerCase())) {
        sanitized[key] = '[Redacted]';
        continue;
      }
      try {
        sanitized[key] = sanitizeValue(
          (value as Record<string, unknown>)[key],
          depth + 1,
          ancestors,
        );
      } catch {
        sanitized[key] = '[Unavailable]';
      }
    }
    if (Object.keys(value).length > MAX_CONTAINER_ENTRIES) {
      sanitized.truncated = '[Truncated]';
    }
    return sanitized;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeMetadata(metadata: LifecycleMetadata): LifecycleMetadata {
  return sanitizeValue(metadata, 0, new WeakSet<object>()) as LifecycleMetadata;
}

export function createLifecycleLogger(
  level: pino.LevelWithSilent = 'info',
  destination?: DestinationStream,
): LifecycleLogger {
  const target = pino(
    {
      level,
      redact: { paths: redactPaths, censor: '[Redacted]' },
    },
    destination,
  );

  return {
    info(event, metadata = {}) {
      target.info({ ...sanitizeMetadata(metadata), event });
    },
    warn(event, metadata = {}) {
      target.warn({ ...sanitizeMetadata(metadata), event });
    },
    error(event, metadata = {}) {
      target.error({ ...sanitizeMetadata(metadata), event });
    },
  };
}
