/** Constantes partagées serveur / PWA — libellés en français, montants en FCFA. */

export const ROLES = ['PROPRIETAIRE', 'MANAGER', 'CAISSIER', 'SERVEUR', 'CUISINE'] as const;
export type Role = (typeof ROLES)[number];

/** Disponibilité RH d'un employé (Réglages › Équipe). */
export const DISPONIBILITES = ['PRESENT', 'MALADE', 'CONGE', 'PERMISSION'] as const;
export type Disponibilite = (typeof DISPONIBILITES)[number];

export const LIBELLES_DISPONIBILITE: Record<Disponibilite, string> = {
  PRESENT: 'Présent',
  MALADE: 'Malade',
  CONGE: 'En congé',
  PERMISSION: 'Permissionnaire',
};

export const MODES_PAIEMENT = [
  'ESPECES',
  'WAVE',
  'ORANGE_MONEY',
  'MTN_MOMO',
  'MOOV_MONEY',
  'CARTE',
  'DJAMO',
] as const;
export type ModePaiement = (typeof MODES_PAIEMENT)[number];

export const LIBELLES_MODES: Record<ModePaiement, string> = {
  ESPECES: 'Espèces',
  WAVE: 'Wave',
  ORANGE_MONEY: 'Orange Money',
  MTN_MOMO: 'MTN MoMo',
  MOOV_MONEY: 'Moov Money',
  CARTE: 'Carte',
  DJAMO: 'Djamo',
};

export const TYPES_COMMANDE = ['SUR_PLACE', 'EMPORTER', 'LIVRAISON'] as const;
export type TypeCommande = (typeof TYPES_COMMANDE)[number];

export const LIBELLES_TYPES_COMMANDE: Record<TypeCommande, string> = {
  SUR_PLACE: 'Sur place',
  EMPORTER: 'À emporter',
  LIVRAISON: 'Livraison',
};

/**
 * Postes d'impression (routage des tickets). Chaque poste est relié à UNE
 * imprimante configurée localement dans Réglages › Imprimante. Le reçu, la
 * facture et le rapport Z sortent toujours à la CAISSE ; un article part sur
 * l'imprimante de son poste (bon de préparation) à l'envoi en cuisine.
 */
export const POSTES_IMPRESSION = ['CAISSE', 'CUISINE', 'BAR'] as const;
export type PosteImpression = (typeof POSTES_IMPRESSION)[number];

export const LIBELLES_POSTE_IMPRESSION: Record<PosteImpression, string> = {
  CAISSE: 'Caisse',
  CUISINE: 'Cuisine',
  BAR: 'Bar',
};

/** Poste de repli si aucun routage n'est défini (sécurité : ne rien perdre en cuisine). */
export const POSTE_IMPRESSION_DEFAUT: PosteImpression = 'CUISINE';

/** Clé du paramètre local (parametres_locaux) portant l'imprimante d'un poste. */
export function clePosteImprimante(poste: PosteImpression): string {
  return `imprimante_poste_${poste.toLowerCase()}`;
}

/** Préfixe du code court de commande (SP215) selon le type de commande. */
export const PREFIXE_CODE_TYPE: Record<TypeCommande, string> = {
  SUR_PLACE: 'SP',
  EMPORTER: 'EM',
  LIVRAISON: 'LV',
};

/**
 * Routage d'impression PAR DÉFAUT, par nom de catégorie (catalogue de marque,
 * commun aux restaurants). Appliqué au seed et à l'import catalogue, SANS écraser
 * un choix déjà fait dans Réglages › Routage impression (modifiable à volonté).
 * Clé = nom normalisé (minuscule, sans accents) via `normaliserNomCategorie`.
 */
export const ROUTAGE_CATEGORIE_DEFAUT: Record<string, PosteImpression> = {
  salades: 'CUISINE',
  sandwiches: 'CUISINE',
  tacos: 'CUISINE',
  assiettes: 'CUISINE',
  'poulet & poisson': 'CUISINE',
  accompagnements: 'CUISINE',
  manaiches: 'CUISINE',
  pizzas: 'CUISINE',
  aperitifs: 'CUISINE',
  chawarmas: 'CAISSE',
  'jus naturels': 'CAISSE',
  boissons: 'CAISSE',
  crepes: 'CAISSE',
  desserts: 'CAISSE',
};

