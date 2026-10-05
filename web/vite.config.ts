import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'battlecity-license-notices',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'LICENSE.txt', source: readFileSync(new URL('../LICENSE', import.meta.url)) });
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md', source: readFileSync(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url)) });
    },
  }],
  base: '/',
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: { manualChunks: id => id.includes('/node_modules/phaser/') ? 'phaser' : undefined },
    },
  },
});
