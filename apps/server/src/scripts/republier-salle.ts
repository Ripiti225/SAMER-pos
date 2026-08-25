/**
 * Republie le PLAN DE SALLE vers le cloud : `pnpm salle:republier`.
 *
 * Même raison d'être que `republier-roles.ts` : la montée repose sur
 * `sync_outbox`, qui n'enregistre que les CHANGEMENTS. Or les zones et les
 * tables naissent au seed ou à l'installation, avant l'enrôlement, et ne
 * bougent presque jamais ensuite — elles ne monteraient donc jamais.
 *
 * Sans elles, le cloud reçoit `commandes.table_id` : un uuid qu'il ne sait
 * traduire avec rien. Le tableau de bord du siège affiche alors « Table
 * a3f1-… » au lieu de « Table 4 — Terrasse », ou plus vraisemblablement rien
 * du tout.
 *
 * Ne modifie RIEN en local : n'écrit que dans l'outbox, que le moteur videra à
 * son prochain cycle de montée (30 s par défaut). Rejouable — `sync-push` écrit
 * côté cloud en UPSERT sur (restaurant_id, id).
 *
 * NB : le `statut` d'une table ne monte pas, volontairement (voir la liste
 * blanche `supabase/functions/_shared/tables.ts`). Ce script n'en publie donc
 * pas non plus : ce qui compte au siège, c'est le NUMÉRO et la ZONE.
 */
import { db, fermerDb } from '../db/client.js';
import { tablesSalle, zones } from '../db/schema/index.js';
import { ecrireOutbox } from '../db/outbox.js';

async function main(): Promise<void> {
  const lignesZones = await db.select().from(zones);
  const lignesTables = await db.select().from(tablesSalle);

  if (lignesZones.length === 0 && lignesTables.length === 0) {
    console.log('Aucune zone ni table en base — rien à republier.');
    return;
  }

  await db.transaction(async (tx) => {
    // Les zones d'abord : une table référence sa zone, autant que le siège les
    // reçoive dans cet ordre (le cloud n'a pas de clé étrangère, mais une
    // descente de lot partielle laisserait des tables sans zone lisible).
    for (const z of lignesZones) {
      await ecrireOutbox(tx, 'zones', 'UPDATE', z.id, {
        id: z.id,
        nom: z.nom,
        couleur: z.couleur,
        ordre: z.ordre,
      });
    }
    for (const t of lignesTables) {
      await ecrireOutbox(tx, 'tables_salle', 'UPDATE', t.id, {
        id: t.id,
        zone_id: t.zone_id,
        numero: t.numero,
        partenaire: t.partenaire,
        actif: t.actif,
      });
    }
  });

  console.log(
    `${lignesZones.length} zone(s) et ${lignesTables.length} table(s) remises dans l'outbox.\n` +
      'Elles monteront au prochain cycle de synchro (30 s par défaut), puis le\n' +
      'tableau de bord du siège pourra nommer les tables au lieu d’afficher un uuid.',
  );
  const parZone = new Map(lignesZones.map((z) => [z.id, z.nom]));
  for (const z of lignesZones) {
    const n = lignesTables.filter((t) => t.zone_id === z.id).length;
    console.log(`  · ${z.nom} — ${n} table(s)`);
  }
  const orphelines = lignesTables.filter((t) => !parZone.has(t.zone_id)).length;
  if (orphelines > 0) console.log(`  · ${orphelines} table(s) sans zone connue`);
}

main()
  .catch((e: unknown) => {
    console.error('Republication impossible :', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void fermerDb());
