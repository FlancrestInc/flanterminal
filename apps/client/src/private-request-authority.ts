import { basePathSchema } from '@flanterminal/shared';

export type PrivateRequestBoundary = Readonly<{
  basePath: string;
  baseUrl: string;
}>;

export type ComposedAbortSignal = Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}>;

export function privateRequestUrl(
  input: RequestInfo | URL,
  boundary: PrivateRequestBoundary,
): URL | undefined {
  const basePath = basePathSchema.parse(boundary.basePath);
  const baseUrl = new URL(boundary.baseUrl);
  const raw = requestUrl(input);
  if (hasAmbiguousPath(raw)) return undefined;
  let candidate: URL;
  try {
    candidate = new URL(raw, baseUrl);
  } catch {
    return undefined;
  }
  if (
    candidate.origin !== baseUrl.origin ||
    candidate.username !== '' ||
    candidate.password !== '' ||
    candidate.hash !== '' ||
    candidate.pathname.includes('//') ||
    /%(?:2e|2f|5c)/i.test(candidate.pathname)
  )
    return undefined;
  const apiPrefix = basePath === '/' ? '/api/' : `${basePath}/api/`;
  return candidate.pathname.startsWith(apiPrefix) ? candidate : undefined;
}

export function basePathFromDocument(baseUrl: string): string {
  const pathname = new URL(baseUrl).pathname;
  const withoutTrailingSlash =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  return basePathSchema.parse(withoutTrailingSlash || '/');
}

export function composeAbortSignals(
  signals: readonly AbortSignal[],
): ComposedAbortSignal {
  const unique = [...new Set(signals)];
  if (unique.length === 1)
    return Object.freeze({ signal: unique[0]!, dispose: () => undefined });

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const [signal, listener] of listeners)
      signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  const abortFrom = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
    dispose();
  };

  for (const signal of unique) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    listeners.set(signal, listener);
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
  }
  return Object.freeze({ signal: controller.signal, dispose });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function hasAmbiguousPath(raw: string): boolean {
  const beforeQuery = raw.split(/[?#]/u, 1)[0] ?? '';
  const path = beforeQuery
    .replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/iu, '')
    .replace(/^\/\/[^/]*/u, '');
  return (
    path.includes('\\') ||
    /%(?:2e|2f|5c)/iu.test(path) ||
    /(?:^|\/)\.{1,2}(?:\/|$)/u.test(path)
  );
}
