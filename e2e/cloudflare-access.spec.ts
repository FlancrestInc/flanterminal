import { expect, test } from '@playwright/test';

import {
  authMode,
  openAuthenticatedWorkspace,
  workspacePath,
} from './fixtures/auth.js';
import {
  installCloudflareAssertion,
  rotateCloudflareKey,
  type CloudflareTokenKind,
} from './fixtures/cloudflare.js';

test.skip(authMode !== 'cloudflare', 'Cloudflare Access deployment only');
test.describe.configure({ mode: 'serial' });

test('rejects invalid Cloudflare claims without allocating a terminal tab', async ({
  browser,
}) => {
  for (const kind of ['expired', 'wrong-audience'] as CloudflareTokenKind[]) {
    const context = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL ?? 'http://app:3000/',
    });
    try {
      const page = await context.newPage();
      await installCloudflareAssertion(page, kind);
      await page.goto(workspacePath);
      await expect(
        page.getByRole('heading', { name: 'Terminal access' }),
      ).toBeVisible();
      await expect(page.getByRole('alert')).toHaveText(
        'Access could not be verified.',
      );
    } finally {
      await context.close();
    }
  }

  const context = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL ?? 'http://app:3000/',
  });
  try {
    const page = await context.newPage();
    await openAuthenticatedWorkspace(page);
    await expect(page.getByRole('tab')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('uses a valid assertion for terminal WebSockets and refreshes a rotated key', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openAuthenticatedWorkspace(page);
  await expect(page.locator('.terminal-tab.is-active .tab-status')).toHaveClass(
    /status-connected/,
  );
  await page
    .locator('.terminal-panel:not([hidden])')
    .getByRole('region', { name: 'Terminal' })
    .focus();
  await page.keyboard.type("printf 'CLOUDFLARE_READY\\n'");
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.locator('.terminal-panel:not([hidden]) .xterm-rows').innerText(),
    )
    .toContain('CLOUDFLARE_READY');

  await rotateCloudflareKey(page);
  await page.waitForTimeout(31_000);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('.terminal-tab.is-active .tab-status')).toHaveClass(
    /status-connected/,
  );
});
