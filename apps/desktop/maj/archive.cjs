'use strict';
// Archive des paquets : tar (format ustar) + gzip, découpée en morceaux.
//
// Écrit à la main plutôt qu'avec une bibliothèque `tar` : le lanceur
// n'embarque aucune dépendance, et le sous-ensemble utile est minuscule
// (fichiers ordinaires et dossiers, rien d'autre). Surtout, l'extraction est
// le point où un paquet touche le disque : on veut y lire CHAQUE règle —
// liens refusés, chemins absolus et `..` refusés, chaque fichier comparé au
// manifeste signé — plutôt que de faire confiance aux options d'un tiers.
//
// Morceaux de 40 Mo par défaut : c'est la taille que le stockage cloud
// accepte sans « upload résumable », et c'est l'unité de reprise après une
// coupure internet (un morceau corrompu se retélécharge seul).
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ErreurMaj } = require('./erreurs.cjs');
const { problemeChemin } = require('./manifeste.cjs');
const { sha256Fichier } = require('./disque.cjs');

const TAILLE_MORCEAU_DEFAUT = 40 * 1024 * 1024;
const BLOC = 512;
const RE_PREFIXE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

// --------------------------------------------------------------------------
// En-têtes ustar
// --------------------------------------------------------------------------

function ecrireOctal(entete, decalage, longueur, valeur) {
  const texte = valeur.toString(8).padStart(longueur - 1, '0');
  if (texte.length > longueur - 1) throw new ErreurMaj('ARCHIVE_INVALIDE', 'Valeur trop grande pour un en-tête tar.');
  entete.write(`${texte}\0`, decalage, longueur, 'ascii');
}

/** Découpe un chemin en (prefix ≤ 155 octets, name ≤ 100 octets) au niveau d'un « / ». */
function decouperNom(chemin) {
  if (Buffer.byteLength(chemin) <= 100) return { prefixe: '', nom: chemin };
  const segments = chemin.split('/');
  for (let i = segments.length - 1; i > 0; i--) {
    const prefixe = segments.slice(0, i).join('/');
    const nom = segments.slice(i).join('/');
    if (Buffer.byteLength(prefixe) <= 155 && Buffer.byteLength(nom) <= 100) return { prefixe, nom };
  }
  throw new ErreurMaj('CHEMIN_INTERDIT', `Chemin trop long pour l'archive : « ${chemin} ».`);
}

