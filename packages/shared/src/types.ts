import type { ModePaiement, Partenaire, Role, StatutCommande, TypeCommande } from './constantes.js';

/** Vues API (réponses JSON) partagées entre le serveur et la PWA caisse. */

export interface UtilisateurPublic {
  id: string;
  nom_complet: string;
  role: Role | null;
  role_nom?: string;
  role_id?: string | null;
  photo_url?: string | null;
  /** true si l'employé doit encore poser son PIN via un code temporaire. */
  doit_definir_pin?: boolean;
}

export interface SessionInfo {
  utilisateur: {
    id: string;
    nom_complet: string;
    /** Nom du rôle (compat : ex-champ `role`). Vide si non résolu. */
    role: string;
    role_id: string | null;
    role_nom: string;
    est_proprietaire: boolean;
    est_superviseur: boolean;
  };
  /** Sprint 4B+4C : permissions effectives de l'utilisateur (guards UI). */
  permissions: string[];
  restaurant: {
    code: string;
    nom: string;
    marque: 'SAMER' | 'AL_KAYAN';
    couleur_hex: string;
    /** Contact + message sous le logo de la facture (param ticket_entete). */
    entete?: string;
    /** Message de pied de facture (param ticket_pied). */
    pied?: string;
  };
  verrouillage_inactivite_secondes: number;
  /** Sprint 2 : verrouillage plus long pour l'app serveur tablette (§B5). */
  verrouillage_inactivite_serveur_secondes: number;
  service_ouvert: ServiceOuvertVue | null;
  /** Shift clôturé non encore « remis » : le caissier doit terminer (ticket). */
  cloture_en_attente?: RapportZ | null;
}

/**
 * Caisse occupée par le shift d'un AUTRE employé. Sert à expliquer le blocage
 * (un seul shift ouvert à la fois) sans révéler le moindre montant.
 */
export interface OccupationCaisse {
  occupee: boolean;
  caissier: string | null;
  ouvert_le: string | null;
}

/** Vue du service en cours — ne contient JAMAIS le théorique (§14.3). */
export interface ServiceOuvertVue {
  id: string;
  fond_de_caisse: number;
  ouvert_le: string;
  statut: 'OUVERT' | 'CLOTURE';
}

export interface CategorieVue {
  id: string;
  nom: string;
  ordre: number;
  /**
   * Catégorie réservée à des partenaires de livraison (migration 0023).
   * `null` = catégorie normale, visible partout. Sinon elle n'apparaît que sur
   * une commande dont le partenaire figure dans la liste.
   */
  partenaires: string[] | null;
}

export interface OptionVue {
  id: string;
  nom: string;
}

export interface GroupeOptionsVue {
  id: string;
  nom: string;
  choix_min: number;
  choix_max: number;
  options: OptionVue[];
}

export interface SupplementVue {
  id: string;
  nom: string;
  prix: number;
}

export interface ArticleVue {
  id: string;
  categorie_id: string;
  nom: string;
  description: string | null;
  prix_base: number;
  image_url: string | null;
  disponible: boolean;
  prix_canaux: Record<string, number>;
  /**
   * Extras proposés pour cet article : options de sa CATÉGORIE + les siennes
   * (migration 0020). Remplace les anciens `groupes_options` (choix gratuits
   * groupés) et `supplements` (extras payants), tous deux liés à un seul
   * article. `prix: 0` = option gratuite.
   */
  options_extras: OptionExtraVue[];
}

/** Option proposée à la vente. Le prix est porté par l'option elle-même. */
export interface OptionExtraVue {
  id: string;
  nom: string;
  prix: number;
}

export interface ComboVue {
  id: string;
  nom: string;
  prix: number;
  disponible: boolean;
  articles: { article_id: string; nom: string; quantite: number }[];
}

export interface PromotionVue {
  id: string;
  nom: string;
  type: 'POURCENTAGE' | 'MONTANT';
  valeur: number;
  heure_debut: string | null;
  heure_fin: string | null;
  jours: number[];
  article_id: string | null;
  active_maintenant: boolean;
}

