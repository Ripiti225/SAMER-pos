import type { ModePaiement, Partenaire, Role, StatutCommande, TypeCommande } from './constantes.js';

/** Vues API (réponses JSON) partagées entre le serveur et la PWA caisse. */

export interface UtilisateurPublic {
  id: string;
  nom_complet: string;
  role: Role | null;
  role_nom?: string;
  role_id?: string | null;
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
  restaurant: { code: string; nom: string; marque: 'SAMER' | 'AL_KAYAN'; couleur_hex: string };
  verrouillage_inactivite_secondes: number;
  /** Sprint 2 : verrouillage plus long pour l'app serveur tablette (§B5). */
  verrouillage_inactivite_serveur_secondes: number;
  service_ouvert: ServiceOuvertVue | null;
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
  groupes_options: GroupeOptionsVue[];
  supplements: SupplementVue[];
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

export interface TableVue {
  id: string;
  zone_id: string;
  zone_nom: string;
  numero: string;
  partenaire: string | null;
  statut: 'LIBRE' | 'OCCUPEE' | 'ADDITION_DEMANDEE';
  commande_id: string | null;
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
  type: TypeCommande;
  table_id: string | null;
  table_numero: string | null;
  partenaire: Partenaire | string | null;
  ref_partenaire: string | null;
  statut: StatutCommande;
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
}
