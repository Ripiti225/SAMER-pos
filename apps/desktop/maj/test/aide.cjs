'use strict';
// Outils communs aux tests des fondations de mise à jour.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** Dossier temporaire supprimé à la fin du test. */
function dossierTemp(t, nom = 'maj') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pos-${nom}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const sha = (texte) => crypto.createHash('sha256').update(texte).digest('hex');

/** Manifeste APP valide minimal ; `modifs` écrase des champs. */
function manifesteApp(modifs = {}) {
  return {
    format: 1,
    type: 'APP',
    numero: 42,
    version: '2026.10.23-1',
    commit: 'abc1234def',
    publie_le: '2026-10-23T05:00:00.000Z',
    lanceur_min: 1,
    node_min: '22.0.0',
    dependances: { empreinte: sha('pnpm-lock') },
    migrations: { derniere: '0043_stock_plats_reference', nouvelles: ['0043_stock_plats_reference'], retrocompatibles: true },
    notes: 'Correction du ticket Z.',
    archive: { sha256: sha('archive'), taille: 300 },
    morceaux: [
      { nom: 'paquet-42.tar.gz.000', sha256: sha('m0'), taille: 200 },
      { nom: 'paquet-42.tar.gz.001', sha256: sha('m1'), taille: 100 },
    ],
    fichiers: [
      { chemin: 'apps/server/src/index.ts', sha256: sha('index'), taille: 10 },
      { chemin: 'VERSION.json', sha256: sha('version'), taille: 5 },
    ],
    ...modifs,
  };
}

module.exports = { dossierTemp, sha, manifesteApp };
