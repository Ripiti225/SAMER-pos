'use strict';
// Le dossier portable d'un site, vu par la mise à jour (contrat § 4) :
//
//   ROOT/app/                      code en service (VERSION.json, node_modules…)
//   ROOT/app.precedente/           version d'avant, gardée jusqu'à l'installation suivante
//   ROOT/data/pgdata/              base PostgreSQL
//   ROOT/data/sauvegardes/<nom>/   copies à froid de pgdata (nom L0 `nomSauvegarde`)
//   ROOT/maj/etat.json             écrit par le SERVEUR (seul écrivain)
//   ROOT/maj/installation.json     journal du LANCEUR (seul écrivain)
//   ROOT/maj/lanceur.json          mémoire du LANCEUR : jetons du siège déjà traités
//   ROOT/maj/telechargement/<n>/   morceaux en cours
//   ROOT/maj/pret/<n>/app/         arbre extrait et vérifié
//   ROOT/maj/pret/deps-<e>/        paquet de dépendances extrait (node_modules…)
//
// Un fichier = un seul écrivain : le serveur et le lanceur ne se marchent
// jamais dessus, et chacun peut décider même si l'autre est mort.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ecrireJsonAtomique } = require('./disque.cjs');

const FORMAT_ETAT = 1;
const FICHIER_EMPREINTE_DEPS = '.empreinte-deps';
/** Taille exacte de l'exécutable Grenam observé sur la clé le 16/10/2026. */
const TAILLE_GRENAM = 533504;

function cheminsSite(racine) {
  const r = path.resolve(racine);
  const maj = path.join(r, 'maj');
  return {
    racine: r,
    app: path.join(r, 'app'),
    appPrecedente: path.join(r, 'app.precedente'),
    data: path.join(r, 'data'),
    pgdata: path.join(r, 'data', 'pgdata'),
    sauvegardes: path.join(r, 'data', 'sauvegardes'),
    maj,
    etat: path.join(maj, 'etat.json'),
    journal: path.join(maj, 'installation.json'),
    lanceur: path.join(maj, 'lanceur.json'),
    telechargement: path.join(maj, 'telechargement'),
    pret: path.join(maj, 'pret'),
  };
}

/** Chemin RELATIF (au ROOT, séparateur `/`) écrit dans etat.json → chemin disque, sans sortir du ROOT. */
function resoudreDansRacine(racine, relatif) {
  if (typeof relatif !== 'string' || !relatif || path.isAbsolute(relatif) || /^[A-Za-z]:/.test(relatif)) return null;
  const abs = path.resolve(racine, ...relatif.split('/'));
  const rel = path.relative(path.resolve(racine), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function etatVide() {
  return { format: FORMAT_ETAT, pret: null, reglages: null, report: null, jetons_traites: { installer_maintenant: null, reessayer: null } };
}

/**
 * Lit etat.json. Absent ou illisible → état vide : ce fichier n'est qu'une
 * INDICATION (le lanceur revérifie signature et empreintes avant d'installer).
 */
async function lireEtat(chemin) {
  try {
    const j = JSON.parse(await fsp.readFile(chemin, 'utf8'));
    if (!j || j.format !== FORMAT_ETAT) return etatVide();
    return { ...etatVide(), ...j, jetons_traites: { ...etatVide().jetons_traites, ...(j.jetons_traites || {}) } };
  } catch {
    return etatVide();
  }
}

const ecrireEtat = (chemin, etat) => ecrireJsonAtomique(chemin, { ...etat, format: FORMAT_ETAT });

/** Mémoire du lanceur : jetons « installer maintenant » / « réessayer » déjà traités. */
async function lireMemoireLanceur(chemin) {
  try {
    const j = JSON.parse(await fsp.readFile(chemin, 'utf8'));
    return { format: 1, jetons_traites: { installer_maintenant: null, reessayer: null, ...(j.jetons_traites || {}) } };
  } catch {
    return { format: 1, jetons_traites: { installer_maintenant: null, reessayer: null } };
  }
}

/** Empreinte du pnpm-lock.yaml pour laquelle `<app>/node_modules` a été installé (null si inconnue). */
function lireEmpreinteDeps(dossierApp) {
  try {
    const t = fs.readFileSync(path.join(dossierApp, 'node_modules', FICHIER_EMPREINTE_DEPS), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** Octets occupés par un dossier (0 s'il n'existe pas). Liens non suivis. */
async function tailleDossier(dossier) {
  let total = 0;
  let entrees;
  try {
    entrees = await fsp.readdir(dossier, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entrees) {
    const abs = path.join(dossier, e.name);
    if (e.isDirectory()) total += await tailleDossier(abs);
    else if (e.isFile()) {
      try {
        total += (await fsp.stat(abs)).size;
      } catch { /* fichier disparu entre-temps */ }
    }
  }
  return total;
}

/** Octets libres sur le volume qui porte `chemin` (null si inconnu). */
async function espaceLibre(chemin) {
  try {
    const s = await fsp.statfs(chemin);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Sentinelle Grenam (virus de la clé master, 16/10/2026) : il remplace chaque
 * `.exe` par lui-même (533 504 octets) et cache l'original sous `g<nom>.exe`.
 * Node ne lit pas l'attribut « caché » de Windows : on repère donc (1) tout
 * `.exe` de 533 504 octets, (2) tout `g<X>.exe` posé à côté d'un `<X>.exe` —
 * la paire est la signature du virus. `data/pgdata` et les sauvegardes sont
 * ignorés (aucun exécutable, beaucoup de fichiers).
 * Renvoie la liste des chemins suspects (relatifs au ROOT).
 */
async function chercherSuspectsGrenam(racine, { limite = 50, ignorer = ['data', '.git'] } = {}) {
  const suspects = [];
  const ignores = new Set(ignorer.map((n) => n.toLowerCase()));
  async function parcourir(dossier, profondeur) {
    if (suspects.length >= limite || profondeur > 40) return;
    let entrees;
    try {
      entrees = await fsp.readdir(dossier, { withFileTypes: true });
    } catch {
      return;
    }
    const noms = new Set(entrees.filter((e) => e.isFile()).map((e) => e.name.toLowerCase()));
    for (const e of entrees) {
      const abs = path.join(dossier, e.name);
      if (e.isDirectory()) {
        if (profondeur === 0 && ignores.has(e.name.toLowerCase())) continue;
        await parcourir(abs, profondeur + 1);
        continue;
      }
      if (!e.isFile() || !/\.exe$/i.test(e.name)) continue;
      const bas = e.name.toLowerCase();
      let suspect = bas.length > 5 && bas.startsWith('g') && noms.has(bas.slice(1));
      if (!suspect) {
        try {
          suspect = (await fsp.stat(abs)).size === TAILLE_GRENAM;
        } catch { /* disparu */ }
      }
      if (suspect) suspects.push(path.relative(racine, abs).split(path.sep).join('/'));
      if (suspects.length >= limite) return;
    }
  }
  await parcourir(path.resolve(racine), 0);
  return suspects;
}

module.exports = {
  FORMAT_ETAT,
  FICHIER_EMPREINTE_DEPS,
  TAILLE_GRENAM,
  cheminsSite,
  resoudreDansRacine,
  etatVide,
  lireEtat,
  ecrireEtat,
  lireMemoireLanceur,
  lireEmpreinteDeps,
  tailleDossier,
  espaceLibre,
  chercherSuspectsGrenam,
};
