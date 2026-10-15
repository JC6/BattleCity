import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Leave CPU capacity for the software pixel fixtures and their isolated workers.
    maxWorkers: 2,
    include: ['tests/core/**/*.test.ts', 'tests/platform/**/*.test.ts', 'tests/data/**/*.test.ts', 'tests/game/**/*.test.ts'],
  },
});
