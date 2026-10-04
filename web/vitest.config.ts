import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/core/**/*.test.ts', 'tests/platform/**/*.test.ts', 'tests/data/**/*.test.ts'],
  },
});
