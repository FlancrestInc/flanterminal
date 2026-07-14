import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: '/tmp/flanterminal-test-results',
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: '/tmp/flanterminal-report' }],
  ],
  timeout: 60_000,
  workers: 1,
  projects: [
    {
      name: 'first-run-auth',
      testMatch: /first-run-auth\.setup\.ts/u,
    },
    {
      name: 'workflows',
      testIgnore: /first-run-auth\.setup\.ts/u,
      dependencies: ['first-run-auth'],
    },
  ],
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://app:3000/',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
