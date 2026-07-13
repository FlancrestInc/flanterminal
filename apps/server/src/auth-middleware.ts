import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type {
  AuthenticatedSession,
  AuthMode,
  UpstreamAuthentication,
  UpstreamIdentity,
} from './auth-types.js';
import type {
  UpstreamHeaderView,
  UpstreamIdentityProvider,
} from './cloudflare-access.js';
import type { LifecycleMetadata } from './logger.js';
import type { TrustedHeaderRequestView } from './trusted-header-auth.js';

export const SESSION_COOKIE_NAME = 'flanterminal_session';
export const CSRF_HEADER_NAME = 'x-csrf-token';

const MAX_COOKIE_HEADER_BYTES = 8 * 1024;
const MAX_COOKIE_PAIRS = 32;
const MAX_RAW_HEADER_ITEMS = 128;
const MAX_RAW_HEADER_FIELDS = MAX_RAW_HEADER_ITEMS / 2;
const MAX_RAW_HEADER_BYTES = 16 * 1024;
const MAX_COOKIE_FIELD_LINES = 8;
const MAX_SESSION_COOKIE_BYTES = 256;
const MAX_CSRF_BYTES = 512;
const sessionTokenPattern = /^[A-Za-z0-9_-]+$/;
const visibleAsciiPattern = /^[\x21-\x7e]+$/;
const headerAsciiPattern = /^[\x20-\x7e]+$/;
const charsetParameterPattern = /^charset=[A-Za-z0-9._-]+$/i;
const utf8 = new TextEncoder();

export interface AuthMiddlewareService {
  authenticateCookie(
    rawCookie: string | undefined,
  ): AuthenticatedSession | undefined;
  verifyCsrf(id: string, supplied: string | undefined): boolean;
  touch(id: string, activity: 'http' | 'terminal_input'): void;
}

export interface AuthEventLogger {
  warn(event: string, metadata?: LifecycleMetadata): void;
  error(event: string, metadata?: LifecycleMetadata): void;
}

export type AuthMiddlewareOptions = Readonly<{
  authService: AuthMiddlewareService;
  mode: AuthMode;
  publicOrigin: string;
  cloudflareAccessProvider?: UpstreamIdentityProvider<UpstreamHeaderView>;
  trustedHeaderProvider?: UpstreamIdentityProvider<TrustedHeaderRequestView>;
  logger?: AuthEventLogger;
}>;

export type AuthenticatedLocals = Readonly<{
  authSession: AuthenticatedSession;
  upstreamIdentity?: UpstreamIdentity;
}>;

export function requireAuthentication(
  options: AuthMiddlewareOptions,
): RequestHandler {
  return (request, response, next) =>
    authenticate(options, request, response, next);
}

export function requireMutationSecurity(
  options: Pick<
    AuthMiddlewareOptions,
    'authService' | 'publicOrigin' | 'logger'
  >,
): RequestHandler {
  return (request, response, next) => {
    if (!hasExactHeader(request, 'origin', options.publicOrigin)) {
      reject(options, response, 403, 'origin_forbidden');
      return;
    }
    if (request.method !== 'DELETE' && !hasJsonContentType(request)) {
      reject(options, response, 415, 'json_required');
      return;
    }
    const session = response.locals.authSession as
      AuthenticatedSession | undefined;
    const csrf = oneBoundedHeader(
      request,
      CSRF_HEADER_NAME,
      MAX_CSRF_BYTES,
      visibleAsciiPattern,
    );
    if (
      session === undefined ||
      csrf === undefined ||
      !options.authService.verifyCsrf(session.id, csrf)
    ) {
      reject(options, response, 403, 'csrf_invalid');
      return;
    }
    next();
  };
}

export function requirePublicMutationSecurity(
  options: Pick<AuthMiddlewareOptions, 'publicOrigin' | 'logger'>,
): RequestHandler {
  return (request, response, next) => {
    if (!hasExactHeader(request, 'origin', options.publicOrigin)) {
      reject(options, response, 403, 'origin_forbidden');
      return;
    }
    if (!hasJsonContentType(request)) {
      reject(options, response, 415, 'json_required');
      return;
    }
    next();
  };
}

