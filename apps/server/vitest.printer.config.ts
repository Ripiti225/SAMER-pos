import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests sans base de données ni impression physique.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { include: ['test/imprimante-son-cuisine.test.ts'] },
});
