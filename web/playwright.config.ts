import { defineConfig, devices } from '@playwright/test';

const production = process.env.BATTLECITY_PRODUCTION === '1';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: production ? '**/smoke.spec.ts' : '**/*.spec.ts',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Each game needs foreground animation and focus; simultaneous browser
  // windows make fixed-tick intro timing depend on headless throttling.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: production
      ? 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort'
      : 'npm run bundle -- --mode test && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