function enteteFichier(chemin, taille, mtime) {
  const entete = Buffer.alloc(BLOC, 0);
  const { prefixe, nom } = decouperNom(chemin);
  entete.write(nom, 0, 100, 'utf8');
  ecrireOctal(entete, 100, 8, 0o644);
  ecrireOctal(entete, 108, 8, 0);
  ecrireOctal(entete, 116, 8, 0);
  ecrireOctal(entete, 124, 12, taille);
  ecrireOctal(entete, 136, 12, mtime);
  entete.write('        ', 148, 8, 'ascii'); // somme de contrôle : espaces pendant le calcul
  entete.write('0', 156, 1, 'ascii');
  entete.write('ustar\0', 257, 6, 'ascii');
  entete.write('00', 263, 2, 'ascii');
  entete.write(prefixe, 345, 155, 'utf8');
  let somme = 0;
  for (const o of entete) somme += o;
  entete.write(`${somme.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return entete;
}

function lireTexte(entete, debut, longueur) {
  const zone = entete.subarray(debut, debut + longueur);
  const fin = zone.indexOf(0);
  return zone.subarray(0, fin === -1 ? longueur : fin).toString('utf8');
}

function lireOctal(entete, debut, longueur) {
  const texte = lireTexte(entete, debut, longueur).trim();
  if (!/^[0-7]+$/.test(texte)) throw new ErreurMaj('ARCHIVE_INVALIDE', 'En-tête tar illisible.');
  return parseInt(texte, 8);
}

function lireEntete(entete) {
  const attendue = lireOctal(entete, 148, 8);
  let somme = 0;
  for (let i = 0; i < BLOC; i++) somme += i >= 148 && i < 156 ? 32 : entete[i];
  if (somme !== attendue) throw new ErreurMaj('ARCHIVE_INVALIDE', 'Somme de contrôle d’un en-tête tar incorrecte.');
  const nom = lireTexte(entete, 0, 100);
  const prefixe = lireTexte(entete, 345, 155);
  return {
    chemin: prefixe ? `${prefixe}/${nom}` : nom,
    taille: lireOctal(entete, 124, 12),
    type: String.fromCharCode(entete[156] || 0x30),
  };
}

// --------------------------------------------------------------------------
// Écriture (outil de publication, L2)
// --------------------------------------------------------------------------

/**
 * Archive `chemins` (relatifs à `racine`, séparateur « / ») dans
 * `dossierSortie/<prefixe>.tar.gz.000`, `.001`… Les fichiers sont triés et
 * horodatés à `mtime` fixe : deux publications du même arbre donnent la
 * même archive. Un lien symbolique dans l'arbre source est refusé.
 *
 * Renvoie de quoi remplir le manifeste :
 * `{ archive: {sha256, taille}, morceaux: [{nom, sha256, taille}], fichiers: [{chemin, sha256, taille}] }`.
 */
async function ecrireArchive({ racine, chemins, dossierSortie, prefixe = 'paquet', tailleMorceau = TAILLE_MORCEAU_DEFAUT, mtime = 0 }) {
  if (!RE_PREFIXE.test(prefixe)) throw new ErreurMaj('ARCHIVE_INVALIDE', `Préfixe de morceau invalide « ${prefixe} ».`);
  if (!Number.isSafeInteger(tailleMorceau) || tailleMorceau < 1) {
    throw new ErreurMaj('ARCHIVE_INVALIDE', 'La taille des morceaux doit être un entier positif.');
  }
  const tries = [...new Set(chemins)].sort();
  for (const c of tries) {
    const p = problemeChemin(c);
    if (p) throw new ErreurMaj('CHEMIN_INTERDIT', `${p} : « ${c} ».`, { chemin: c });
  }
  await fsp.mkdir(dossierSortie, { recursive: true });
  const fichiers = [];

  async function* flux() {
    for (const chemin of tries) {
      const absolu = path.join(racine, ...chemin.split('/'));
      const st = await fsp.lstat(absolu);
      if (st.isSymbolicLink()) throw new ErreurMaj('LIEN_INTERDIT', `Lien symbolique refusé : « ${chemin} ».`, { chemin });
      if (!st.isFile()) throw new ErreurMaj('TYPE_INTERDIT', `« ${chemin} » n'est pas un fichier ordinaire.`, { chemin });
      yield enteteFichier(chemin, st.size, mtime);
      const h = crypto.createHash('sha256');
      let lus = 0;
      for await (const b of fs.createReadStream(absolu)) {
        lus += b.length;
        if (lus > st.size) break;
        h.update(b);
        yield b;
      }
      // Fichier modifié pendant la lecture : l'en-tête mentirait sur la taille.
      if (lus !== st.size) throw new ErreurMaj('ARCHIVE_INVALIDE', `« ${chemin} » a changé pendant l'archivage.`, { chemin });
      const reste = st.size % BLOC;
      if (reste) yield Buffer.alloc(BLOC - reste, 0);
      fichiers.push({ chemin, sha256: h.digest('hex'), taille: st.size });
    }
    yield Buffer.alloc(BLOC * 2, 0); // fin d'archive : deux blocs nuls
  }

  const morceaux = [];
  const hArchive = crypto.createHash('sha256');
  let tailleArchive = 0;
  let courant = null; // { fh, nom, h, taille }

  async function fermerCourant() {
    if (!courant) return;
    await courant.fh.sync();
    await courant.fh.close();
    morceaux.push({ nom: courant.nom, sha256: courant.h.digest('hex'), taille: courant.taille });
    courant = null;
  }

  try {
    await pipeline(Readable.from(flux()), zlib.createGzip({ level: 9 }), decouper);
  } finally {
    if (courant) await courant.fh.close().catch(() => {});
  }
  return { archive: { sha256: hArchive.digest('hex'), taille: tailleArchive }, morceaux, fichiers };

  async function decouper(source) {
    for await (let bloc of source) {
      hArchive.update(bloc);
      tailleArchive += bloc.length;
      while (bloc.length > 0) {
        if (!courant) {
          const nom = `${prefixe}.tar.gz.${String(morceaux.length).padStart(3, '0')}`;
          courant = { fh: await fsp.open(path.join(dossierSortie, nom), 'w'), nom, h: crypto.createHash('sha256'), taille: 0 };
        }
        const part = bloc.subarray(0, tailleMorceau - courant.taille);
        await courant.fh.write(part);
        courant.h.update(part);
        courant.taille += part.length;
        bloc = bloc.subarray(part.length);
        if (courant.taille === tailleMorceau) await fermerCourant();
      }
    }
    await fermerCourant();
  }
}

