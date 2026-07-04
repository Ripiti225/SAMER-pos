/** Crée la base de test et applique les migrations avant la campagne Vitest. */
import pg from 'pg';
import { appliquerMigrations, creerBaseSiAbsente } from '../src/db/migrate.js';

const URL_TEST = 'postgres://localhost:5432/pos_samer_test';
const ADMIN = process.env.ADMIN_DATABASE_URL ?? 'postgres://localhost:5432/postgres';

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS pos_samer_test WITH (FORCE)');
  } finally {
    await admin.end();
  }
  process.env.ADMIN_DATABASE_URL = ADMIN;
  await creerBaseSiAbsente(URL_TEST);
  await appliquerMigrations(URL_TEST);
}
