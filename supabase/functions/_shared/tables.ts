// Colonnes autorisées par table (anti-injection) — montée (ventes) et
// descente (catalogue). Toute colonne absente du payload est ignorée.

export const COLONNES_VENTES: Record<string, string[]> = {
  commandes: [
    'id', 'numero_ticket', 'type', 'table_id', 'partenaire', 'ref_partenaire',
    'service_id', 'caissier_id', 'serveur_id', 'statut', 'origine', 'refus_motif',
    'sous_total', 'remise_montant', 'remise_par', 'remise_motif', 'promo_id',
    'promo_montant', 'total', 'created_at', 'updated_at',
    // 2026-08-25 — les Kdo étaient comptés dans `total` sans être
    // identifiables : ils gonflaient le CA du siège en silence.
    'offert', 'motif_offert',
    // 2026-08-25 — contact du client livré, saisi au lancement en cuisine.
    // Sans lui, le siège ne peut pas voir quel caissier laisse partir des
    // courses partenaires sans aucun moyen de rappeler le client.
    'contact_client',
  ],
  commande_items: [
    'id', 'commande_id', 'article_id', 'combo_id', 'nom_snapshot', 'prix_unitaire',
    'quantite', 'options', 'supplements', 'statut_cuisine', 'envoye_le', 'attribue_a',
    'annule_par', 'annule_motif',
  ],
  notes_split: [
    'id', 'commande_id', 'numero', 'libelle', 'type', 'statut', 'sous_total',
    'promo_montant', 'remise_montant', 'fidelite_montant', 'client_fidelite_id',
    'fidelite_points', 'montant', 'service_id', 'payee_par', 'created_at', 'payee_le',
  ],
  note_split_items: ['id', 'note_id', 'commande_item_id', 'quantite', 'montant_brut'],
  paiements: ['id', 'commande_id', 'note_id', 'mode', 'montant', 'encaisse_par', 'service_id', 'created_at'],
  services_caisse: [
    'id', 'caissier_id', 'fond_de_caisse', 'ouvert_le', 'cloture_le', 'statut',
    'especes_comptees', 'especes_theorique', 'ecart', 'explication_ecart', 'remis_le', 'rapport_z',
    // 2026-08-25 — sans lui, rien ne relie un shift à sa séquence côté cloud :
    // la console du siège ne pourrait pas montrer ce qu'elle s'apprête à raser.
    'sequence_id',
  ],
  audit_log: ['id', 'seq', 'user_id', 'action', 'entite', 'entite_id', 'montant', 'motif', 'meta', 'created_at'],
  // Sprint 4 : présences + fidélité remontent aussi (SamerTrackly).
  pointages: ['id', 'user_id', 'methode', 'arrivee', 'depart', 'depart_oublie'],
  clients_fidelite: ['id', 'telephone', 'nom', 'created_at'],
  points_fidelite: ['id', 'client_id', 'commande_id', 'note_id', 'points', 'source', 'created_at'],

  // ---------------------------------------------------------------------------
  // 2026-08-16 — tables que le POS publiait DÉJÀ sans qu'elles soient ici.
  // Une table absente de cette liste fait `break` dans sync-push : le seq n'est
  // jamais acquitté et TOUT ce qui suit reste bloqué pour ce site. Comme
  // `equipe_service` est écrite à chaque ouverture de service, le premier site
  // enrôlé aurait gelé sa synchro dès son premier shift, ventes comprises.
  // ---------------------------------------------------------------------------
  equipe_service: ['id', 'service_id', 'utilisateur_id', 'poste_jour', 'pointe_le', 'reste', 'created_at'],
  sequences_caisse: ['id', 'ouverte_le', 'cloturee_le', 'cloturee_par', 'statut', 'rapport'],
  roles: ['id', 'nom', 'systeme', 'actif', 'created_at', 'updated_at'],
  // Le POS envoie la LISTE ENTIÈRE des permissions du rôle, `record_id` = role_id.
  role_permissions: ['id', 'role_id', 'permissions'],
  disponibilite_locale: ['id', 'article_id', 'disponible'],
  // 2026-08-25 — référentiel de salle, pour traduire `commandes.table_id`.
  // `statut`, `qr_token` et `ouverte_par` sont volontairement absents : le
  // statut change toutes les minutes, et le jeton QR est un secret du site.
  zones: ['id', 'nom', 'couleur', 'ordre'],
  tables_salle: ['id', 'zone_id', 'numero', 'partenaire', 'actif'],
  options_catalogue: ['id', 'nom', 'prix', 'actif', 'ordre', 'updated_at'],
  options_liaisons: ['id', 'option_id', 'categorie_id', 'article_id'],
  // `utilisateurs` : le POS publie la fiche employé quand elle change sur site.
  // Elle N'ATTERRIT PAS dans la table `utilisateurs` du siège — voir
  // REDIRECTION_MONTEE juste dessous. Les colonnes sont listées ici pour être
  // filtrées comme les autres (le PIN et ses dérivés ne sortent jamais du site).
  utilisateurs: [
    'id', 'nom_complet', 'role', 'role_id', 'poste_cuisine', 'poste', 'photo_url',
    'externe_id', 'telephone', 'disponibilite', 'taux_journalier', 'actif',
  ],

  // ---------------------------------------------------------------------------
  // 2026-08-16 — ce que le caissier saisit doit arriver ici sans ressaisie.
  // Le rapport Z figé (`services_caisse.rapport_z`) porte déjà le résumé ;
  // ces trois tables apportent le DÉTAIL : quelle dépense, quel produit,
  // combien manquait.
  // ---------------------------------------------------------------------------
  // `supprime` : l'outbox n'a pas d'opération DELETE. Une ligne effacée sur le
  // site est republiée avec ce marqueur — sinon elle resterait au siège et
  // gonflerait les charges du restaurant. À exclure des totaux SamerTrackly.
  depenses: [
    'id', 'service_id', 'categorie', 'libelle', 'montant', 'agent_id',
    'saisi_par', 'auto', 'motif', 'created_at', 'supprime',
  ],
  inventaires_service: [
    'id', 'service_id', 'valide', 'valide_le', 'valide_par',
    'debloque_par', 'debloque_le', 'debloque_motif', 'montant_manquant', 'created_at',
  ],
  // `produit_*` (2026-08-21) : le snapshot produit figé par le site. Sans lui,
  // le cloud reçoit un uuid local qu'il ne sait traduire avec rien — chaque
  // mini-PC sème son catalogue avec ses propres uuid. Voir la migration
  // 0026_inventaire_snapshot_produit.sql.
  inventaire_lignes: [
    'id', 'inventaire_id', 'produit_id', 'stock_initial', 'entrees', 'sorties',
    'stock_compte', 'ecart', 'quantite_expliquee', 'explication',
    'produit_code', 'produit_nom', 'produit_prix',
  ],
  entrees_stock: [
    'id', 'inventaire_id', 'produit_id', 'quantite', 'fournisseur', 'saisi_par',
    'created_at', 'supprime', 'produit_code', 'produit_nom',
  ],
};

