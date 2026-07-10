import { FIXED_SESSION_ID } from '@flanterminal/shared';

export type UpgradeAuthorizationOptions = Readonly<{
  publicOrigin: string;
  basePath: string;
}>;

export type UpgradeRequest = Readonly<{
  origin: string | undefined;
  requestUrl: string | undefined;
}>;

export type UpgradeAuthorization =
  | Readonly<{ allowed: true; sessionId: typeof FIXED_SESSION_ID }>
  | Readonly<{ allowed: false; status: 403 | 404 }>;

export function websocketSessionPath(basePath: string): string {
  const prefix = basePath === '/' ? '' : basePath;
  return `${prefix}/ws/sessions/${FIXED_SESSION_ID}`;
}

export function authorizeUpgrade(
  request: UpgradeRequest,
  options: UpgradeAuthorizationOptions,
): UpgradeAuthorization {
  if (!isExactOrigin(request.origin, options.publicOrigin)) {
    return { allowed: false, status: 403 };
  }
  if (request.requestUrl !== websocketSessionPath(options.basePath)) {
    return { allowed: false, status: 404 };
  }
  return { allowed: true, sessionId: FIXED_SESSION_ID };
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
