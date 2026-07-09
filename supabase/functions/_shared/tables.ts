// Colonnes autorisées par table (anti-injection) — montée (ventes) et
// descente (catalogue). Toute colonne absente du payload est ignorée.

export const COLONNES_VENTES: Record<string, string[]> = {
  commandes: [
    'id', 'numero_ticket', 'type', 'table_id', 'partenaire', 'ref_partenaire',
    'service_id', 'caissier_id', 'serveur_id', 'statut', 'origine', 'refus_motif',
    'sous_total', 'remise_montant', 'remise_par', 'remise_motif', 'promo_id',
    'promo_montant', 'total', 'created_at', 'updated_at',
  ],
  commande_items: [
    'id', 'commande_id', 'article_id', 'combo_id', 'nom_snapshot', 'prix_unitaire',
    'quantite', 'options', 'supplements', 'statut_cuisine', 'envoye_le', 'attribue_a',
    'annule_par', 'annule_motif',
  ],
  notes_split: ['id', 'commande_id', 'libelle', 'montant'],
  paiements: ['id', 'commande_id', 'note_id', 'mode', 'montant', 'encaisse_par', 'service_id', 'created_at'],
  services_caisse: [
    'id', 'caissier_id', 'fond_de_caisse', 'ouvert_le', 'cloture_le', 'statut',
    'especes_comptees', 'especes_theorique', 'ecart', 'rapport_z',
  ],
  audit_log: ['id', 'seq', 'user_id', 'action', 'entite', 'entite_id', 'montant', 'motif', 'meta', 'created_at'],
  // Sprint 4 : présences + fidélité remontent aussi (SamerTrackly).
  pointages: ['id', 'user_id', 'methode', 'arrivee', 'depart', 'depart_oublie'],
  clients_fidelite: ['id', 'telephone', 'nom', 'created_at'],
  points_fidelite: ['id', 'client_id', 'commande_id', 'points', 'source', 'created_at'],
};

/** Flux de descente (cloud → local) et leurs tables. */
export const FLUX_DESCENTE: Record<string, string[]> = {
  CATALOGUE: [
    'categories', 'articles', 'prix_canaux', 'groupes_options', 'options',
    'supplements', 'combos', 'combo_articles',
  ],
  PROMOTIONS: ['promotions'],
  UTILISATEURS: ['utilisateurs'],
  // Sprint 4C : barème fidélité (2.5) — édité au siège, redescend comme le catalogue.
  PARAMETRES: ['parametres_locaux'],
};

/**
 * Édition d'administration (sprint 4C, 2.4/2.5) : entité éditable → table cloud
 * + colonnes autorisées (anti-injection). L'écriture bump la version (trigger).
 */
export const CATALOGUE_ADMIN: Record<string, { table: string; colonnes: string[] }> = {
  categorie: { table: 'categories', colonnes: ['id', 'parent_id', 'nom', 'ordre', 'actif'] },
  article: { table: 'articles', colonnes: ['id', 'categorie_id', 'nom', 'description', 'prix_base', 'image_url', 'actif', 'updated_at'] },
  prix_canal: { table: 'prix_canaux', colonnes: ['id', 'article_id', 'canal', 'prix'] },
  groupe_option: { table: 'groupes_options', colonnes: ['id', 'article_id', 'nom', 'choix_min', 'choix_max'] },
  option: { table: 'options', colonnes: ['id', 'groupe_id', 'nom'] },
  supplement: { table: 'supplements', colonnes: ['id', 'article_id', 'nom', 'prix'] },
  combo: { table: 'combos', colonnes: ['id', 'nom', 'prix', 'actif'] },
  combo_article: { table: 'combo_articles', colonnes: ['id', 'combo_id', 'article_id', 'quantite'] },
  promotion: { table: 'promotions', colonnes: ['id', 'nom', 'type', 'valeur', 'heure_debut', 'heure_fin', 'jours', 'article_id', 'actif'] },
  bareme_fidelite: { table: 'parametres_locaux', colonnes: ['cle', 'valeur'] },
};

/** Filtre un payload aux seules colonnes autorisées + restaurant_id + id. */
export function ligneAutorisee(
  table: string,
  payload: Record<string, unknown>,
  recordId: string,
  restaurantId: string,
): Record<string, unknown> | null {
  const colonnes = COLONNES_VENTES[table];
  if (!colonnes) return null;
  const ligne: Record<string, unknown> = { id: recordId, restaurant_id: restaurantId };
  for (const col of colonnes) {
    if (col === 'id') continue;
    if (col in payload) ligne[col] = payload[col];
  }
  return ligne;
}
