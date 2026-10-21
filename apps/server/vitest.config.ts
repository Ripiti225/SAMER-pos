import { defineConfig } from 'vitest/config';

// POS_TEST_DB : nom de la base de test, pour que plusieurs campagnes tournent
// en même temps sur le même PostgreSQL sans se détruire l'une l'autre.
const BASE_TEST = process.env.POS_TEST_DB ?? 'pos_samer_test';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: `postgres://postgres@localhost:5432/${BASE_TEST}`,
    },
    globalSetup: './test/setup-global.ts',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