/** Normalise un nom de catégorie pour le matching du routage par défaut. */
export function normaliserNomCategorie(nom: string): string {
  return nom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Poste par défaut d'une catégorie selon son nom (null si non répertoriée). */
export function posteDefautCategorie(nom: string): PosteImpression | null {
  return ROUTAGE_CATEGORIE_DEFAUT[normaliserNomCategorie(nom)] ?? null;
}

export const STATUTS_COMMANDE = [
  'OUVERTE',
  'ENVOYEE_CUISINE',
  'PRETE',
  'SERVIE',
  'PAYEE',
  'ANNULEE',
] as const;
export type StatutCommande = (typeof STATUTS_COMMANDE)[number];

/** Libellés en français courant, jamais de code technique à l'écran (§15). */
export const LIBELLES_STATUTS_COMMANDE: Record<StatutCommande, string> = {
  OUVERTE: 'Ouverte',
  ENVOYEE_CUISINE: 'En cuisine',
  PRETE: 'Prête',
  SERVIE: 'Servie',
  PAYEE: 'Payée',
  ANNULEE: 'Annulée',
};

export const PARTENAIRES = ['YANGO', 'GLOVO', 'SAMER_DELLY'] as const;
export type Partenaire = (typeof PARTENAIRES)[number];

/**
 * Libellés affichés. `SAMER_DELIV` est l'ANCIEN code, renommé en `SAMER_DELLY`
 * par la migration 0019 : il ne peut plus apparaître dans les tables, mais il
 * survit dans les rapports Z et de séquence DÉJÀ FIGÉS (JSONB immuables, on ne
 * réécrit pas une archive). D'où son maintien ici, en lecture seule.
 */
export const LIBELLES_PARTENAIRES: Record<string, string> = {
  YANGO: 'Yango',
  GLOVO: 'Glovo',
  SAMER_DELLY: 'Samer Delly',
  SAMER_DELIV: 'Samer Delly',
};

/** Libellé d'un partenaire, y compris pour un code archivé. */
export function libellePartenaire(code: string): string {
  return LIBELLES_PARTENAIRES[code] ?? code.replace(/_/g, ' ');
}

/**
 * Partenaires de livraison EXTERNES : le client règle chez le partenaire
 * (Yango/Glovo), jamais en caisse. Une telle commande se clôture SANS
 * encaissement et son montant est compté à part (bucket « livraisons » du
 * rapport Z), hors du théorique espèces. Samer Delly (livraison propre du
 * restaurant) encaisse normalement au comptoir → il n'est PAS dans cette liste.
 */
export const PARTENAIRES_EXTERNES: readonly Partenaire[] = ['YANGO', 'GLOVO'];

/** Vrai si la commande est une livraison réglée hors caisse (Yango/Glovo). */
export function estLivraisonSansEncaissement(partenaire: string | null | undefined): boolean {
  return partenaire != null && (PARTENAIRES_EXTERNES as readonly string[]).includes(partenaire);
}

/**
 * Table virtuelle du Kdo (repas offert). Elle vit en zone **RC** et non en
 * « Livraison » : le cadeau se consomme sur place. La commande qui en part est
 * marquée `offert` par le SERVEUR (jamais sur la foi du client) et se clôture
 * PAYEE sans aucune ligne de paiement : elle compte dans la vente du shift,
 * comme une livraison Yango, mais n'ajoute pas un franc au tiroir.
 */
export const TABLE_KDO = 'KDO';
export const LIBELLE_KDO = 'Kdo (offert)';

/** Vrai si cette table virtuelle est la table des repas offerts. */
export function estTableKdo(partenaire: string | null | undefined): boolean {
  return partenaire === TABLE_KDO;
}

/**
 * Postes prédéfinis pour l'« équipe du jour » (remplace le pointage) : à
 * l'ouverture de service, on coche les présents et on ajuste leur poste du jour.
 */
export const POSTES_JOUR = [
  'CAISSIER',
  'SERVEUR',
  'BARMAN',
  'COMPTOIRISTE',
  'CUISINIER',
  'PIZZAIOLO',
  'GRILLADE',
  'PLONGE',
  'MANAGER',
] as const;
export type PosteJour = (typeof POSTES_JOUR)[number];

export const LIBELLES_POSTES: Record<PosteJour, string> = {
  CAISSIER: 'Caissier',
  SERVEUR: 'Serveur',
  BARMAN: 'Barman',
  COMPTOIRISTE: 'Comptoiriste',
  CUISINIER: 'Cuisinier',
  PIZZAIOLO: 'Pizzaïolo',
  GRILLADE: 'Grillade',
  PLONGE: 'Plonge',
  MANAGER: 'Manager',
};

// ---------------------------------------------------------------------------
// CORRECTIONS3 — circuit client ↔ serveur
// ---------------------------------------------------------------------------

export const TYPES_APPEL = ['APPEL_SERVEUR', 'DEMANDE_FACTURE'] as const;
export type TypeAppel = (typeof TYPES_APPEL)[number];

export const LIBELLES_APPEL: Record<TypeAppel, string> = {
  APPEL_SERVEUR: 'Appel serveur',
  DEMANDE_FACTURE: 'Facture demandée',
};

export const ORIGINES_COMMANDE = ['CAISSE', 'SERVEUR', 'CLIENT_QR'] as const;
export type OrigineCommande = (typeof ORIGINES_COMMANDE)[number];

/** Étapes de suivi montrées au client (dérivées côté serveur). */
export const ETATS_SUIVI_CLIENT = [
  'EN_VALIDATION',
  'EN_PREPARATION',
  'PRETE',
  'SERVIE',
  'REFUSEE',
  'PAYEE',
] as const;
export type EtatSuiviClient = (typeof ETATS_SUIVI_CLIENT)[number];

export const LIBELLES_SUIVI_CLIENT: Record<EtatSuiviClient, string> = {
  EN_VALIDATION: 'En validation',
  EN_PREPARATION: 'En préparation',
  PRETE: 'Prête',
  SERVIE: 'Servie',
  REFUSEE: 'Refusée',
  PAYEE: 'Réglée',
};

/**
 * État de table DÉRIVÉ (point 4), calculé côté serveur, identique partout
 * (caisse, serveur, client). Distinct du statut physique en base.
 */
export const ETATS_TABLE = [
  'LIBRE',
  'OCCUPEE',
  'COMMANDE_CLIENT_A_VALIDER',
  'EN_PREPARATION',
  'PRETE',
  'SERVIE',
  'ADDITION_DEMANDEE',
] as const;
export type EtatTable = (typeof ETATS_TABLE)[number];

export const LIBELLES_ETAT_TABLE: Record<EtatTable, string> = {
  LIBRE: 'Libre',
  OCCUPEE: 'Occupée',
  COMMANDE_CLIENT_A_VALIDER: 'Commande client à valider',
  EN_PREPARATION: 'En préparation',
  PRETE: 'Prête',
  SERVIE: 'En cours de repas',
  ADDITION_DEMANDEE: 'Facture demandée',
};

export type BadgeTable = 'APPEL' | 'FACTURE' | 'PRETE';

/** Cible de routage d'un appel/commande client (point 1b). */
export type CibleRoutage = 'SERVEUR' | 'CAISSE';

/** PIN interdits (§14.1) : 1234, 123456, et toutes les répétitions 0000…9999. */
export const PINS_INTERDITS: readonly string[] = [
  '1234',
  '123456',
  ...Array.from({ length: 10 }, (_, i) => `${i}${i}${i}${i}`),
];

/** Formate un montant FCFA entier : 25000 → « 25 000 F ». */
export function formatFCFA(montant: number): string {
  return `${montant.toLocaleString('fr-FR').replace(/ | /g, ' ')} F`;
}
