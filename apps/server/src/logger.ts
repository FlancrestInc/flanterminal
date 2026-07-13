import pino, { type DestinationStream } from 'pino';

export type LifecycleMetadata = Readonly<Record<string, unknown>>;

export interface LifecycleLogger {
  info(event: string, metadata?: LifecycleMetadata): void;
  warn(event: string, metadata?: LifecycleMetadata): void;
  error(event: string, metadata?: LifecycleMetadata): void;
}

const recognizedEvents = new Set([
  'authentication_activity_failed',
  'authentication_request_rejected',
  'authentication_route_failed',
  'protocol_message_rejected',
  'server_started',
  'settings_route_failed',
  'settings_store_durability_degraded',
  'shutdown_failed',
  'socket_close_failed',
  'socket_error',
  'subscription_dispose_failed',
  'tab_store_durability_degraded',
  'terminal_activity_failed',
  'terminal_backpressure',
  'terminal_closed',
  'terminal_connection_failed',
  'terminal_exited',
  'terminal_kill_failed',
  'terminal_opened',
  'terminal_resize_failed',
  'terminal_send_failed',
  'terminal_setup_failed',
  'terminal_write_failed',
]);
const allowedCategories = new Set([
  'invalid_request',
  'origin_forbidden',
  'tab_not_found',
  'session_limit',
  'order_conflict',
  'invalid_session_state',
  'json_required',
  'operation_failed',
  'authentication_required',
  'authentication_failed',
  'csrf_invalid',
  'rate_limited',
  'password_invalid',
  'settings_invalid',
  'durability_uncertain',
  'cleanup_disabled',
  'binary_payload',
  'payload_too_large',
  'invalid_json',
  'invalid_message',
  'session_mismatch',
  'cleanup_failed',
]);
const safeSessionIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeBindHostPattern = /^[A-Za-z0-9.:[\]_-]{1,255}$/;
const safeBasePathPattern = /^\/(?:[A-Za-z0-9._~-]+\/?)*$/;
const identityHashPattern = /^sha256:[a-f0-9]{64}$/;

function sanitizeMetadata(metadata: LifecycleMetadata): LifecycleMetadata {
  const sanitized = Object.create(null) as Record<string, unknown>;
  copyString(metadata, sanitized, 'sessionId', safeSessionIdPattern, 36);
  copyAllowedString(metadata, sanitized, 'category', allowedCategories);
  copyInteger(metadata, sanitized, 'exitCode', -2_147_483_648, 2_147_483_647);
  copyInteger(metadata, sanitized, 'signal', 0, 2_147_483_647);
  copyInteger(
    metadata,
    sanitized,
    'bufferedAmount',
    0,
    Number.MAX_SAFE_INTEGER,
  );
  copyInteger(metadata, sanitized, 'code', 0, 65_535);
  copyInteger(metadata, sanitized, 'port', 1, 65_535);
  copyInteger(metadata, sanitized, 'status', 100, 599);
  copyString(metadata, sanitized, 'bindHost', safeBindHostPattern, 255);
  copyString(metadata, sanitized, 'basePath', safeBasePathPattern, 256);
  copyString(metadata, sanitized, 'identityHash', identityHashPattern, 71);
  return sanitized;
}

function copyAllowedString(
  source: LifecycleMetadata,
  target: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
): void {
  const value = readMetadata(source, key);
  if (typeof value === 'string' && allowed.has(value)) target[key] = value;
}

function copyString(
  source: LifecycleMetadata,
  target: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  maximumLength: number,
): void {
  const value = readMetadata(source, key);
  if (
    typeof value === 'string' &&
    value.length <= maximumLength &&
    pattern.test(value)
  )
    target[key] = value;
}

function copyInteger(
  source: LifecycleMetadata,
  target: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): void {
  const value = readMetadata(source, key);
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  )
    target[key] = value;
}

function readMetadata(metadata: LifecycleMetadata, key: string): unknown {
  try {
    return Reflect.get(metadata, key);
  } catch {
    return undefined;
  }
}

function eventName(event: string): string {
  return recognizedEvents.has(event) ? event : 'unrecognized_event';
}

export function createLifecycleLogger(
  level: pino.LevelWithSilent = 'info',
  destination?: DestinationStream,
): LifecycleLogger {
  const target = pino(
    {
      level,
    },
    destination,
  );

  return {
    info(event, metadata = {}) {
      target.info({ ...sanitizeMetadata(metadata), event: eventName(event) });
    },
    warn(event, metadata = {}) {
      target.warn({ ...sanitizeMetadata(metadata), event: eventName(event) });
    },
    error(event, metadata = {}) {
      target.error({ ...sanitizeMetadata(metadata), event: eventName(event) });
    },
  };
}
