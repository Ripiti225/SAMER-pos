// Edge Function sync-push — MONTÉE des ventes (local → cloud).
// Fiabilité : UPSERT idempotent par id → rejouer le même lot 10 fois donne
// exactement le même résultat (zéro doublon). Acquittement contigu par seq :
// on n'acquitte que jusqu'au dernier seq appliqué sans trou.
import { clientAdmin, ErreurAuth, json, verifierCleSite } from '../_shared/auth.ts';
import { ligneAutorisee } from '../_shared/tables.ts';

interface LignePush {
  seq: number;
  table_name: string;
  record_id: string;
  operation: 'INSERT' | 'UPDATE';
  payload: Record<string, unknown>;
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
  for (const l of lignes) {
    const ligne = ligneAutorisee(l.table_name, l.payload ?? {}, l.record_id, restaurantId);
    if (!ligne) {
      // Table inconnue : on s'arrête pour ne pas acquitter à tort la suite.
      break;
    }
    const { error } = await admin.from(l.table_name).upsert(ligne, { onConflict: 'id' });
    if (error) break; // acquittement contigu : on ne dépasse pas la 1re erreur
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

  return json({ acquitte_jusqua_seq: acquitteJusqua });
});