export function touchHttpActivity(
  options: Pick<AuthMiddlewareOptions, 'authService' | 'logger'>,
): RequestHandler {
  return (request, response, next) => {
    const session = response.locals.authSession as
      AuthenticatedSession | undefined;
    if (session === undefined) {
      reject(options, response, 401, 'authentication_required');
      return;
    }
    let current: AuthenticatedSession | undefined;
    try {
      current = options.authService.authenticateCookie(
        readSessionCookie(request),
      );
    } catch {
      reject(options, response, 401, 'authentication_required');
      return;
    }
    const upstreamIdentity = response.locals.upstreamIdentity as
      UpstreamIdentity | undefined;
    if (
      current === undefined ||
      !sameAuthority(session, current) ||
      !identityMatches(current, upstreamIdentity)
    ) {
      reject(options, response, 401, 'authentication_required');
      return;
    }
    response.locals.authSession = immutableSession(current);
    try {
      options.authService.touch(current.id, 'http');
    } catch {
      log(options.logger, 'error', 'authentication_activity_failed', {
        category: 'operation_failed',
      });
      response.status(500).json({ error: 'operation_failed' });
      return;
    }
    next();
  };
}

export function setSessionCookie(
  response: Response,
  value: string,
  basePath: string,
  secure: boolean,
): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid cookie');
  response.append(
    'Set-Cookie',
    serializeCookie(value, basePath, secure, false),
  );
}

export function clearSessionCookie(
  response: Response,
  basePath: string,
  secure: boolean,
): void {
  response.append('Set-Cookie', serializeCookie('', basePath, secure, true));
}

export function authenticatedLocals(
  response: Response,
): AuthenticatedLocals | undefined {
  const authSession = response.locals.authSession as
    AuthenticatedSession | undefined;
  if (authSession === undefined) return undefined;
  const upstreamIdentity = response.locals.upstreamIdentity as
    UpstreamIdentity | undefined;
  return Object.freeze({
    authSession,
    ...(upstreamIdentity === undefined ? {} : { upstreamIdentity }),
  });
}

async function authenticate(
  options: AuthMiddlewareOptions,
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  let resolved: AuthenticatedLocals | undefined;
  try {
    resolved = await resolveAuthentication(options, request);
  } catch {
    reject(options, response, 401, 'authentication_required');
    return;
  }
  if (resolved === undefined) {
    reject(options, response, 401, 'authentication_required');
    return;
  }
  response.locals.authSession = resolved.authSession;
  if (resolved.upstreamIdentity !== undefined)
    response.locals.upstreamIdentity = resolved.upstreamIdentity;
  next();
}

export async function resolveAuthentication(
  options: AuthMiddlewareOptions,
  request: Request,
): Promise<AuthenticatedLocals | undefined> {
  const cookie = readSessionCookie(request);
  if (cookie === undefined) return undefined;
  const session = options.authService.authenticateCookie(cookie);
  if (session === undefined || session.mode !== options.mode) return undefined;
  const upstreamIdentity = await currentUpstreamIdentity(options, request);
  if (!identityMatches(session, upstreamIdentity)) return undefined;
  const current = options.authService.authenticateCookie(cookie);
  if (
    current === undefined ||
    !sameAuthority(session, current) ||
    !identityMatches(current, upstreamIdentity)
  )
    return undefined;
  return Object.freeze({
    authSession: immutableSession(current),
    ...(upstreamIdentity === undefined
      ? {}
      : { upstreamIdentity: immutableIdentity(upstreamIdentity) }),
  });
}

export async function upstreamAuthentication(
  options: AuthMiddlewareOptions,
  request: Request,
): Promise<UpstreamAuthentication> {
  const identity = await currentUpstreamIdentity(options, request);
  return identity === undefined
    ? Object.freeze({ type: 'none' })
    : Object.freeze({
        type: 'upstream',
        identity: immutableIdentity(identity),
      });
}

async function currentUpstreamIdentity(
  options: AuthMiddlewareOptions,
  request: Request,
): Promise<UpstreamIdentity | undefined> {
  if (options.mode === 'local' || options.mode === 'none') return undefined;
  if (options.mode === 'cloudflare-access') {
    if (options.cloudflareAccessProvider === undefined) throw new Error();
    return await options.cloudflareAccessProvider.authenticate(
      request.headers as UpstreamHeaderView,
    );
  }
  if (options.trustedHeaderProvider === undefined) throw new Error();
  return await options.trustedHeaderProvider.authenticate({
    remoteAddress: request.socket.remoteAddress,
    headers: request.headers as UpstreamHeaderView,
    headersDistinct: request.headersDistinct,
    rawHeaders: request.rawHeaders,
  });
}

function identityMatches(
  session: AuthenticatedSession,
  upstream: UpstreamIdentity | undefined,
): boolean {
  if (session.mode === 'local' || session.mode === 'none')
    return upstream === undefined;
  return (
    upstream !== undefined &&
    upstream.mode === session.mode &&
    upstream.identityLabel === session.identityLabel
  );
}

