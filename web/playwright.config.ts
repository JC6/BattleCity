import { defineConfig, devices } from '@playwright/test';

const production = process.env.BATTLECITY_PRODUCTION === '1';
const kind = production ? 'production' : 'e2e';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: production ? '**/smoke.spec.ts' : '**/*.spec.ts',
  testIgnore: production ? [] : ['**/smoke.spec.ts'],
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Each game needs foreground animation and focus; simultaneous browser
  // windows make fixed-tick intro timing depend on headless throttling.
  workers: 1,
  metadata: { build: kind },
  outputDir: `test-results/${kind}`,
  reporter: [
    [process.env.CI ? 'github' : 'list'],
    ['html', { open: 'never', outputFolder: `playwright-report/${kind}` }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    trace: { mode: 'retain-on-failure', screenshots: false, snapshots: false, sources: true },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // WebKit gates the production keyboard, canvas and basic audio smoke suite.
    ...(production ? [{ name: 'webkit', timeout: 60000, use: { ...devices['Desktop Safari'] } }] : []),
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
