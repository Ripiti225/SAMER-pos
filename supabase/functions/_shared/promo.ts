// Codes promo « cartes colis » — règles pures de la fonction `promo`
// (brief ~/BRIEF_CODES_PROMO_CARTES.md, § 3 et § 4).
//
// Rien ici ne touche la base : la fonction lit les lignes, ces règles
// décident, puis la fonction écrit sous condition (UPDATE … WHERE statut = …)
// pour que deux appels simultanés ne puissent pas gagner tous les deux.
// Abidjan est à UTC+0 toute l'année : une date du jour est une date UTC.

/** Alphabet des 5 caractères tirés : ni 0/O, ni 1/I/L, confondus à la saisie. */
export const ALPHABET_CODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const FORMAT_CODE = /^[A-HJKM-Z]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

/** Durée d'une réservation faite par le site (R9). */
export const RESERVATION_SITE_MS = 2 * 3600 * 1000;

/** Limite d'essais du site : 10 codes faux dans l'heure, puis 1 h de blocage. */
export const ESSAIS_MAX = 10;
export const FENETRE_ESSAIS_MS = 3600 * 1000;

/** Bornes d'un lot (contraintes de `promo_lots`). */
export const QUANTITE_MAX = 2000;
export const DUREE_PAR_DEFAUT_JOURS = 28;
const DUREE_MAX_JOURS = 366;

export type Motif =
  | 'INVALID'
  | 'ALREADY_USED'
  | 'EXPIRED'
  | 'NOT_STARTED'
  | 'WRONG_BRANCH'
  | 'NO_ELIGIBLE_ITEM'
  | 'ALREADY_CLAIMED'
  | 'NO_ACTIVE_CODE'
  | 'RATE_LIMITED'
  | 'CONSENT_REQUIRED'
  | 'INVALID_PHONE';

/** Ce que le site affiche au client : tutoiement, comme l'autocollant. */
export const MESSAGES: Record<Motif, string> = {
  INVALID: 'Ce code n’existe pas. Vérifie-le sur ton autocollant.',
  ALREADY_USED: 'Ce code a déjà servi.',
  EXPIRED: 'Ce code a expiré.',
  NOT_STARTED: 'Ce code n’est pas encore valable.',
  WRONG_BRANCH: 'Ce code n’est pas valable dans ce restaurant.',
  NO_ELIGIBLE_ITEM: 'Aucun article de ta commande n’est concerné par la remise (hors Chawarma).',
  ALREADY_CLAIMED: 'Ce code est déjà gardé sur un autre numéro.',
  NO_ACTIVE_CODE: 'Aucun code promo actif sur ce numéro dans ce restaurant.',
  RATE_LIMITED: 'Trop d’essais. Réessaie dans une heure.',
  CONSENT_REQUIRED: 'Coche la case pour accepter qu’on te recontacte au sujet de ce code.',
  INVALID_PHONE: 'Ce numéro de téléphone n’est pas valide.',
};

export type StatutCode = 'DISPONIBLE' | 'RESERVE' | 'UTILISE' | 'ANNULE';

/** Ce qu'il faut savoir d'un code pour décider. */
export interface CodeLu {
  restaurant_id: string;
  id: string;
  code: string;
  statut: StatutCode;
  telephone: string | null;
}

/** Ce qu'il faut savoir de son lot. */
export interface LotLu {
  pourcentage: number;
  valide_du: string;
  valide_au: string;
  annule_le: string | null;
}

/**
 * Code tapé ou scanné → forme canonique `PAM-7K3QX`, ou `null`.
 * Accepte minuscules, espaces et tiret oublié : « pam 7k3qx », « PAM7K3QX ».
 */
export function normaliserCode(saisie: unknown): string | null {
  if (typeof saisie !== 'string') return null;
  const brut = saisie.toUpperCase().replace(/[\s-]/g, '');
  if (brut.length !== 8) return null;
  const code = `${brut.slice(0, 3)}-${brut.slice(3)}`;
  return FORMAT_CODE.test(code) ? code : null;
}

/**
 * Numéro ivoirien → `+225XXXXXXXXXX` (10 chiffres depuis 2021), ou `null`.
 * Accepte « 07 77 30 33 33 », « +225 0777303333 », « 002250777303333 ».
 */
