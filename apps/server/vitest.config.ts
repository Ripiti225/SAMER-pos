import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgres://localhost:5432/pos_samer_test',
    },
    globalSetup: './test/setup-global.ts',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
