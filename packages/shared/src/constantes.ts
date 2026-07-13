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
] as const;
export type ModePaiement = (typeof MODES_PAIEMENT)[number];

export const LIBELLES_MODES: Record<ModePaiement, string> = {
  ESPECES: 'Espèces',
  WAVE: 'Wave',
  ORANGE_MONEY: 'Orange Money',
  MTN_MOMO: 'MTN MoMo',
  MOOV_MONEY: 'Moov Money',
  CARTE: 'Carte',
};

export const TYPES_COMMANDE = ['SUR_PLACE', 'EMPORTER', 'LIVRAISON'] as const;
export type TypeCommande = (typeof TYPES_COMMANDE)[number];

export const LIBELLES_TYPES_COMMANDE: Record<TypeCommande, string> = {
  SUR_PLACE: 'Sur place',
  EMPORTER: 'À emporter',
  LIVRAISON: 'Livraison',
};

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

export const PARTENAIRES = ['YANGO', 'GLOVO', 'SAMER_DELIV'] as const;
export type Partenaire = (typeof PARTENAIRES)[number];

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
  'COMMANDE_CLIENT_A_VALIDER',
  'EN_PREPARATION',
  'PRETE',
  'SERVIE',
  'ADDITION_DEMANDEE',
] as const;
export type EtatTable = (typeof ETATS_TABLE)[number];

export const LIBELLES_ETAT_TABLE: Record<EtatTable, string> = {
  LIBRE: 'Libre',
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
