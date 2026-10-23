// Numéro de version d'une publication.
//
// `numero` = AAAAMMJJ × 100 + rang du jour (2026102401), `version` =
// AAAA.MM.JJ-rang (2026.10.24-1) : le numéro se compare, la version se lit.
// Le cloud refuse tout numéro ≤ au dernier enregistré ; on part donc du plus
// haut connu (cloud + traces locales) pour proposer le suivant.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { formaterVersion } = require('../../../apps/desktop/maj/index.cjs');

export const RANG_MAX = 99;

/** Numéro AAAAMMJJnn d'une date (heure d'Abidjan = UTC) et d'un rang. */
export function numeroDe(date, rang) {
  if (!Number.isSafeInteger(rang) || rang < 1 || rang > RANG_MAX) throw new Error(`Rang du jour invalide (1 à ${RANG_MAX}) : ${rang}`);
  const jour = date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
  return jour * 100 + rang;
}

/**
 * Prochaine publication du jour : rang imposé (`--rang`) ou rang suivant le
 * plus haut numéro connu du même jour. Refuse un numéro qui ne dépasserait pas
 * le plus haut connu (horloge du poste en retard, par exemple).
 */
export function prochaineVersion(date, numerosConnus, rangImpose = null) {
  const base = numeroDe(date, 1) - 1;
  const max = numerosConnus.length ? Math.max(...numerosConnus) : 0;
  const rang = rangImpose ?? (max > base && max < base + 100 ? max - base + 1 : 1);
  const numero = numeroDe(date, rang);
  if (numero <= max) {
    throw new Error(`Le numéro ${numero} ne dépasse pas le dernier publié (${max}) : vérifiez l'horloge du poste ou passez --rang.`);
  }
  return { numero, version: formaterVersion(date, rang), rang };
}
