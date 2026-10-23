/**
 * Réglages de la mise à jour à distance côté serveur, lus dans
 * l'environnement que le LANCEUR passe au serveur (main.js, `envPortable`).
 *
 * Sans `POS_RACINE`, le module est inactif : c'est le cas des postes de
 * développement (`pnpm dev`) et des tests, qui n'ont pas de dossier portable
 * à mettre à jour.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cheminsSite, lireVersion, type CheminsSite, type ReglagesMaj, type VersionInstallee } from './fondations.js';

/** Racine de l'arbre `app/` qui TOURNE (apps/server/src/modules/maj → app). */
export const RACINE_APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Version du code démarré : lue une fois, c'est celle qui tourne qui compte. */
export const VERSION_DEMARREE: VersionInstallee = lireVersion(RACINE_APP);

export function racineSite(): string | null {
  const r = process.env.POS_RACINE?.trim();
  return r ? resolve(r) : null;
}

export function cheminsDuSite(): CheminsSite | null {
  const r = racineSite();
  return r ? cheminsSite(r) : null;
}

/** Numéro du lanceur PosSamer.exe en place (0 = lanceur d'avant la mise à jour à distance). */
export function numeroLanceur(): number {
  const n = Number(process.env.POS_LANCEUR_NUMERO ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function jetonLanceur(): string | null {
  const j = process.env.POS_JETON_LANCEUR?.trim();
  return j ? j : null;
}

export const INTERVALLE_CONSULTATION_MS = Number(process.env.MAJ_INTERVALLE_S ?? 15 * 60) * 1000;

/**
 * Débit maximal du téléchargement : la synchro des ventes et les terminaux du
 * restaurant passent par la même box. 512 Ko/s ≈ 4 Mbit/s : un paquet de code
 * (quelques Mo) passe en quelques secondes, un paquet de dépendances en une
 * dizaine de minutes. 0 = illimité.
 */
export const DEBIT_MAX_OCTETS_S = Number(process.env.MAJ_DEBIT_MAX_KO_S ?? 512) * 1024;

/** Réglages par défaut tant que le cloud n'a rien dit (contrat § 2). */
export const REGLAGES_PAR_DEFAUT: ReglagesMaj = {
  type_site: 'H24',
  heure_installation: '06:00',
  heure_filet: '05:00',
  pause: false,
  installer_maintenant: null,
  reessayer: null,
};
