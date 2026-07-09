// Edge Function admin-catalogue — ÉCRITURE d'administration (sprint 4C, 2.4/2.5).
// Le siège/manager édite le catalogue et le barème fidélité ICI (source cloud).
// Authentifiée par la clé de site. Chaque écriture bump la version (trigger) ;
// les modifications redescendent par la synchro normale (< 5 min).
import { clientAdmin, ErreurAuth, json, verifierCleSite } from '../_shared/auth.ts';
import { CATALOGUE_ADMIN } from '../_shared/tables.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  const admin = clientAdmin();

  let restaurantId: string;
  let op: string;
  let entite: string;
  let valeurs: Record<string, unknown>;
  try {
    const corps = await req.json();
    restaurantId = await verifierCleSite(admin, corps.cle_site);
    op = String(corps.op ?? 'upsert');
    entite = String(corps.entite ?? '');
    valeurs = (corps.valeurs ?? {}) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ErreurAuth) return json({ erreur: e.message }, 401);
    return json({ erreur: 'Requête invalide' }, 400);
  }

  const def = CATALOGUE_ADMIN[entite];
  if (!def) return json({ erreur: `Entité inconnue : ${entite}` }, 400);

  // Filtre aux seules colonnes autorisées + restaurant_id.
  const ligne: Record<string, unknown> = { restaurant_id: restaurantId };
  for (const col of def.colonnes) {
    if (col in valeurs) ligne[col] = valeurs[col];
  }
  // Clé de conflit : cle pour le barème, id sinon.
  const cleConflit = def.table === 'parametres_locaux' ? 'restaurant_id,cle' : 'id';
  if (def.table === 'parametres_locaux' && !ligne.cle) {
    return json({ erreur: 'Clé de paramètre manquante' }, 400);
  }
  if (def.table !== 'parametres_locaux' && !ligne.id) {
    return json({ erreur: 'Identifiant manquant' }, 400);
  }

  if (op === 'supprimer') {
    // Suppression logique : on marque actif = false quand la colonne existe.
    if (!def.colonnes.includes('actif')) return json({ erreur: 'Suppression non permise pour cette entité' }, 400);
    const { error } = await admin.from(def.table).update({ actif: false }).eq('restaurant_id', restaurantId).eq('id', ligne.id);
    if (error) return json({ erreur: 'Écriture impossible' }, 500);
  } else {
    const { error } = await admin.from(def.table).upsert(ligne, { onConflict: cleConflit });
    if (error) return json({ erreur: 'Écriture impossible' }, 500);
  }

  return json({ ok: true });
});