export function normaliserTelephone(saisie: unknown): string | null {
  if (typeof saisie !== 'string') return null;
  let chiffres = saisie.replace(/[\s.\-()]/g, '');
  if (chiffres.startsWith('+')) chiffres = chiffres.slice(1);
  else if (chiffres.startsWith('00')) chiffres = chiffres.slice(2);
  if (!/^\d+$/.test(chiffres)) return null;
  if (chiffres.length === 13 && chiffres.startsWith('225')) chiffres = chiffres.slice(3);
  return /^\d{10}$/.test(chiffres) ? `+225${chiffres}` : null;
}

/** `PAM-7K3QX` → `PAM-•••QX` : la caisse et le site ne montrent que ça (R12). */
export function masquerCode(code: string): string {
  return `${code.slice(0, 4)}•••${code.slice(-2)}`;
}

/** Hors période (R3) ? `null` si le lot est valable à cet instant. */
function horsPeriode(lot: LotLu, maintenant: Date): Motif | null {
  if (maintenant.getTime() < Date.parse(lot.valide_du)) return 'NOT_STARTED';
  if (maintenant.getTime() > Date.parse(lot.valide_au)) return 'EXPIRED';
  return null;
}

/**
 * Un code peut-il servir pour une commande de ce restaurant, maintenant ?
 * `null` = oui. Un code RÉSERVÉ est refusé : une commande l'attend déjà.
 */
export function refusUtilisation(code: CodeLu, lot: LotLu, restaurantId: string, maintenant: Date): Motif | null {
  if (code.statut === 'ANNULE' || lot.annule_le) return 'INVALID';
  if (code.statut === 'UTILISE' || code.statut === 'RESERVE') return 'ALREADY_USED';
  if (code.restaurant_id !== restaurantId) return 'WRONG_BRANCH';
  return horsPeriode(lot, maintenant);
}

/**
 * Le code peut-il encore être gardé ? Indépendant du numéro : c'est ce que la
 * page d'activation affiche avant que le client tape le sien.
 * Avant la date de début, c'est permis : le client garde son code pour plus tard.
 */
export function refusActivation(code: CodeLu, lot: LotLu, maintenant: Date): Motif | null {
  if (code.statut === 'ANNULE' || lot.annule_le) return 'INVALID';
  if (code.statut === 'UTILISE') return 'ALREADY_USED';
  if (maintenant.getTime() > Date.parse(lot.valide_au)) return 'EXPIRED';
  return null;
}

/** Activation (R11, R13) : rattacher le code à ce numéro. */
export function decisionActivation(
  code: CodeLu,
  lot: LotLu,
  telephone: string,
  consentement: boolean,
  maintenant: Date,
): { motif: Motif } | { deja: boolean } {
  const motif = refusActivation(code, lot, maintenant);
  if (motif) return { motif };
  if (code.telephone === telephone) return { deja: true };
  if (code.telephone) return { motif: 'ALREADY_CLAIMED' };
  if (!consentement) return { motif: 'CONSENT_REQUIRED' };
  return { deja: false };
}

/**
 * R12 : parmi les codes d'un numéro dans ce restaurant, ceux qui servent
 * maintenant, celui qui expire en premier d'abord.
 */
export function codesUtilisablesParNumero<T extends { code: CodeLu; lot: LotLu }>(
  candidats: T[],
  restaurantId: string,
  maintenant: Date,
): T[] {
  return candidats
    .filter((c) => refusUtilisation(c.code, c.lot, restaurantId, maintenant) === null)
    .sort((a, b) => Date.parse(a.lot.valide_au) - Date.parse(b.lot.valide_au));
}

/** Une ligne de panier envoyée par le site, déjà au prix du happy hour s'il y a lieu. */
export interface LignePanier {
  montant: number;
  exclue: boolean;
}

/** `lignes` du corps : liste de `{ montant, exclue }`, montants entiers FCFA. */
export function lireLignes(brut: unknown): { lignes?: LignePanier[]; erreur?: string } {
  if (brut === undefined || brut === null) return {};
  if (!Array.isArray(brut) || brut.length > 200) return { erreur: 'Lignes du panier invalides' };
  const lignes: LignePanier[] = [];
  for (const l of brut) {
    const montant = (l as Record<string, unknown>)?.montant;
    const exclue = (l as Record<string, unknown>)?.exclue;
    if (!Number.isInteger(montant) || (montant as number) < 0 || typeof exclue !== 'boolean') {
      return { erreur: 'Lignes du panier invalides' };
    }
    lignes.push({ montant: montant as number, exclue });
  }
  return { lignes };
}