// --------------------------------------------------------------------------
// Vérification des morceaux (serveur L3 : reprise ; lanceur L4 : revérification)
// --------------------------------------------------------------------------

/**
 * Compare chaque morceau présent dans `dossierMorceaux` au manifeste.
 * Renvoie `{ valides: [nom], invalides: [{ nom, raison: 'ABSENT'|'TAILLE'|'EMPREINTE' }] }` :
 * le serveur ne retélécharge que les invalides.
 */
async function verifierMorceaux(dossierMorceaux, manifeste) {
  const valides = [];
  const invalides = [];
  for (const m of manifeste.morceaux) {
    const chemin = path.join(dossierMorceaux, m.nom);
    let st;
    try {
      st = await fsp.stat(chemin);
    } catch {
      invalides.push({ nom: m.nom, raison: 'ABSENT' });
      continue;
    }
    if (!st.isFile() || st.size !== m.taille) invalides.push({ nom: m.nom, raison: 'TAILLE' });
    else if ((await sha256Fichier(chemin)) !== m.sha256) invalides.push({ nom: m.nom, raison: 'EMPREINTE' });
    else valides.push(m.nom);
  }
  return { valides, invalides };
}

// --------------------------------------------------------------------------
// Extraction
// --------------------------------------------------------------------------

async function dossierVideOuAbsent(dossier) {
  try {
    return (await fsp.readdir(dossier)).length === 0;
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    throw e;
  }
}

/** Chemin disque d'une entrée, avec un dernier contrôle qu'on reste bien sous `destination`. */
function cheminSur(destination, chemin) {
  const cible = path.resolve(destination, ...chemin.split('/'));
  const relatif = path.relative(destination, cible);
  if (!relatif || relatif.startsWith('..') || path.isAbsolute(relatif)) {
    throw new ErreurMaj('CHEMIN_INTERDIT', `Chemin hors du dossier de destination : « ${chemin} ».`, { chemin });
  }
  return cible;
}

/**
 * Vérifie les morceaux, puis extrait l'archive dans `destination` (absente ou
 * vide) en contrôlant CHAQUE fichier contre le manifeste : présent dans la
 * liste, taille et SHA-256 identiques, aucun manquant, aucun en trop.
 * Liens (durs ou symboliques), types spéciaux, chemins absolus et `..` sont
 * refusés. En cas d'échec, `destination` est supprimé : on ne laisse jamais
 * un arbre à moitié vérifié qui pourrait être pris pour une version prête.
 */
