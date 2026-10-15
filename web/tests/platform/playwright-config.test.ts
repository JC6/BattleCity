import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// These tests exercise our path selection, not Playwright's runner startup.
vi.mock('@playwright/test', () => ({
  defineConfig: (config: unknown) => config,
  devices: { 'Desktop Chrome': {}, 'Desktop Safari': {} },
}));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function configuration(production: boolean, archive?: string, ci = false) {
  vi.stubEnv('BATTLECITY_PRODUCTION', production ? '1' : '');
  vi.stubEnv('BATTLECITY_ACCEPTANCE_DIR', archive ?? '');
  vi.stubEnv('CI', ci ? '1' : '');
  vi.resetModules();
  return (await import('../../playwright.config')).default;
}

describe('Playwright report destinations', () => {
  it.each([false, true])('preserves standalone destinations (production=%s)', async production => {
    const kind = production ? 'production' : 'e2e';
    const config = await configuration(production, undefined, true);
    expect(config.outputDir).toBe(`test-results/${kind}`);
    expect(config.reporter).toEqual([
      ['github'], ['html', { open: 'never', outputFolder: `playwright-report/${kind}` }],
      ['json', { outputFile: `test-results/${kind}.json` }],
    ]);
  });

  it.each([false, true])('isolates JSON, attachments and HTML per run (production=%s)', async production => {
    const kind = production ? 'production' : 'e2e';
    for (const run of ['first', 'second']) {
      const root = path.join(os.tmpdir(), 'battlecity-config-test', run);
      const config = await configuration(production, root, true);
      expect(config.outputDir).toBe(path.join(root, kind, 'results'));
      expect(config.reporter).toEqual([
        ['github'], ['html', { open: 'never', outputFolder: path.join(root, kind, 'html') }],
        ['json', { outputFile: path.join(root, kind, `${kind}.json`) }],
      ]);
      expect(config.workers).toBe(1); expect(config.retries).toBe(0);
      expect(config.projects?.map(project => project.name)).toEqual(['chromium', 'webkit']);
    }
  });

  it('archives local acceptance JSON without enabling the CI reporters', async () => {
    const root = path.join(os.tmpdir(), 'battlecity-config-test', 'local');
    const config = await configuration(false, root);
    expect(config.reporter).toEqual([
      ['list'], ['json', { outputFile: path.join(root, 'e2e', 'e2e.json') }],
    ]);
  });
});
