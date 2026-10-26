import { defineConfig } from 'vitest/config';

// POS_TEST_DB : nom de la base de test, pour que plusieurs campagnes tournent
// en même temps sur le même PostgreSQL sans se détruire l'une l'autre.
const BASE_TEST = process.env.POS_TEST_DB ?? 'pos_samer_test';
// POS_TEST_PORT : un PostgreSQL de test À PART (ex. 5433), à l'abri de la caisse
// qui arrête le sien en se fermant.
const PORT_TEST = process.env.POS_TEST_PORT ?? '5432';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: `postgres://postgres@localhost:${PORT_TEST}/${BASE_TEST}`,
    },
    globalSetup: './test/setup-global.ts',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
