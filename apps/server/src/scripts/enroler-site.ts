/**
 * Enrôlement d'un site (§ config sprint 3) : `pnpm site:enroler`.
 * Génère la clé de site, la stocke en local (parametres_locaux.cle_site) et
 * affiche le SQL à exécuter côté cloud pour l'enregistrer dans sites_autorises.
 * La clé n'est JAMAIS envoyée en clair au cloud : seul son sha256 y est stocké.
 */
import { randomBytes, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, fermerDb } from '../db/client.js';
import { parametresLocaux, restaurant } from '../db/schema/index.js';

function sha256Hex(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

async function poserParam(cle: string, valeur: unknown): Promise<void> {
  await db
    .insert(parametresLocaux)
    .values({ cle, valeur: valeur as never })
    .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: valeur as never, updated_at: new Date() } });
}

async function main(): Promise<void> {
  const [resto] = await db.select().from(restaurant).limit(1);
  if (!resto) {
    console.error('Aucun restaurant en base. Lancez d’abord `pnpm db:seed`.');
    process.exit(1);
  }

  // Réutilise la clé existante si déjà enrôlé (idempotent), sinon en génère une.
  const [existant] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, 'cle_site'));
  const cleSite = typeof existant?.valeur === 'string' ? existant.valeur : randomBytes(32).toString('hex');
  const hash = sha256Hex(cleSite);

  await poserParam('cle_site', cleSite);
  const urlEnv = process.env.SUPABASE_SYNC_URL;
  if (urlEnv) await poserParam('supabase_sync_url', urlEnv);

  console.log('\n===================  ENRÔLEMENT DU SITE  ===================');
  console.log(`Restaurant  : ${resto.nom} (${resto.code})`);
  console.log(`restaurant_id : ${resto.id}`);
  console.log('\nClé de site (gardée en local, ne pas partager) :');
  console.log(`  ${cleSite}`);
  console.log('\nÀ EXÉCUTER dans l’éditeur SQL Supabase (enregistre le site) :\n');
  console.log(
    `INSERT INTO sites_autorises (restaurant_id, code, cle_hash, actif)\n` +
      `VALUES ('${resto.id}', '${resto.code}', '${hash}', TRUE)\n` +
      `ON CONFLICT (restaurant_id) DO UPDATE SET cle_hash = EXCLUDED.cle_hash, actif = TRUE;`,
  );
  console.log('\nPour RÉVOQUER ce site (vol de matériel) :');
  console.log(`  UPDATE sites_autorises SET actif = FALSE WHERE restaurant_id = '${resto.id}';`);
  console.log('============================================================\n');

  await fermerDb();
}

await main();
