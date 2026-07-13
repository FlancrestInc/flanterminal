import type { Page } from '@playwright/test';

export type CloudflareTokenKind = 'valid' | 'expired' | 'wrong-audience';

function controlUrl(path: string): URL {
  const base = process.env.E2E_CLOUDFLARE_CONTROL_URL;
  if (base === undefined) {
    throw new Error(
      'E2E_CLOUDFLARE_CONTROL_URL is required in Cloudflare mode',
    );
  }
  return new URL(path, base.endsWith('/') ? base : `${base}/`);
}

export async function cloudflareToken(
  kind: CloudflareTokenKind,
): Promise<string> {
  const response = await fetch(controlUrl(`control/token?kind=${kind}`));
  if (!response.ok)
    throw new Error(`Cloudflare token fixture failed: ${response.status}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string')
    throw new Error('Cloudflare token fixture returned no token');
  return body.token;
}

export async function installCloudflareAssertion(
  page: Page,
  kind: CloudflareTokenKind = 'valid',
): Promise<void> {
  await page.setExtraHTTPHeaders({
    'Cf-Access-Jwt-Assertion': await cloudflareToken(kind),
  });
}

export async function rotateCloudflareKey(page: Page): Promise<void> {
  const response = await fetch(controlUrl('control/rotate'), {
    method: 'POST',
  });
  if (!response.ok)
    throw new Error(`Cloudflare rotation fixture failed: ${response.status}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string')
    throw new Error('Cloudflare rotation returned no token');
  await page.setExtraHTTPHeaders({ 'Cf-Access-Jwt-Assertion': body.token });
}
