import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@flanterminal/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
