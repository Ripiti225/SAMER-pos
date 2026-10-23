'use strict';
// VERSION.json : l'identité de la version installée dans `app/`.
//
// Le NUMÉRO entier est la seule chose qu'on compare : la chaîne
// `AAAA.MM.JJ-n` est faite pour les humains (console siège, écran « Mise à
// jour en cours »), et deux publications le même jour ne s'ordonnent pas de
// façon fiable par texte. On ne revient jamais à un numéro inférieur : un
// retour à l'ancien code se publie sous un NOUVEAU numéro (plan § 2).
const fs = require('node:fs');
const path = require('node:path');
const { ErreurMaj } = require('./erreurs.cjs');

const FICHIER_VERSION = 'VERSION.json';
const RE_VERSION = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d{0,2})$/;
const RE_COMMIT = /^[0-9a-f]{7,40}$/;

/** Version d'un poste de développement (pas de VERSION.json) : numéro 0, tout paquet signé est plus récent. */
const VERSION_DEV = Object.freeze({ numero: 0, version: 'dev', commit: null, dev: true });

function estEntierPositif(n) {
  return Number.isSafeInteger(n) && n > 0;
}

/** `AAAA.MM.JJ-n` valide, y compris la date (pas de 2026.02.30). */
function versionTexteValide(texte) {
  if (typeof texte !== 'string') return false;
  const m = RE_VERSION.exec(texte);
  if (!m) return false;
  const [a, mo, j] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(a, mo - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === mo - 1 && d.getUTCDate() === j;
}

/** Fabrique `AAAA.MM.JJ-n` (date en heure d'Abidjan = UTC). */
function formaterVersion(date, rangDuJour) {
  if (!Number.isSafeInteger(rangDuJour) || rangDuJour < 1 || rangDuJour > 999) {
    throw new ErreurMaj('VERSION_INVALIDE', 'Le rang de publication du jour doit être un entier entre 1 et 999.');
  }
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}.${p(date.getUTCMonth() + 1)}.${p(date.getUTCDate())}-${rangDuJour}`;
}

/** Valide le contenu d'un VERSION.json ; lève une ErreurMaj sinon. */
function validerVersion(obj) {
  const refus = (detail) => {
    throw new ErreurMaj('VERSION_INVALIDE', `Fichier de version invalide : ${detail}.`);
  };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) refus('ce n’est pas un objet');
  const permis = new Set(['numero', 'version', 'commit', 'publie_le']);
  for (const cle of Object.keys(obj)) if (!permis.has(cle)) refus(`champ inconnu « ${cle} »`);
  if (!estEntierPositif(obj.numero)) refus('le numéro doit être un entier positif');
  if (!versionTexteValide(obj.version)) refus('la version doit avoir la forme AAAA.MM.JJ-n');
  if (!RE_COMMIT.test(String(obj.commit))) refus('le commit doit être un identifiant git');
  if (obj.publie_le !== undefined && Number.isNaN(Date.parse(obj.publie_le))) refus('date de publication illisible');
  return { numero: obj.numero, version: obj.version, commit: obj.commit, publie_le: obj.publie_le, dev: false };
}

/**
 * Lit `<dossierApp>/VERSION.json`. Absent ou illisible → version `dev`
 * (numéro 0) : un poste monté à la main ou en développement doit continuer
 * de démarrer, et il acceptera la première version signée qu'on lui envoie.
 */
function lireVersion(dossierApp) {
  let brut;
  try {
    brut = fs.readFileSync(path.join(dossierApp, FICHIER_VERSION), 'utf8');
  } catch {
    return { ...VERSION_DEV };
  }
  try {
    return validerVersion(JSON.parse(brut.replace(/^﻿/, '')));
  } catch {
    return { ...VERSION_DEV, illisible: true };
  }
}

/** Contenu à écrire dans VERSION.json (sans le drapeau interne `dev`). */
function contenuVersion({ numero, version, commit, publie_le }) {
  const obj = { numero, version, commit };
  if (publie_le !== undefined) obj.publie_le = publie_le;
  validerVersion(obj);
  return obj;
}

/** Tri par numéro : < 0 si a est plus ancien que b. */
function comparerVersions(a, b) {
  return a.numero - b.numero;
}

/**
 * Faut-il installer `candidate` par-dessus `installee` ?
 * - numéro supérieur → 'INSTALLER' ;
 * - même numéro → 'DEJA_INSTALLEE' ;
 * - numéro inférieur → 'REFUSEE_INFERIEURE' (jamais de retour en arrière par numéro).
 */
function deciderMontee(installee, candidate) {
  if (!estEntierPositif(candidate && candidate.numero)) {
    throw new ErreurMaj('VERSION_INVALIDE', 'Le paquet proposé n’a pas de numéro de version valide.');
  }
  const d = comparerVersions(candidate, installee);
  if (d > 0) return 'INSTALLER';
  if (d === 0) return 'DEJA_INSTALLEE';
  return 'REFUSEE_INFERIEURE';
}

module.exports = {
  FICHIER_VERSION,
  RE_VERSION,
  VERSION_DEV,
  versionTexteValide,
  formaterVersion,
  validerVersion,
  lireVersion,
  contenuVersion,
  comparerVersions,
  deciderMontee,
};