/**
 * MONTÉE REDIRIGÉE — quand la table qui reçoit n'est pas celle qui est envoyée.
 *
 * `utilisateurs` : **SamerTrackly est maître de la fiche employé** (décision du
 * boss, 2026-08-16). C'est déjà l'organisation réelle — embauche, rôle, taux et
 * départ se décident au siège, et la caisse a un bouton « Synchroniser
 * (SamerTrackly) » qui descend l'équipe. Sans cette redirection, siège et site
 * écrivaient la MÊME ligne et le dernier écrasait l'autre en silence : le
 * gérant corrige un téléphone à 14 h, la descente le remet à l'ancien à 14 h 05.
 *
 * Ce que le site envoie atterrit donc dans `utilisateurs_site` : le siège y voit
 * ce que le restaurant a modifié — et surtout les employés **créés sur place**
 * (`externe_id` NULL), qui autrement n'existeraient nulle part chez lui — sans
 * qu'une seule de ces lignes ne touche sa propre table.
 */
export const REDIRECTION_MONTEE: Record<string, string> = {
  utilisateurs: 'utilisateurs_site',
};

/** Table cloud qui reçoit réellement une montée. */
export function cibleMontee(table: string): string {
  return REDIRECTION_MONTEE[table] ?? table;
}

/** Flux de descente (cloud → local) et leurs tables. */
export const FLUX_DESCENTE: Record<string, string[]> = {
  CATALOGUE: [
    'categories', 'articles', 'prix_canaux', 'groupes_options', 'options',
    'supplements', 'combos', 'combo_articles',
    // 2026-08-17 — un plat et sa recette d'inventaire voyagent ENSEMBLE.
    // Sans ces deux tables, le siège pouvait diffuser un plat sur les 7 sites
    // sans sa recette : l'inventaire ignorait ce que le plat consomme, et
    // l'écart de fin de service devenait faux partout.
    'produits_inventaire', 'inventaire_consommations',
  ],
  PROMOTIONS: ['promotions'],
  // 2026-08-25 — le siège change les accès d'un rôle sur plusieurs restaurants
  // d'un coup. SEULE `role_permissions` descend : la table `roles` porte un
  // `nom` UNIQUE côté site, et y pousser une ligne d'un autre uuid ferait
  // échouer toute la descente, catalogue compris.
  ROLES: ['role_permissions'],
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
  // Inventaire (2026-08-17). `prix` est identique dans tous les restaurants —
  // décision du boss : il ne sert qu'à chiffrer un manquant non expliqué, le
  // siège le fixe et les sites l'appliquent, contrairement au prix de vente.
  produit_inventaire: {
    table: 'produits_inventaire',
    colonnes: ['id', 'code', 'categorie', 'nom', 'prix', 'unite', 'role', 'ratio', 'ordre', 'actif'],
  },
  recette_inventaire: {
    table: 'inventaire_consommations',
    colonnes: ['id', 'produit_id', 'article_id', 'quantite'],
  },
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
