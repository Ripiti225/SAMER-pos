import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/pos_samer';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

export const db = drizzle(pool, { schema });

export type Db = typeof db;
/** Type accepté partout où une transaction OU la connexion racine convient. */
export type DbOuTx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

export async function fermerDb(): Promise<void> {
  await pool.end();
}
