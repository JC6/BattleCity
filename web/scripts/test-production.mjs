import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, BATTLECITY_PRODUCTION: '1' },
});
process.exit(result.status ?? 1);
