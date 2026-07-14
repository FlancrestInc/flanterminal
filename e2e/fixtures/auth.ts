import { expect, type Page } from '@playwright/test';

export const workspacePath = process.env.E2E_BASE_PATH ?? '/';
export const authMode = process.env.E2E_MODE ?? 'local';
export const localUsername = process.env.E2E_LOCAL_USERNAME ?? 'webterm';

export function localPassword(): string {
  const password = process.env.E2E_LOCAL_PASSWORD;
  if (password === undefined || password.length < 12) {
    throw new Error(
      'E2E_LOCAL_PASSWORD must contain an untracked test password',
    );
  }
  return password;
}

export async function enrollLocalAdministrator(page: Page): Promise<void> {
  const password = localPassword();
  await page.goto(workspacePath);

  await expect(
    page.getByRole('heading', { name: 'Set up FlanTerminal' }),
  ).toBeVisible();
  const username = page.getByLabel('Username');
  await expect(username).toHaveValue(localUsername);
  await expect(username).toHaveAttribute('readonly', '');
  await expect(username).toHaveAttribute('autocomplete', 'username');

  const newPassword = page.getByLabel('New Password');
  const confirmation = page.getByLabel('Confirm password');
  await expect(newPassword).toHaveAttribute('autocomplete', 'new-password');
  await expect(confirmation).toHaveAttribute('autocomplete', 'new-password');

  await newPassword.fill(password);
  await confirmation.fill(`${password}-mismatch`);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(page.getByRole('alert')).toHaveText('Passwords do not match.');
  await expect(
    page.getByRole('heading', { name: 'Set up FlanTerminal' }),
  ).toBeVisible();

  await newPassword.fill(password);
  await confirmation.fill(password);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await signInLocal(page, password);
}

export async function signInLocal(
  page: Page,
  password = localPassword(),
): Promise<void> {
  await page.getByLabel('Username').fill(localUsername);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
}

export async function openAuthenticatedWorkspace(page: Page): Promise<void> {
  if (authMode === 'cloudflare') {
    const { installCloudflareAssertion } = await import('./cloudflare.js');
    await installCloudflareAssertion(page);
  }
  await page.goto(workspacePath);
  if (authMode === 'local') await signInLocal(page);
}
