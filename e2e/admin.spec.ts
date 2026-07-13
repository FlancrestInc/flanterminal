import { expect, test, type Page } from '@playwright/test';

import { authMode, openAuthenticatedWorkspace } from './fixtures/auth.js';

test.skip(authMode !== 'local', 'local authentication deployment only');

test('reports metrics and isolates every administration lifecycle action', async ({
  page,
}) => {
  await openAuthenticatedWorkspace(page);
  await setCleanupHours(page, '1');
  await page.getByRole('button', { name: 'Administration' }).click();
  await expect(
    page.getByRole('heading', { name: 'Administration' }),
  ).toBeVisible();
  const health = page.getByRole('region', { name: 'Application health' });
  await expect(health).toContainText('RSS');
  await expect(health).toContainText('1 tabs');
  await expect(health).toContainText('1 running');

  await page
    .getByRole('button', { name: 'Restart bridge for Terminal 1' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Restart bridge for Terminal 1' }),
  ).toBeEnabled();

  await confirmedAction(
    page,
    'Restart session for Terminal 1',
    'Restart session',
  );
  await expect(page.getByText('active / running')).toBeVisible();

  await confirmedAction(
    page,
    'Terminate session for Terminal 1',
    'Terminate session',
  );
  await expect(
    page.getByRole('button', { name: 'Recreate session for Terminal 1' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Recreate session for Terminal 1' })
    .click();
  await expect(
    page.getByRole('button', { name: 'Restart bridge for Terminal 1' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Run stale session cleanup' }).click();
  const cleanupDialog = page.getByRole('dialog');
  await expect(cleanupDialog).toContainText('currently eligible');
  await cleanupDialog.getByRole('button', { name: 'Run cleanup' }).click();
  await expect(page.getByRole('status')).toContainText('Cleanup examined');

  await page.getByRole('button', { name: 'Back to terminal' }).click();
  await setCleanupHours(page, '0');
});

async function confirmedAction(
  page: Page,
  actionLabel: string,
  confirmLabel: string,
): Promise<void> {
  await page.getByRole('button', { name: actionLabel }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: confirmLabel }).click();
}

async function setCleanupHours(page: Page, value: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByLabel('Stale cleanup hours').fill(value);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByRole('button', { name: 'Back to terminal' }).click();
}
