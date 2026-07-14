import { test } from '@playwright/test';

import { authMode, enrollLocalAdministrator } from './fixtures/auth.js';

test.skip(
  authMode === 'cloudflare',
  'local enrollment is not used by Cloudflare Access',
);

test('enrolls the configured local administrator', async ({ page }) => {
  await enrollLocalAdministrator(page);
});