/**
 * Remise ESTIMÉE (R5) : le pourcentage du lot sur chaque ligne non exclue,
 * arrondi ligne par ligne comme la caisse. La caisse refait le calcul officiel.
 * `null` = aucune ligne éligible (R7).
 */
export function remiseEstimee(lignes: LignePanier[], pourcentage: number): number | null {
  const eligibles = lignes.filter((l) => !l.exclue);
  if (eligibles.length === 0) return null;
  return eligibles.reduce((somme, l) => somme + Math.round((l.montant * pourcentage) / 100), 0);
}

/**
 * Limite d'essais : 10 échecs dans la même heure bloquent l'IP pendant 1 h
 * à compter du 10e. `echecs` = dates des derniers échecs, le plus récent
 * d'abord. Renvoie la fin du blocage, ou `null`.
 */
export function finBlocage(echecs: Date[], maintenant: Date): Date | null {
  if (echecs.length < ESSAIS_MAX) return null;
  const dernier = echecs[0]!.getTime();
  const dixieme = echecs[ESSAIS_MAX - 1]!.getTime();
  if (dernier - dixieme > FENETRE_ESSAIS_MS) return null;
  const fin = dernier + FENETRE_ESSAIS_MS;
  return maintenant.getTime() < fin ? new Date(fin) : null;
}

/** Nouveau lot, tel que la console l'envoie. */
export interface LotDemande {
  restaurant_id: string;
  libelle: string;
  pourcentage: number;
  quantite: number;
  valide_du: string;
  valide_au: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const JOUR_MS = 24 * 3600 * 1000;

function jourUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function jourValide(jour: string): boolean {
  return JOUR.test(jour) && jourUtc(new Date(`${jour}T00:00:00Z`)) === jour;
}

/**
 * Lit un lot demandé par la console. Dates au format `AAAA-MM-JJ`, toutes deux
 * incluses ; par défaut du lendemain pendant 28 jours. Le lot vaut du début
 * du premier jour à la dernière milliseconde du dernier (R3).
 */
export function lireLot(corps: Record<string, unknown>, maintenant: Date): { valeur?: LotDemande; erreur?: string } {
  if (typeof corps.restaurant_id !== 'string' || !UUID.test(corps.restaurant_id)) {
    return { erreur: 'Restaurant non précisé' };
  }
  const libelle = typeof corps.libelle === 'string' ? corps.libelle.trim() : '';
  if (!libelle || libelle.length > 80) return { erreur: 'Donne un libellé au lot (80 caractères au plus)' };

  const pourcentage = corps.pourcentage ?? 20;
  if (!Number.isInteger(pourcentage) || (pourcentage as number) < 1 || (pourcentage as number) > 100) {
    return { erreur: 'La remise doit être un nombre entier entre 1 et 100 %' };
  }
  const quantite = corps.quantite;
  if (!Number.isInteger(quantite) || (quantite as number) < 1 || (quantite as number) > QUANTITE_MAX) {
    return { erreur: `La quantité doit être comprise entre 1 et ${QUANTITE_MAX}` };
  }

  const aujourdhui = jourUtc(maintenant);
  const du = typeof corps.du === 'string' && corps.du ? corps.du : jourUtc(new Date(maintenant.getTime() + JOUR_MS));
  if (!jourValide(du)) return { erreur: 'Date de début invalide' };
  const au =
    typeof corps.au === 'string' && corps.au
      ? corps.au
      : jourUtc(new Date(Date.parse(`${du}T00:00:00Z`) + (DUREE_PAR_DEFAUT_JOURS - 1) * JOUR_MS));
  if (!jourValide(au)) return { erreur: 'Date de fin invalide' };
  if (du < aujourdhui) return { erreur: 'La date de début est déjà passée' };
  if (au < du) return { erreur: 'La date de fin est avant la date de début' };
  if ((Date.parse(au) - Date.parse(du)) / JOUR_MS + 1 > DUREE_MAX_JOURS) {
    return { erreur: 'Un lot ne peut pas durer plus d’un an' };
  }

  return {
    valeur: {
      restaurant_id: corps.restaurant_id,
      libelle,
      pourcentage: pourcentage as number,
      quantite: quantite as number,
      valide_du: `${du}T00:00:00.000Z`,
      valide_au: `${au}T23:59:59.999Z`,
    },
  };
}