function sameAuthority(
  expected: AuthenticatedSession,
  current: AuthenticatedSession,
): boolean {
  return (
    current.id === expected.id &&
    current.mode === expected.mode &&
    current.identityLabel === expected.identityLabel
  );
}

function readSessionCookie(request: Request): string | undefined {
  const { rawHeaders } = request;
  if (
    !Array.isArray(rawHeaders) ||
    rawHeaders.length % 2 !== 0 ||
    rawHeaders.length > MAX_RAW_HEADER_ITEMS ||
    rawHeaders.length / 2 > MAX_RAW_HEADER_FIELDS
  )
    return undefined;
  const headers: string[] = [];
  let rawHeaderBytes = 0;
  let byteCount = 0;
  let cookieFieldLines = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') return undefined;
    rawHeaderBytes +=
      utf8.encode(name).byteLength + utf8.encode(value).byteLength;
    if (rawHeaderBytes > MAX_RAW_HEADER_BYTES) return undefined;
    if (name.toLowerCase() !== 'cookie') continue;
    cookieFieldLines += 1;
    if (cookieFieldLines > MAX_COOKIE_FIELD_LINES) return undefined;
    byteCount += utf8.encode(value).byteLength;
    if (byteCount > MAX_COOKIE_HEADER_BYTES) return undefined;
    headers.push(value);
  }
  if (headers.length === 0) return undefined;

  let pairCount = 0;
  const sessions: string[] = [];
  for (const header of headers) {
    for (const rawPair of header.split(';')) {
      pairCount += 1;
      if (pairCount > MAX_COOKIE_PAIRS) return undefined;
      const pair = rawPair.trim();
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      if (name !== SESSION_COOKIE_NAME) continue;
      const value = pair.slice(separator + 1);
      sessions.push(value);
    }
  }
  if (sessions.length !== 1) return undefined;
  const session = sessions[0]!;
  return utf8.encode(session).byteLength <= MAX_SESSION_COOKIE_BYTES &&
    sessionTokenPattern.test(session)
    ? session
    : undefined;
}

function hasJsonContentType(request: Request): boolean {
  const value = oneBoundedHeader(
    request,
    'content-type',
    128,
    headerAsciiPattern,
  );
  if (value === undefined) return false;
  const [mediaType, ...parameters] = value.split(';');
  if (mediaType?.trim().toLowerCase() !== 'application/json') return false;
  if (parameters.length === 0) return true;
  return (
    parameters.length === 1 &&
    charsetParameterPattern.test(parameters[0]?.trim() ?? '')
  );
}

function hasExactHeader(
  request: Request,
  wanted: string,
  expected: string,
): boolean {
  return (
    oneBoundedHeader(request, wanted, 2_048, headerAsciiPattern) === expected
  );
}

function oneBoundedHeader(
  request: Request,
  wanted: string,
  maximumBytes: number,
  pattern: RegExp,
): string | undefined {
  const matches: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() !== wanted) continue;
    const value = request.rawHeaders[index + 1];
    if (typeof value !== 'string') return undefined;
    matches.push(value);
  }
  if (matches.length !== 1) return undefined;
  const value = matches[0]!;
  return utf8.encode(value).byteLength <= maximumBytes && pattern.test(value)
    ? value
    : undefined;
}

function immutableSession(session: AuthenticatedSession): AuthenticatedSession {
  return Object.freeze({ ...session });
}

function immutableIdentity(identity: UpstreamIdentity): UpstreamIdentity {
  return Object.freeze({ ...identity });
}

function serializeCookie(
  value: string,
  basePath: string,
  secure: boolean,
  clear: boolean,
): string {
  if (
    typeof basePath !== 'string' ||
    !basePath.startsWith('/') ||
    basePath.includes(';') ||
    [...basePath].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 32 || codePoint === 127;
    })
  )
    throw new Error('Invalid cookie path');
  return [
    `${SESSION_COOKIE_NAME}=${value}`,
    `Path=${basePath}`,
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Strict',
    ...(clear ? ['Max-Age=0'] : []),
  ].join('; ');
}

function reject(
  options: Readonly<{ logger?: AuthEventLogger }>,
  response: Response,
  status: number,
  error: string,
): void {
  log(options.logger, 'warn', 'authentication_request_rejected', {
    category: error,
    status,
  });
  response.set('Cache-Control', 'no-store').status(status).json({ error });
}

function log(
  logger: AuthEventLogger | undefined,
  level: 'warn' | 'error',
  event: string,
  metadata: LifecycleMetadata,
): void {
  try {
    logger?.[level](event, Object.freeze({ ...metadata }));
  } catch {
    // Authentication authority cannot depend on logging availability.
  }
}
