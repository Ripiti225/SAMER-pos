/**
 * Applique les migrations drizzle/ sur la base locale.
 * Crée la base si elle n'existe pas encore (premier démarrage du mini-PC).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import '../env.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/pos_samer';
const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://localhost:5432/postgres';

export async function creerBaseSiAbsente(urlBase: string = DATABASE_URL): Promise<void> {
  const nomBase = new URL(urlBase).pathname.slice(1);
  const admin = new pg.Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const existe = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nomBase]);
    if (existe.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${nomBase}"`);
      console.log(`Base « ${nomBase} » créée.`);
    }
  } finally {
    await admin.end();
  }
}

export async function appliquerMigrations(urlBase: string = DATABASE_URL): Promise<void> {
  const dossierMigrations = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../drizzle',
  );
  const pool = new pg.Pool({ connectionString: urlBase, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: dossierMigrations });
  } finally {
    await pool.end();
  }
}

const lanceEnScript = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (lanceEnScript) {
  await creerBaseSiAbsente();
  await appliquerMigrations();
  console.log('Migrations appliquées ✔');
}
