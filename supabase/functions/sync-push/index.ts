// Edge Function sync-push — MONTÉE des ventes (local → cloud).
// Fiabilité : UPSERT idempotent par id → rejouer le même lot 10 fois donne
// exactement le même résultat (zéro doublon). Acquittement contigu par seq :
// on n'acquitte que jusqu'au dernier seq appliqué sans trou.
import { clientAdmin, ErreurAuth, json, verifierCleSite } from '../_shared/auth.ts';
import { cibleMontee, ligneAutorisee } from '../_shared/tables.ts';

interface LignePush {
  seq: number;
  table_name: string;
  record_id: string;
  operation: 'INSERT' | 'UPDATE';
  payload: Record<string, unknown>;
}

/**
 * Trace un blocage dans `sync_rejets` — une seule ligne par (site, seq, raison),
 * sinon un site qui réessaie toutes les 30 s remplirait la table.
 *
 * Contrairement au garage d'une table inconnue, la ligne N'EST PAS acquittée :
 * elle sera rejouée. On ne trace ici que pour rendre la panne VISIBLE au siège.
 */
async function tracerBlocage(
  // deno-lint-ignore no-explicit-any
  admin: any,
  restaurantId: string,
  l: LignePush,
  raison: string,
): Promise<void> {
  const { data } = await admin
    .from('sync_rejets')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('seq', l.seq)
    .eq('raison', raison)
    .limit(1);
  if (data && data.length > 0) return;
  await admin.from('sync_rejets').insert({
    restaurant_id: restaurantId,
    seq: l.seq,
    table_name: l.table_name,
    record_id: l.record_id,
    operation: l.operation,
    payload: l.payload ?? {},
    raison,
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  const admin = clientAdmin();

  let restaurantId: string;
  let lignes: LignePush[];
  try {
    const corps = await req.json();
    restaurantId = await verifierCleSite(admin, corps.cle_site);
    lignes = Array.isArray(corps.lignes) ? corps.lignes : [];
  } catch (e) {
    if (e instanceof ErreurAuth) return json({ erreur: e.message }, 401);
    return json({ erreur: 'Requête invalide' }, 400);
  }

  // Ordre strict par seq (le local envoie déjà trié, on re-trie par sécurité)
  lignes.sort((a, b) => a.seq - b.seq);

  let acquitteJusqua = 0;
  // Ce qui a arrêté le lot, renvoyé au site. Sans ça, un refus ressemblait à
  // un simple « rien à acquitter » : le POS n'avait AUCUN moyen de savoir que
  // le cloud le refusait, ni pourquoi (panne du 2026-08-17).
  let blocage: { seq: number; table_name: string; raison: string } | undefined;
  for (const l of lignes) {
    const ligne = ligneAutorisee(l.table_name, l.payload ?? {}, l.record_id, restaurantId);
    if (!ligne) {
      // Table inconnue : on la GARE et on continue. S'arrêter ici gelait le
      // site pour toujours — la file locale est strictement ordonnée, donc
      // toutes les ventes derrière cette ligne ne remontaient plus jamais.
      // Un POS plus récent que le cloud ne doit pas pouvoir arrêter un
      // restaurant. La donnée n'est pas perdue : elle est dans `sync_rejets`,
      // en JSONB, rejouable une fois la table créée ici.
      const { error: erreurRejet } = await admin.from('sync_rejets').insert({
        restaurant_id: restaurantId,
        seq: l.seq,
        table_name: l.table_name,
        record_id: l.record_id,
        operation: l.operation,
        payload: l.payload ?? {},
        raison: 'table inconnue de sync-push',
      });
      // Si même le rebut échoue (table absente sur un cloud pas à jour), on
      // revient à l'ancien comportement : bloquer plutôt que perdre.
      if (erreurRejet) {
        blocage = {
          seq: l.seq,
          table_name: l.table_name,
          raison: `table inconnue, et le rebut a échoué : ${erreurRejet.message}`,
        };
        break;
      }
      acquitteJusqua = l.seq;
      continue;
    }
    // Clé composite : un site ne peut jamais réécrire la ligne d'un autre,
    // même si les deux portent le même UUID (image de déploiement clonée).
    // `cibleMontee` : la fiche employé envoyée par un site atterrit dans
    // `utilisateurs_site`, jamais dans la table du siège, qui en est maître.
    const cible = cibleMontee(l.table_name);
    const { error } = await admin.from(cible).upsert(ligne, { onConflict: 'restaurant_id,id' });
    if (error) {
      // Acquittement contigu : on ne dépasse pas la 1re erreur — la ligne sera
      // rejouée, rien n'est perdu. Mais on ne l'AVALE plus : trace au siège et
      // raison renvoyée au site, qui peut enfin l'afficher au restaurateur.
      const raison = `upsert ${cible} : ${error.message}`;
      blocage = { seq: l.seq, table_name: l.table_name, raison };
      await tracerBlocage(admin, restaurantId, l, raison);
      break;
    }
    acquitteJusqua = l.seq;
  }

  if (acquitteJusqua > 0) {
    await admin.from('sync_journal').insert({
      restaurant_id: restaurantId,
      type: 'PUSH',
      nb_lignes: lignes.filter((l) => l.seq <= acquitteJusqua).length,
      dernier_seq: acquitteJusqua,
    });
  }

  return json({ acquitte_jusqua_seq: acquitteJusqua, blocage });
});
