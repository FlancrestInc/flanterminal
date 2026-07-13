import { isSessionId } from '@flanterminal/shared';

export type UpgradeAuthorizationOptions = Readonly<{
  publicOrigin: string;
  basePath: string;
}>;

export type UpgradeRequest = Readonly<{
  origin: string | undefined;
  rawHeaders?: readonly string[];
  requestUrl: string | undefined;
}>;

export type UpgradeAuthorization =
  | Readonly<{ allowed: true; sessionId: string }>
  | Readonly<{ allowed: false; status: 403 | 404 }>;

export function websocketSessionPath(
  basePath: string,
  sessionId: string,
): string {
  const prefix = basePath === '/' ? '' : basePath;
  return `${prefix}/ws/sessions/${sessionId}`;
}

export function authorizeUpgrade(
  request: UpgradeRequest,
  options: UpgradeAuthorizationOptions,
): UpgradeAuthorization {
  const origin =
    request.rawHeaders === undefined
      ? request.origin
      : exactRawOrigin(request.rawHeaders);
  if (
    origin === undefined ||
    origin !== request.origin ||
    !isExactOrigin(origin, options.publicOrigin)
  ) {
    return { allowed: false, status: 403 };
  }
  const prefix = options.basePath === '/' ? '' : options.basePath;
  const routePrefix = `${prefix}/ws/sessions/`;
  if (
    request.requestUrl === undefined ||
    !request.requestUrl.startsWith(routePrefix)
  ) {
    return { allowed: false, status: 404 };
  }
  const sessionId = request.requestUrl.slice(routePrefix.length);
  if (
    !isSessionId(sessionId) ||
    request.requestUrl !== websocketSessionPath(options.basePath, sessionId)
  ) {
    return { allowed: false, status: 404 };
  }
  return { allowed: true, sessionId };
}

function exactRawOrigin(rawHeaders: readonly string[]): string | undefined {
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length > 128) return undefined;
  let totalBytes = 0;
  const origins: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== 'string' || typeof value !== 'string') return undefined;
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes > 16 * 1024) return undefined;
    if (name.toLowerCase() !== 'origin') continue;
    if (Buffer.byteLength(value) > 2_048) return undefined;
    origins.push(value);
  }
  return origins.length === 1 ? origins[0] : undefined;
}

function isExactOrigin(
  candidate: string | undefined,
  configured: string,
): boolean {
  if (candidate === undefined || candidate === 'null') return false;
  if (hasAsciiControlOrWhitespace(candidate)) return false;
  if (!/^https?:\/\/[^/?#]+$/i.test(candidate)) return false;
  try {
    const actual = new URL(candidate);
    const expected = new URL(configured);
    return (
      isHttpOrigin(actual) &&
      isHttpOrigin(expected) &&
      actual.origin === expected.origin
    );
  } catch {
    return false;
  }
}

function hasAsciiControlOrWhitespace(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isHttpOrigin(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.origin !== 'null'
  );
}
