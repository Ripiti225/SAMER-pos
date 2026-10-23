'use strict';
// manifeste.json : la description signée d'un paquet de mise à jour.
//
// C'est le SEUL document signé. Il porte les SHA-256 de chaque morceau
// téléchargé et de chaque fichier extrait : vérifier la signature puis ces
// empreintes suffit à prouver que l'arbre installé est exactement celui qui
// a été publié. D'où une validation stricte, écrite à la main (pas de zod :
// le lanceur n'embarque aucune dépendance) — tout champ inconnu est refusé,
// pour qu'un manifeste ne puisse rien « glisser » que le lanceur ignorerait.
const { ErreurMaj } = require('./erreurs.cjs');
const { versionTexteValide } = require('./version.cjs');
const { verifierAvecTrousseau } = require('./signature.cjs');

const FORMAT_MANIFESTE = 1;
const FICHIER_MANIFESTE = 'manifeste.json';
const FICHIER_SIGNATURE = 'manifeste.json.sig';
/** Chemin, dans l'archive, du nouveau PosSamer.exe quand la section `lanceur` est présente (phase 3). */
const CHEMIN_LANCEUR = '_lanceur/PosSamer.exe';

const LIMITES = Object.freeze({
  octetsManifeste: 64 * 1024 * 1024,
  morceaux: 2000,
  fichiers: 200000,
  notes: 4000,
  octetsChemin: 255,
});

