import { defineConfig } from 'drizzle-kit';

/**
 * sql/schema.sql (racine du repo) est la SOURCE DE VÉRITÉ.
 * La migration initiale drizzle/0000_init.sql en est la copie exacte ;
 * ce config sert à drizzle-kit pour les migrations futures.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/pos_samer',
  },
});
