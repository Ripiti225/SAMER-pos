// Codes promo « cartes colis » — règles partagées par le serveur de caisse et
// l'écran (brief ~/BRIEF_CODES_PROMO_CARTES.md, § 3 et § 5).
//
// Jumelles côté cloud : supabase/functions/_shared/promo.ts (Deno ne lit pas
// ce paquet). Les deux doivent normaliser et masquer à l'identique.

export const CANAUX_CODE_PROMO = ['SUR_PLACE', 'TELEPHONE', 'SITE'] as const;
export type CanalCodePromo = (typeof CANAUX_CODE_PROMO)[number];

export const LIBELLES_CANAL_CODE_PROMO: Record<CanalCodePromo, string> = {
  SUR_PLACE: 'Sur place / emporter',
  TELEPHONE: 'Téléphone',
  SITE: 'Site (WhatsApp)',
};

const FORMAT_CODE = /^[A-HJKM-Z]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

/** Code tapé → `PAM-7K3QX`, ou `null`. Accepte minuscules, espaces, tiret oublié. */
export function normaliserCodePromo(saisie: string): string | null {
  const brut = saisie.toUpperCase().replace(/[\s-]/g, '');
  if (brut.length !== 8) return null;
  const code = `${brut.slice(0, 3)}-${brut.slice(3)}`;
  return FORMAT_CODE.test(code) ? code : null;
}

/** Numéro ivoirien → `+225XXXXXXXXXX` (10 chiffres), ou `null`. */
export function normaliserTelephoneClient(saisie: string): string | null {
  let chiffres = saisie.replace(/[\s.\-()]/g, '');
  if (chiffres.startsWith('+')) chiffres = chiffres.slice(1);
  else if (chiffres.startsWith('00')) chiffres = chiffres.slice(2);
  if (!/^\d+$/.test(chiffres)) return null;
  if (chiffres.length === 13 && chiffres.startsWith('225')) chiffres = chiffres.slice(3);
  return /^\d{10}$/.test(chiffres) ? `+225${chiffres}` : null;
}

/** `PAM-7K3QX` → `PAM-•••QX` : la caisse ne montre jamais le code d'un client trouvé par son numéro. */
export function masquerCodePromo(code: string): string {
  return `${code.slice(0, 4)}•••${code.slice(-2)}`;
}

/**
 * Répartit un montant entier entre des lignes, au prorata de leur poids. La
 * dernière ligne prend le reliquat : la somme est exacte au franc près.
 */
export function repartir(montant: number, poids: { id: string; poids: number }[]): Map<string, number> {
  const parts = new Map<string, number>();
  const total = poids.reduce((s, p) => s + p.poids, 0);
  if (montant <= 0 || total <= 0) {
    for (const p of poids) parts.set(p.id, 0);
    return parts;
  }
  let reste = montant;
  poids.forEach((p, i) => {
    const part = i === poids.length - 1 ? reste : Math.floor((montant * p.poids) / total);
    parts.set(p.id, part);
    reste -= part;
  });
  return parts;
}

/** Une ligne de commande pour le calcul de la remise du code. */
export interface LigneCodePromo {
  id: string;
  /** Montant brut de la ligne (prix figé + suppléments) × quantité. */
  montant: number;
  /** Part du happy hour déjà déduite de cette ligne. */
  partHappyHour: number;
  /** Catégorie exclue des codes carte (Chawarma) : jamais remisée. */
  exclue: boolean;
}

/**
 * Remise d'un code carte (R4, R5, R6) : le pourcentage du lot, ligne par ligne,
 * sur ce qui reste APRÈS le happy hour (cumul en cascade), jamais sur une
 * ligne exclue. Arrondi ligne par ligne, comme la caisse le fait déjà.
 */
export function remiseCodePromo(lignes: LigneCodePromo[], pourcentage: number): { total: number; parLigne: Map<string, number> } {
  const parLigne = new Map<string, number>();
  let total = 0;
  for (const l of lignes) {
    const base = Math.max(0, l.montant - l.partHappyHour);
    const remise = l.exclue ? 0 : Math.round((base * pourcentage) / 100);
    parLigne.set(l.id, remise);
    total += remise;
  }
  return { total, parLigne };
}
