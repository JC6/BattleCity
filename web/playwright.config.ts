import { defineConfig, devices } from '@playwright/test';

const production = process.env.BATTLECITY_PRODUCTION === '1';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: production ? ['**/smoke.spec.ts', '**/audio-real.spec.ts'] : '**/*.spec.ts',
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Each game needs foreground animation and focus; simultaneous browser
  // windows make fixed-tick intro timing depend on headless throttling.
  workers: 1,
  outputDir: production ? 'test-results/production' : 'test-results/e2e',
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: production ? 'playwright-report/production' : 'playwright-report/e2e' }],
      ['json', { outputFile: production ? 'test-results/production.json' : 'test-results/e2e.json' }]]
    : [['list'], ['json', { outputFile: production ? 'test-results/production.json' : 'test-results/e2e.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173/',
    trace: { mode: 'retain-on-failure', screenshots: false, snapshots: false, sources: true },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Software-rendered WebKit includes page setup and serial keyboard RPCs.
    { name: 'webkit', timeout: 60000, use: { ...devices['Desktop Safari'] } },
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
