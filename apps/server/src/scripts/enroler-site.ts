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

  // Garde-fou anti-mélange : tant que le poste n'a pas pris son identité, il
  // porte encore celle de l'image de déploiement (même UUID sur les 7 sites).
  // L'enrôler ici ferait remonter ses ventes sous l'identité d'un autre site.
  const [confId] = await db
    .select()
    .from(parametresLocaux)
    .where(eq(parametresLocaux.cle, 'samtrackly_restaurant_id'));
  if (resto.code === 'A_CONFIGURER' || typeof confId?.valeur !== 'string' || !confId.valeur) {
    console.error(
      'Ce poste n’a pas encore d’identité propre.\n' +
        'Faites d’abord : caisse → Réglages → Restaurant → choisir le restaurant → Configurer,\n' +
        'puis relancez `pnpm site:enroler`.',
    );
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
      `ON CONFLICT (restaurant_id) DO UPDATE SET cle_hash = EXCLUDED.cle_hash, actif = TRUE\n` +
      `  WHERE sites_autorises.code = EXCLUDED.code;`,
  );

  // Annuaire de la console siège : c'est le SEUL moment où l'on connaît en même
  // temps l'UUID POS du site et son identifiant SamerTrackly. `parametres_locaux`
  // ne remonte jamais au cloud (table de descente), donc sans cet INSERT rien ne
  // relie les ventes du site au restaurant de la RH — la console afficherait un
  // UUID anonyme au lieu de « Samer Angré 7E ».
  console.log('\nPuis, pour que la console siège reconnaisse ce site :\n');
  console.log(
    `INSERT INTO restaurants (restaurant_id, code, nom, marque, couleur_hex, samtrackly_id)\n` +
      `VALUES ('${resto.id}', '${resto.code}', '${resto.nom.replace(/'/g, "''")}',\n` +
      `        '${resto.marque}', '${resto.couleur_hex}', '${confId.valeur}')\n` +
      `ON CONFLICT (restaurant_id) DO UPDATE SET\n` +
      `  code = EXCLUDED.code, nom = EXCLUDED.nom, marque = EXCLUDED.marque,\n` +
      `  couleur_hex = EXCLUDED.couleur_hex, samtrackly_id = EXCLUDED.samtrackly_id,\n` +
      `  actif = TRUE, updated_at = now();`,
  );
  console.log(
    '\n(Le WHERE final est un garde-fou : si Supabase répond « UPDATE 0 », cet\n' +
      ' identifiant appartient DÉJÀ à un autre restaurant — ne forcez pas, les\n' +
      ' deux sites partageraient leurs ventes. Reconfigurez le poste dans\n' +
      ' Réglages → Restaurant pour lui donner un identifiant neuf.)',
  );
  console.log('\nPour RÉVOQUER ce site (vol de matériel) :');
  console.log(`  UPDATE sites_autorises SET actif = FALSE WHERE restaurant_id = '${resto.id}';`);
  console.log('============================================================\n');

  await fermerDb();
}

await main();