async function extraireArchive({ dossierMorceaux, manifeste, destination }) {
  const { invalides } = await verifierMorceaux(dossierMorceaux, manifeste);
  if (invalides.length > 0) {
    throw new ErreurMaj('MORCEAU_CORROMPU', `Morceau du paquet absent ou corrompu : ${invalides.map((i) => i.nom).join(', ')}.`, { invalides });
  }
  if (!(await dossierVideOuAbsent(destination))) {
    throw new ErreurMaj('DESTINATION_OCCUPEE', `Le dossier de préparation n'est pas vide : ${destination}.`);
  }
  const racine = path.resolve(destination);
  await fsp.mkdir(racine, { recursive: true });
  try {
    await extraireDans(dossierMorceaux, manifeste, racine);
  } catch (e) {
    await fsp.rm(racine, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function extraireDans(dossierMorceaux, manifeste, racine) {
  const attendus = new Map(manifeste.fichiers.map((f) => [f.chemin, f]));
  const extraits = new Set();
  const hArchive = crypto.createHash('sha256');

  async function* concatener() {
    for (const m of manifeste.morceaux) {
      for await (const b of fs.createReadStream(path.join(dossierMorceaux, m.nom))) {
        hArchive.update(b);
        yield b;
      }
    }
  }

  let tampon = Buffer.alloc(0);
  let enCours = null; // { fh, reste, bourrage, h, attendu }
  let blocsNuls = 0;
  let fin = false;

  async function ouvrirEntree(entete) {
    const { chemin: brut, taille, type } = lireEntete(entete);
    if (type === '1' || type === '2') {
      throw new ErreurMaj('LIEN_INTERDIT', `Lien refusé dans le paquet : « ${brut} ».`, { chemin: brut });
    }
    if (type !== '0' && type !== '5') {
      throw new ErreurMaj('TYPE_INTERDIT', `Type d'entrée tar refusé (${type}) : « ${brut} ».`, { chemin: brut });
    }
    const chemin = type === '5' ? brut.replace(/\/+$/, '') : brut;
    const probleme = problemeChemin(chemin);
    if (probleme) throw new ErreurMaj('CHEMIN_INTERDIT', `${probleme} : « ${brut} ».`, { chemin: brut });
    const cible = cheminSur(racine, chemin);
    if (type === '5') {
      if (taille !== 0) throw new ErreurMaj('ARCHIVE_INVALIDE', `Dossier de taille non nulle : « ${chemin} ».`);
      await fsp.mkdir(cible, { recursive: true });
      return;
    }
    const attendu = attendus.get(chemin);
    if (!attendu) throw new ErreurMaj('FICHIER_INATTENDU', `Fichier absent du manifeste : « ${chemin} ».`, { chemin });
    if (extraits.has(chemin)) throw new ErreurMaj('FICHIER_EN_DOUBLE', `Fichier présent deux fois : « ${chemin} ».`, { chemin });
    if (taille !== attendu.taille) {
      throw new ErreurMaj('FICHIER_CORROMPU', `Taille inattendue pour « ${chemin} ».`, { chemin, attendu: attendu.taille, obtenu: taille });
    }
    extraits.add(chemin);
    await fsp.mkdir(path.dirname(cible), { recursive: true });
    // 'wx' : jamais d'écrasement silencieux (deux noms qui ne diffèrent que
    // par la casse tomberaient sur le même fichier Windows).
    const fh = await fsp.open(cible, 'wx');
    enCours = { fh, reste: taille, bourrage: (BLOC - (taille % BLOC)) % BLOC, h: crypto.createHash('sha256'), attendu };
    if (taille === 0) await fermerEntree();
  }

  async function fermerEntree() {
    const { fh, h, attendu } = enCours;
    await fh.close();
    if (h.digest('hex') !== attendu.sha256) {
      throw new ErreurMaj('FICHIER_CORROMPU', `Empreinte incorrecte pour « ${attendu.chemin} ».`, { chemin: attendu.chemin });
    }
    enCours.fh = null;
  }

  try {
    await pipeline(Readable.from(concatener()), zlib.createGunzip(), lire);
  } finally {
    // Sur Windows, un fichier resté ouvert empêcherait de supprimer le
    // dossier de préparation après un échec.
    if (enCours && enCours.fh) await enCours.fh.close().catch(() => {});
  }

  async function lire(source) {
    for await (const morceau of source) {
      tampon = tampon.length ? Buffer.concat([tampon, morceau]) : morceau;
      while (tampon.length > 0) {
        if (enCours && enCours.reste > 0) {
          const part = tampon.subarray(0, enCours.reste);
          await enCours.fh.write(part);
          enCours.h.update(part);
          enCours.reste -= part.length;
          tampon = tampon.subarray(part.length);
          if (enCours.reste === 0) await fermerEntree();
          continue;
        }
        if (enCours && enCours.bourrage > 0) {
          const n = Math.min(enCours.bourrage, tampon.length);
          enCours.bourrage -= n;
          tampon = tampon.subarray(n);
          continue;
        }
        enCours = null;
        if (tampon.length < BLOC) break;
        const entete = tampon.subarray(0, BLOC);
        tampon = tampon.subarray(BLOC);
        if (fin) {
          if (entete.some((o) => o !== 0)) throw new ErreurMaj('ARCHIVE_INVALIDE', 'Données après la fin de l’archive.');
          continue;
        }
        if (entete.every((o) => o === 0)) {
          blocsNuls += 1;
          if (blocsNuls === 2) fin = true;
          continue;
        }
        if (blocsNuls > 0) throw new ErreurMaj('ARCHIVE_INVALIDE', 'Bloc nul isolé au milieu de l’archive.');
        await ouvrirEntree(entete);
      }
    }
  }

  if (!fin) throw new ErreurMaj('ARCHIVE_TRONQUEE', 'Archive du paquet incomplète.');
  if (hArchive.digest('hex') !== manifeste.archive.sha256) {
    throw new ErreurMaj('MORCEAU_CORROMPU', 'Empreinte de l’archive complète incorrecte.');
  }
  const manquants = manifeste.fichiers.filter((f) => !extraits.has(f.chemin)).map((f) => f.chemin);
  if (manquants.length > 0) {
    throw new ErreurMaj('FICHIER_MANQUANT', `Fichiers du manifeste absents de l'archive : ${manquants.slice(0, 5).join(', ')}.`, { manquants });
  }
}

// --------------------------------------------------------------------------
// Revérification d'un arbre déjà extrait (lanceur, juste avant d'installer)
// --------------------------------------------------------------------------

/**
 * Recontrôle un dossier préparé contre le manifeste : chaque fichier listé
 * présent avec la bonne taille et le bon SHA-256, aucun lien, aucun fichier
 * en trop (sauf chemins de premier niveau listés dans `ignorer`, ex.
 * `node_modules` posé à côté). Lève une ErreurMaj au premier écart.
 */
async function verifierArbre(dossier, manifeste, { ignorer = [] } = {}) {
  const attendus = new Map(manifeste.fichiers.map((f) => [f.chemin, f]));
  const ignores = new Set(ignorer);
  const trouves = new Set();

  async function parcourir(absolu, relatif) {
    for (const e of await fsp.readdir(absolu, { withFileTypes: true })) {
      const rel = relatif ? `${relatif}/${e.name}` : e.name;
      if (!relatif && ignores.has(e.name)) continue;
      const abs = path.join(absolu, e.name);
      if (e.isSymbolicLink()) throw new ErreurMaj('LIEN_INTERDIT', `Lien trouvé dans la version préparée : « ${rel} ».`, { chemin: rel });
      if (e.isDirectory()) await parcourir(abs, rel);
      else if (e.isFile()) {
        const attendu = attendus.get(rel);
        if (!attendu) throw new ErreurMaj('FICHIER_INATTENDU', `Fichier en trop dans la version préparée : « ${rel} ».`, { chemin: rel });
        const st = await fsp.stat(abs);
        if (st.size !== attendu.taille || (await sha256Fichier(abs)) !== attendu.sha256) {
          throw new ErreurMaj('FICHIER_CORROMPU', `Fichier modifié depuis la préparation : « ${rel} ».`, { chemin: rel });
        }
        trouves.add(rel);
      } else {
        throw new ErreurMaj('TYPE_INTERDIT', `Entrée spéciale dans la version préparée : « ${rel} ».`, { chemin: rel });
      }
    }
  }

  await parcourir(path.resolve(dossier), '');
  const manquants = manifeste.fichiers.filter((f) => !trouves.has(f.chemin)).map((f) => f.chemin);
  if (manquants.length > 0) {
    throw new ErreurMaj('FICHIER_MANQUANT', `Fichiers manquants dans la version préparée : ${manquants.slice(0, 5).join(', ')}.`, { manquants });
  }
}

module.exports = {
  TAILLE_MORCEAU_DEFAUT,
  ecrireArchive,
  verifierMorceaux,
  extraireArchive,
  verifierArbre,
  // exposés pour les tests (fabrication d'archives piégées)
  _enteteFichier: enteteFichier,
};