export interface CatalogueVue {
  categories: CategorieVue[];
  articles: ArticleVue[];
  combos: ComboVue[];
  promotions: PromotionVue[];
}

/** Commande en cours listée sur une table (choix rapide au plan de salle). */
export interface CommandeOuverteVue {
  id: string;
  code_commande: string | null;
  numero_ticket: number;
  statut: StatutCommande;
  total: number;
  offert: boolean;
  created_at: string;
}

export interface TableVue {
  id: string;
  zone_id: string;
  zone_nom: string;
  numero: string;
  partenaire: string | null;
  statut: 'LIBRE' | 'OCCUPEE' | 'ADDITION_DEMANDEE';
  commande_id: string | null;
  /**
   * TOUTES les commandes en cours sur la table, pas seulement la première.
   * Indispensable sur les tables virtuelles (Yango, Glovo, Samer Delly, Kdo)
   * où plusieurs commandes coexistent pendant un rush : le plan de salle les
   * liste pour qu'on entre dans la bonne et y ajoute des produits.
   */
  commandes_ouvertes: CommandeOuverteVue[];
  // CORRECTIONS3 point 4 : état dérivé côté serveur, identique partout
  etat: import('./constantes.js').EtatTable;
  badges: import('./constantes.js').BadgeTable[];
  // CORRECTIONS3 point 3 : propriété de table
  ouverte_par: string | null;
  ouverte_par_nom: string | null;
}

/** Appel client reçu par un serveur/la caisse (point 1). */
export interface AppelVue {
  id: string;
  table_id: string;
  table_numero: string;
  zone_nom: string;
  type: import('./constantes.js').TypeAppel;
  cible: import('./constantes.js').CibleRoutage;
  serveur_id: string | null;
  cree_le: string;
}

/** Suivi d'une commande côté client (point 1c). */
export interface SuiviCommandeClient {
  id: string;
  numero_ticket: number;
  etat: import('./constantes.js').EtatSuiviClient;
  origine: import('./constantes.js').OrigineCommande;
  refus_motif: string | null;
  total: number;
  articles: { nom: string; quantite: number }[];
}

/** Vue publique d'une table pour la page client (portée à SA table). */
export interface TableClientVue {
  table_id: string;
  numero: string;
  zone_nom: string;
  restaurant: { nom: string; marque: 'SAMER' | 'AL_KAYAN'; couleur_hex: string };
  etat: import('./constantes.js').EtatTable;
}

export interface CommandeItemVue {
  id: string;
  article_id: string | null;
  combo_id: string | null;
  nom_snapshot: string;
  prix_unitaire: number;
  quantite: number;
  options: { groupe: string; choix: string[] }[];
  supplements: { nom: string; prix: number }[];
  statut_cuisine: 'A_PREPARER' | 'EN_COURS' | 'PRET' | 'ANNULE';
  /** Sprint 2 : true = déjà parti en cuisine (annulation = action protégée). */
  envoye: boolean;
  total_ligne: number;
}

export interface PaiementVue {
  id: string;
  mode: ModePaiement;
  montant: number;
  note_id: string | null;
  created_at: string;
}

export interface NoteSplitVue {
  id: string;
  libelle: string;
  montant: number;
  paye: number;
  reste: number;
}

