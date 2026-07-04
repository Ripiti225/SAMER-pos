/** Constantes partagées serveur / PWA — libellés en français, montants en FCFA. */

export const ROLES = ['PROPRIETAIRE', 'MANAGER', 'CAISSIER', 'SERVEUR', 'CUISINE'] as const;
export type Role = (typeof ROLES)[number];

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

export const PARTENAIRES = ['YANGO', 'GLOVO', 'SAMER_DELIV'] as const;
export type Partenaire = (typeof PARTENAIRES)[number];

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
