'use strict';
// Point d'entrée unique des fondations de la mise à jour à distance (lot L0).
//
// Modules CommonJS sans aucune dépendance : le MÊME code sert
// - au lanceur Electron (`require('./maj/index.cjs')` depuis main.js, copie
//   embarquée dans l'asar de PosSamer.exe — c'est cette copie, avec la clé
//   publique du lanceur, qui fait foi pour vérifier un paquet) ;
// - au serveur (TypeScript ESM sous tsx) via apps/server/src/modules/maj/fondations.ts.
// Les types sont dans index.d.cts.
module.exports = {
  ...require('./erreurs.cjs'),
  ...require('./version.cjs'),
  ...require('./signature.cjs'),
  ...require('./manifeste.cjs'),
  ...require('./archive.cjs'),
  ...require('./creneau.cjs'),
  ...require('./installation.cjs'),
  ...require('./retention.cjs'),
  ...require('./disque.cjs'),
  // Lot L4 : clés embarquées, dossier du site, opérations disque, orchestration.
  ...require('./cles.cjs'),
  ...require('./site.cjs'),
  ...require('./operations.cjs'),
  ...require('./lanceur.cjs'),
};