export interface CommandeVue {
  id: string;
  numero_ticket: number;
  /** Code court affiché/imprimé (ex. « SP215 ») ; le numéro reste l'audit. */
  code_commande: string | null;
  type: TypeCommande;
  table_id: string | null;
  table_numero: string | null;
  partenaire: Partenaire | string | null;
  ref_partenaire: string | null;
  statut: StatutCommande;
  /** Kdo : repas offert, clôturé sans encaissement. Motif obligatoire. */
  offert: boolean;
  motif_offert: string | null;
  sous_total: number;
  remise_montant: number;
  remise_motif: string | null;
  promo_montant: number;
  promo_nom: string | null;
  fidelite_montant: number;
  client_fidelite_id: string | null;
  total: number;
  paye: number;
  reste: number;
  items: CommandeItemVue[];
  paiements: PaiementVue[];
  notes: NoteSplitVue[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Sprint 2 — KDS
// ---------------------------------------------------------------------------

/** Aucune donnée de caisse sur le KDS (correction 3) : pas de prix ici. */
export interface CarteKdsItem {
  id: string;
  nom_snapshot: string;
  quantite: number;
  options: { groupe: string; choix: string[] }[];
  supplements: { nom: string }[];
  statut_cuisine: 'A_PREPARER' | 'EN_COURS' | 'PRET' | 'ANNULE';
}

export interface CarteKds {
  id: string;
  numero_ticket: number;
  code_commande: string | null;
  type: TypeCommande;
  partenaire: string | null;
  table_numero: string | null;
  statut: StatutCommande;
  /** Heure du premier envoi en cuisine (base du chronomètre). */
  envoyee_le: string;
  /** Heure de passage de la commande (création côté caisse/serveur). */
  heure_commande: string;
  items: CarteKdsItem[];
}

export interface KdsVue {
  /** Marque pour le thème — le KDS n'a pas de session utilisateur. */
  marque: 'SAMER' | 'AL_KAYAN';
  couleur_hex: string;
  seuils: { orange_minutes: number; rouge_minutes: number };
  en_cuisine: CarteKds[];
  pretes: CarteKds[];
}

export interface RapportZ {
  service_id: string;
  caissier: string;
  ouvert_le: string;
  cloture_le: string;
  fond_de_caisse: number;
  especes_comptees: number;
  especes_theorique: number;
  ecart: number;
  nb_commandes_payees: number;
  nb_commandes_annulees: number;
  total_ventes: number;
  total_remises: number;
  total_promos: number;
  total_fidelite: number;
  panier_moyen: number;
  par_mode: Record<ModePaiement, number>;
  par_type: Record<TypeCommande, { nb: number; total: number }>;
  partenaires: Record<string, { nb: number; total: number }>;
  top_articles: { nom: string; quantite: number; total: number }[];
  remises_detail: { numero_ticket: number; montant: number; motif: string | null; par_nom: string | null }[];
  annulations_detail: { numero_ticket: number; total: number }[];
  // Réconciliation de fermeture (déclarés par le caissier + calculés).
  depenses: number;
  livraisons: Record<string, number>;
  /**
   * Kdo : valeur des repas offerts du shift. Comptée dans `vente_totale` au
   * même titre qu'une livraison Yango, jamais dans les espèces attendues.
   */
  offerts: { nb: number; total: number };
  modes_declares: Record<string, number>;
  vente_totale: number;
  total_systeme: number;
  diff: number;
  /**
   * Bloc Inventaire du ticket Z (DESIGN_V2 § 6.10) : conforme, ou nombre de
   * produits manquants et montant. INFORMATION MANAGER — le montant n'entre
   * ni dans la vente, ni dans l'écart de caisse, et n'est jamais une retenue.
   * `debloque` = clôture passée sans comptage complet, sur PIN manager.
   */
  inventaire: {
    valide: boolean;
    debloque: boolean;
    manquants: number;
    surplus: number;
    montant_manquant: number;
  };
  /**
   * Décompte de l'équipe du jour (§ 6.8) : toute personne non marquée « Reste »
   * est enregistrée comme PARTIE à la clôture.
   */
  equipe: { presents: number; restent: number; partis: number };
  /**
   * RETOURS : plats **déjà lancés en cuisine** qui ne seront pas vendus, parce
   * qu'un manager a supprimé la ligne — ou la commande entière (PIN + motif
   * obligatoires dans les deux cas). Compter les deux est un point de contrôle :
   * sinon, encaisser puis supprimer la table entière effacerait toute trace.
   *
   * INFORMATION PURE, comme le bloc Inventaire : un retour n'entre ni dans la
   * vente, ni dans le tiroir, ni dans les sorties d'inventaire — il en est
   * exclu par construction, puisque la ligne est annulée. Il est ici pour qu'on
   * le VOIE : c'est le seul chiffre qui dit si un restaurant refait souvent ses
   * plats. Un article corrigé AVANT l'envoi en cuisine n'est pas un retour.
   */
  retours: RetoursVue;
}

/** Bloc Retours — agrégé par produit pour le ticket, détaillé pour l'écran. */
export interface RetoursVue {
  /** Nombre d'articles retournés (somme des quantités). */
  nb: number;
  /** Valeur au prix figé de la ligne, en FCFA. */
  montant: number;
  par_produit: { nom: string; quantite: number; montant: number }[];
  detail: {
    numero_ticket: number;
    nom: string;
    quantite: number;
    montant: number;
    motif: string | null;
    par_nom: string | null;
  }[];
}

/**
 * Valeurs auto pour le formulaire de fermeture — SANS l'écart ni le total
 * système ni les espèces (comptage aveugle préservé). Le caissier confirme/
 * édite les modes électroniques et les livraisons.
 */
export interface ReconciliationPreview {
  fond_de_caisse: number;
  livraisons: Record<string, number>;
  /** Repas offerts (Kdo) du shift : affichés pour information, non encaissables. */
  offerts: { nb: number; total: number };
  modes: Record<ModePaiement, number>;
  /**
   * Dépenses du service (DESIGN_V2 § 6.8) : SOMME du registre, en LECTURE
   * SEULE à la clôture. La caissière ne retape rien — un total saisi à la main
   * pouvait diverger des lignes qui le composent.
   */
  depenses: { total: number; nb_lignes: number };
  /** Verrou de clôture (§ 6.10) : l'UI le reflète, le serveur l'applique. */
  inventaire: { valide: boolean; debloque: boolean; restants_a_compter: number };
  /**
   * Retours du service — articles déjà partis en cuisine puis supprimés au PIN
   * manager. En LECTURE SEULE comme les dépenses : rien à saisir, et aucune
   * incidence sur la vente, le tiroir ou l'inventaire.
   */
  retours: RetoursVue;
}

/** Détail d'un shift dans une séquence (vue gérant). */
export interface ShiftSequence {
  service_id: string;
  caissier: string;
  ouvert_le: string;
  cloture_le: string | null;
  statut: 'OUVERT' | 'CLOTURE';
  fond_de_caisse: number;
  especes_comptees: number | null;
  ecart: number | null;
  vente_totale: number | null;
  total_systeme: number | null;
  depenses: number;
  livraisons: Record<string, number>;
  /** Kdo du shift. Absent des shifts clôturés avant les Kdo → { nb: 0, total: 0 }. */
  offerts: { nb: number; total: number };
  modes_declares: Record<string, number>;
}

/** Séquence courante (ouverte) avec le détail par caissier. */
export interface SequenceCourante {
  id: string;
  ouverte_le: string;
  shifts: ShiftSequence[];
  nb_shifts_ouverts: number;
  totaux: RecapSequence;
}

/** Récap agrégé d'une séquence. */
export interface RecapSequence {
  vente_totale: number;
  total_systeme: number;
  diff: number;
  especes_comptees: number;
  depenses: number;
  ecart_especes: number;
  livraisons: Record<string, number>;
  /** Total des repas offerts (Kdo) de la séquence : compté en vente, jamais en espèces. */
  offerts: { nb: number; total: number };
  modes: Record<string, number>;
}

/** Rapport figé d'une séquence clôturée. */
export interface RapportSequence extends RecapSequence {
  sequence_id: string;
  ouverte_le: string;
  cloturee_le: string;
  cloturee_par: string;
  nb_shifts: number;
  shifts: ShiftSequence[];
}
