import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * Two projects, one per writing direction. RTL is not a variant to be checked
 * once before release - it is half the product's users, and a layout that
 * breaks in Hebrew should fail a build the same way a broken English layout
 * would.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'ltr', use: { ...devices['Desktop Chrome'], locale: 'en-US' } },
    { name: 'rtl', use: { ...devices['Desktop Chrome'], locale: 'he-IL' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/en/sign-in',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
