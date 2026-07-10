import { z } from 'zod';

const baseUrl = new URL('http://base.invalid');
const safeSegmentPattern = /^[A-Za-z0-9._~-]+$/;

export function normalizeBasePath(value: string): string | undefined {
  if (!value.startsWith('/') || value.includes('\\')) return undefined;

  const normalized = value.replace(/\/+$/, '') || '/';
  if (normalized === '/') return value === '/' ? normalized : undefined;

  const segments = normalized.split('/').slice(1);
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        !safeSegmentPattern.test(segment),
    )
  ) {
    return undefined;
  }

  try {
    const parsed = new URL(normalized, baseUrl);
    if (
      parsed.origin !== baseUrl.origin ||
      parsed.pathname !== normalized ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return normalized;
}

export const basePathSchema = z.string().transform((value, context) => {
  const normalized = normalizeBasePath(value);
  if (normalized === undefined) {
    context.addIssue({ code: 'custom', message: 'invalid base path' });
    return z.NEVER;
  }
  return normalized;
});
