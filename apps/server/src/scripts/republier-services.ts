/**
 * Republie les SERVICES CLÔTURÉS vers le cloud : `pnpm services:republier`.
 *
 * Pourquoi ce script existe. Le 2026-08-28, `explication_ecart` et `remis_le`
 * ont été ajoutés à la liste blanche de `sync-push` (`_shared/tables.ts`), mais
 * la fonction n'a été redéployée que le 2026-09-04. Entre les deux, le site
 * envoyait bien l'explication de la caissière : le cloud la JETAIT en silence,
 * `ligneAutorisee()` ne recopiant que les colonnes de la liste. Résultat, les
 * écarts remontaient dans SamerTrackly sans leur explication, et le rattrapage
 * automatique du pont (`samtrackly-points`) n'avait rien à rattraper — il ne
 * peut envoyer que ce qui existe dans `services_caisse` côté cloud.
 *
 * Une ligne d'outbox déjà acquittée ne repart jamais toute seule. Ce script
 * remet donc dans l'outbox les services clôturés QUI PORTENT UNE EXPLICATION,
 * pour qu'elle refasse le trajet. Le pont, lui, se charge du reste sans qu'on
 * lui demande : il compare le texte reçu à celui déjà transféré et ne rejoue
 * que les services réellement modifiés.
 *
 * Ne modifie RIEN en local : il n'écrit que dans `sync_outbox`, que le moteur
 * de synchro videra à son prochain cycle de montée (30 s par défaut).
 *
 * Rejouable sans risque : `sync-push` écrit côté cloud en UPSERT sur
 * (restaurant_id, id). Le relancer deux fois republie les mêmes lignes, il n'en
 * crée pas de doubles.
 *
 * Usage :
 *   pnpm services:republier                    # depuis le 2026-08-28
 *   pnpm services:republier --depuis=2026-08-01
 */
import { and, gte, isNotNull, eq } from 'drizzle-orm';

import { db, fermerDb } from '../db/client.js';
import { servicesCaisse } from '../db/schema/index.js';
import { ecrireOutbox } from '../db/outbox.js';

/** Jour où la caisse a commencé à demander une explication d'écart. */
const DEPUIS_DEFAUT = '2026-08-28';

function jourDemande(): string {
  const arg = process.argv.find((a) => a.startsWith('--depuis='));
  const valeur = arg?.slice('--depuis='.length) ?? DEPUIS_DEFAUT;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valeur)) {
    throw new Error(`--depuis attend une date AAAA-MM-JJ, reçu « ${valeur} »`);
  }
  return valeur;
}

async function main(): Promise<void> {
  const depuis = jourDemande();

  const lignes = await db
    .select()
    .from(servicesCaisse)
    .where(
      and(
        eq(servicesCaisse.statut, 'CLOTURE'),
        isNotNull(servicesCaisse.explication_ecart),
        gte(servicesCaisse.cloture_le, new Date(`${depuis}T00:00:00Z`)),
      ),
    );

  if (lignes.length === 0) {
    console.log(
      `Aucun service clôturé depuis le ${depuis} ne porte d'explication d'écart —\n` +
        'rien à republier.',
    );
    return;
  }

  await db.transaction(async (tx) => {
    for (const s of lignes) {
      // Exactement les colonnes de la liste blanche `services_caisse` de
      // `_shared/tables.ts`. Une colonne de plus serait ignorée par le cloud ;
      // une de moins effacerait la valeur déjà montée.
      await ecrireOutbox(tx, 'services_caisse', 'UPDATE', s.id, {
        id: s.id,
        caissier_id: s.caissier_id,
        sequence_id: s.sequence_id,
        fond_de_caisse: s.fond_de_caisse,
        ouvert_le: s.ouvert_le,
        cloture_le: s.cloture_le,
        remis_le: s.remis_le,
        statut: s.statut,
        especes_comptees: s.especes_comptees,
        especes_theorique: s.especes_theorique,
        ecart: s.ecart,
        explication_ecart: s.explication_ecart,
        rapport_z: s.rapport_z,
      });
    }
  });

  console.log(
    `${lignes.length} service(s) clôturé(s) depuis le ${depuis} remis dans l'outbox.\n` +
      'Ils monteront au prochain cycle de synchro (30 s par défaut) ; le pont\n' +
      'SamerTrackly les reprendra dans les 5 minutes qui suivent, et les\n' +
      'explications apparaîtront sous les écarts dans Vérification et Litiges.',
  );
  for (const s of lignes) {
    const jour = s.cloture_le?.toISOString().slice(0, 10) ?? '?';
    console.log(`  · ${jour} — écart ${s.ecart ?? 0} F — « ${s.explication_ecart} »`);
  }
}

main()
  .catch((e: unknown) => {
    console.error('Republication impossible :', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void fermerDb());
