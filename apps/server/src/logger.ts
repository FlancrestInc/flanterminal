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
const redactPaths = sensitiveKeys.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
]);

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
      target.info({ ...metadata, event });
    },
    warn(event, metadata = {}) {
      target.warn({ ...metadata, event });
    },
    error(event, metadata = {}) {
      target.error({ ...metadata, event });
    },
  };
}
