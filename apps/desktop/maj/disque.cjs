'use strict';
// Petites primitives disque partagées par les modules de mise à jour.
// Tout ce qui doit survivre à une coupure de courant passe par
// `ecrireJsonAtomique` : sur un mini-PC sans onduleur, un fichier à moitié
// écrit au moment de la coupure est le cas normal, pas l'exception.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Renommage retenté : sur Windows, Defender (ou l'indexeur) garde parfois un
 * fichier ouvert quelques centaines de millisecondes juste après son écriture,
 * et `rename` échoue en EPERM/EBUSY/EACCES. Le plan exclut d'ajouter une
 * exclusion Defender : on retente donc, avec un délai croissant.
 */
async function renommerAvecReprises(source, cible, { essais = 8, delaiMs = 100 } = {}) {
  for (let i = 1; ; i++) {
    try {
      await fsp.rename(source, cible);
      return;
    } catch (e) {
      const passager = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!passager || i >= essais) throw e;
      await attendre(delaiMs * i);
    }
  }
}

/**
 * Écrit un JSON de façon atomique : fichier temporaire, fsync, renommage par
 * dessus l'ancien, puis fsync du dossier quand le système le permet. Après une
 * coupure, on lit donc SOIT l'ancienne version complète, SOIT la nouvelle —
 * jamais un fichier tronqué.
 */
async function ecrireJsonAtomique(chemin, objet) {
  const temporaire = `${chemin}.${process.pid}.tmp`;
  const contenu = `${JSON.stringify(objet, null, 2)}\n`;
  const fh = await fsp.open(temporaire, 'w');
  try {
    await fh.writeFile(contenu, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await renommerAvecReprises(temporaire, chemin);
  // fsync du dossier : garantit que le renommage lui-même est sur disque
  // (POSIX). Windows refuse d'ouvrir un dossier en écriture ; NTFS journalise
  // de toute façon les métadonnées, l'échec est donc sans conséquence.
  try {
    const dossier = await fsp.open(path.dirname(chemin), 'r');
    try { await dossier.sync(); } finally { await dossier.close(); }
  } catch { /* Windows : sans objet */ }
}

/** SHA-256 hexadécimal d'un fichier, en flux (les paquets de dépendances pèsent des centaines de Mo). */
function sha256Fichier(chemin) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(chemin)
      .on('data', (b) => h.update(b))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function sha256(octets) {
  return crypto.createHash('sha256').update(octets).digest('hex');
}

module.exports = { ecrireJsonAtomique, renommerAvecReprises, sha256Fichier, sha256, attendre };