const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_COMMIT = /^[0-9a-f]{7,40}$/;
const RE_SEMVER = /^\d+\.\d+\.\d+$/;
const RE_MIGRATION = /^\d{4}_[a-z0-9_]+$/;
const RE_NOM_MORCEAU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Noms que Windows réserve aux périphériques, avec ou sans extension.
const RE_NOM_RESERVE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// Caractères interdits par NTFS dans un nom (dont « : », flux alternatifs),
// la barre oblique inverse (séparateur Windows) et les caractères de contrôle.
// eslint-disable-next-line no-control-regex
const RE_CARACTERES_INTERDITS = /[\u0000-\u001f<>:"|?*\\]/;

function refus(detail) {
  throw new ErreurMaj('MANIFESTE_INVALIDE', `Manifeste de mise à jour invalide : ${detail}.`);
}

/**
 * Chemin relatif sûr à l'intérieur de `app/` : séparateur `/`, pas absolu,
 * pas de lecteur, pas de `..` ni de `.`, pas de nom que Windows réécrirait
 * (point ou espace final, nom réservé, flux alternatif « : »). Sert au
 * manifeste ET à l'extraction de l'archive, qui doivent dire la même chose.
 * Renvoie un message d'erreur, ou null si le chemin est acceptable.
 */
function problemeChemin(chemin) {
  if (typeof chemin !== 'string' || chemin.length === 0) return 'chemin vide';
  if (Buffer.byteLength(chemin, 'utf8') > LIMITES.octetsChemin) return 'chemin trop long';
  if (chemin.startsWith('/') || /^[A-Za-z]:/.test(chemin)) return 'chemin absolu interdit';
  if (RE_CARACTERES_INTERDITS.test(chemin)) return 'caractère interdit dans le chemin';
  for (const segment of chemin.split('/')) {
    if (segment === '') return 'segment vide dans le chemin';
    if (segment === '..') return 'remontée « .. » interdite';
    if (segment === '.') return 'segment « . » interdit';
    if (/[. ]$/.test(segment)) return 'nom terminé par un point ou une espace';
    if (RE_NOM_RESERVE.test(segment)) return 'nom réservé par Windows';
  }
  return null;
}

function exigerObjet(valeur, nom) {
  if (!valeur || typeof valeur !== 'object' || Array.isArray(valeur)) refus(`« ${nom} » doit être un objet`);
}

function exigerCles(obj, nom, obligatoires, facultatives = []) {
  exigerObjet(obj, nom);
  const permises = new Set([...obligatoires, ...facultatives]);
  for (const cle of Object.keys(obj)) if (!permises.has(cle)) refus(`champ inconnu « ${nom}.${cle} »`);
  for (const cle of obligatoires) if (!Object.prototype.hasOwnProperty.call(obj, cle)) refus(`champ manquant « ${nom}.${cle} »`);
}

function exigerEntier(valeur, nom, min = 0) {
  if (!Number.isSafeInteger(valeur) || valeur < min) refus(`« ${nom} » doit être un entier ≥ ${min}`);
}

function exigerSha(valeur, nom) {
  if (typeof valeur !== 'string' || !RE_SHA256.test(valeur)) refus(`« ${nom} » doit être un SHA-256 hexadécimal`);
}

function exigerDate(valeur, nom) {
  if (typeof valeur !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(valeur) || Number.isNaN(Date.parse(valeur))) {
    refus(`« ${nom} » doit être une date ISO`);
  }
}

function validerMorceaux(morceaux, archive) {
  if (!Array.isArray(morceaux) || morceaux.length === 0) refus('la liste des morceaux est vide');
  if (morceaux.length > LIMITES.morceaux) refus('trop de morceaux');
  const noms = new Set();
  let total = 0;
  morceaux.forEach((m, i) => {
    exigerCles(m, `morceaux[${i}]`, ['nom', 'sha256', 'taille']);
    if (typeof m.nom !== 'string' || !RE_NOM_MORCEAU.test(m.nom)) refus(`nom de morceau invalide « ${m.nom} »`);
    if (noms.has(m.nom.toLowerCase())) refus(`morceau en double « ${m.nom} »`);
    noms.add(m.nom.toLowerCase());
    exigerSha(m.sha256, `morceaux[${i}].sha256`);
    exigerEntier(m.taille, `morceaux[${i}].taille`, 1);
    total += m.taille;
  });
  if (total !== archive.taille) refus('la somme des morceaux ne fait pas la taille de l’archive');
}

function validerFichiers(fichiers) {
  if (!Array.isArray(fichiers) || fichiers.length === 0) refus('la liste des fichiers est vide');
  if (fichiers.length > LIMITES.fichiers) refus('trop de fichiers');
  // Windows ne distingue pas la casse : « A.js » et « a.js » écraseraient le
  // même fichier, et l'un des deux contrôles d'empreinte mentirait.
  const vus = new Set();
  fichiers.forEach((f, i) => {
    exigerCles(f, `fichiers[${i}]`, ['chemin', 'sha256', 'taille']);
    const p = problemeChemin(f.chemin);
    if (p) refus(`${p} (« ${f.chemin} »)`);
    const cle = f.chemin.toLowerCase();
    if (vus.has(cle)) refus(`fichier en double « ${f.chemin} »`);
    vus.add(cle);
    exigerSha(f.sha256, `fichiers[${i}].sha256`);
    exigerEntier(f.taille, `fichiers[${i}].taille`, 0);
  });
  // Un fichier ne peut pas être aussi un dossier (« a » et « a/b »).
  for (const f of fichiers) {
    const segments = f.chemin.toLowerCase().split('/');
    for (let n = 1; n < segments.length; n++) {
      const parent = segments.slice(0, n).join('/');
      if (vus.has(parent)) refus(`« ${parent} » est à la fois un fichier et un dossier`);
    }
  }
}

function validerMigrations(mig) {
  exigerCles(mig, 'migrations', ['derniere', 'nouvelles', 'retrocompatibles']);
  if (mig.derniere !== null && (typeof mig.derniere !== 'string' || !RE_MIGRATION.test(mig.derniere))) {
    refus('« migrations.derniere » doit être un nom de migration (0043_nom) ou null');
  }
  if (!Array.isArray(mig.nouvelles)) refus('« migrations.nouvelles » doit être une liste');
  mig.nouvelles.forEach((n, i) => {
    if (typeof n !== 'string' || !RE_MIGRATION.test(n)) refus(`« migrations.nouvelles[${i}] » invalide`);
    if (i > 0 && n <= mig.nouvelles[i - 1]) refus('« migrations.nouvelles » doit être triée, sans doublon');
  });
  if (mig.nouvelles.length > 0 && mig.nouvelles[mig.nouvelles.length - 1] !== mig.derniere) {
    refus('la dernière nouvelle migration doit être « migrations.derniere »');
  }
  if (typeof mig.retrocompatibles !== 'boolean') refus('« migrations.retrocompatibles » doit être vrai ou faux');
}

/**
 * Valide un manifeste déjà parsé et le renvoie. Lève une ErreurMaj
 * 'MANIFESTE_INVALIDE' au premier écart.
 *
 * Deux types :
 * - APP : l'arbre complet de `app/` (hors node_modules) pour une version ;
 * - DEPENDANCES : un `node_modules` complet, identifié par l'empreinte du
 *   pnpm-lock.yaml. Publié rarement, réutilisé tant que cette empreinte ne
 *   change pas.
 */
function validerManifeste(m) {
  exigerObjet(m, 'manifeste');
  if (m.format !== FORMAT_MANIFESTE) refus(`format ${m.format} non pris en charge`);
  const communs = ['format', 'type', 'publie_le', 'node_min', 'archive', 'morceaux', 'fichiers'];
  if (m.type === 'APP') {
    exigerCles(
      m,
      'manifeste',
      [...communs, 'numero', 'version', 'commit', 'lanceur_min', 'dependances', 'migrations', 'notes'],
      ['lanceur'],
    );
    exigerEntier(m.numero, 'numero', 1);
    if (!versionTexteValide(m.version)) refus('« version » doit avoir la forme AAAA.MM.JJ-n');
    if (typeof m.commit !== 'string' || !RE_COMMIT.test(m.commit)) refus('« commit » doit être un identifiant git');
    exigerEntier(m.lanceur_min, 'lanceur_min', 1);
    exigerCles(m.dependances, 'dependances', ['empreinte']);
    exigerSha(m.dependances.empreinte, 'dependances.empreinte');
    validerMigrations(m.migrations);
    if (typeof m.notes !== 'string' || m.notes.length > LIMITES.notes) {
      refus(`« notes » doit être un texte de ${LIMITES.notes} caractères au plus`);
    }
  } else if (m.type === 'DEPENDANCES') {
    exigerCles(m, 'manifeste', [...communs, 'empreinte'], ['notes']);
    exigerSha(m.empreinte, 'empreinte');
    if (m.notes !== undefined && (typeof m.notes !== 'string' || m.notes.length > LIMITES.notes)) refus('« notes » invalide');
  } else {
    refus('« type » doit être APP ou DEPENDANCES');
  }
  exigerDate(m.publie_le, 'publie_le');
  if (typeof m.node_min !== 'string' || !RE_SEMVER.test(m.node_min)) refus('« node_min » doit avoir la forme 22.0.0');
  exigerCles(m.archive, 'archive', ['sha256', 'taille']);
  exigerSha(m.archive.sha256, 'archive.sha256');
  exigerEntier(m.archive.taille, 'archive.taille', 1);
  validerMorceaux(m.morceaux, m.archive);
  validerFichiers(m.fichiers);
  if (m.lanceur !== undefined) {
    exigerCles(m.lanceur, 'lanceur', ['numero', 'sha256', 'taille']);
    exigerEntier(m.lanceur.numero, 'lanceur.numero', 1);
    exigerSha(m.lanceur.sha256, 'lanceur.sha256');
    exigerEntier(m.lanceur.taille, 'lanceur.taille', 1);
    const exe = m.fichiers.find((f) => f.chemin === CHEMIN_LANCEUR);
    if (!exe || exe.sha256 !== m.lanceur.sha256 || exe.taille !== m.lanceur.taille) {
      refus(`la section « lanceur » doit correspondre au fichier ${CHEMIN_LANCEUR} de l’archive`);
    }
  }
  return m;
}

/** Parse des octets (Buffer) en manifeste validé. */
function lireManifeste(octets) {
  const buf = Buffer.isBuffer(octets) ? octets : Buffer.from(octets);
  if (buf.length > LIMITES.octetsManifeste) refus('fichier trop volumineux');
  let obj;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } catch {
    refus('JSON illisible');
  }
  return validerManifeste(obj);
}

/** Octets canoniques d'un manifeste (ceux que l'outil de publication signe). */
function serialiserManifeste(m) {
  validerManifeste(m);
  return Buffer.from(`${JSON.stringify(m, null, 2)}\n`, 'utf8');
}

/**
 * Point d'entrée du lanceur et du serveur : vérifie la signature des octets
 * EXACTS, puis seulement les parse. Un manifeste non signé n'est jamais lu.
 * Renvoie `{ manifeste, cle: 'actuelle' | 'suivante' }`.
 */
function ouvrirManifesteSigne(octets, signatureB64, trousseau) {
  const cle = verifierAvecTrousseau(octets, signatureB64, trousseau);
  if (!cle) {
    throw new ErreurMaj('SIGNATURE_INVALIDE', 'La signature du paquet de mise à jour est invalide : paquet refusé.');
  }
  return { manifeste: lireManifeste(octets), cle };
}

function comparerSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Ce poste peut-il installer ce paquet ? `lanceur` : numéro du lanceur en
 * place ; `node` : version du node portable (`runtime/node`, PAS celui
 * d'Electron, qui n'exécute pas le serveur). Renvoie la liste des
 * empêchements, en français (vide = compatible).
 */
function problemesCompatibilite(m, { lanceur, node }) {
  const problemes = [];
  if (m.type === 'APP' && !(lanceur >= m.lanceur_min)) {
    problemes.push(`Le lanceur PosSamer.exe est trop ancien (n° ${lanceur}, il faut au moins ${m.lanceur_min}).`);
  }
  const nodePropre = String(node || '').replace(/^v/, '');
  if (!RE_SEMVER.test(nodePropre) || comparerSemver(nodePropre, m.node_min) < 0) {
    problemes.push(`Node.js est trop ancien (${node || 'inconnu'}, il faut au moins ${m.node_min}).`);
  }
  return problemes;
}

module.exports = {
  FORMAT_MANIFESTE,
  FICHIER_MANIFESTE,
  FICHIER_SIGNATURE,
  CHEMIN_LANCEUR,
  LIMITES,
  problemeChemin,
  validerManifeste,
  lireManifeste,
  serialiserManifeste,
  ouvrirManifesteSigne,
  problemesCompatibilite,
};
