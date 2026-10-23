'use strict';
// Trousseau de clés publiques EMBARQUÉ (fichier cles-publiques.json, à côté).
//
// Le lanceur lit la copie qui est dans l'asar de PosSamer.exe : c'est elle qui
// fait foi, un paquet ne peut donc pas apporter la clé qui le valide. Le
// serveur lit la copie de son arbre `app/` (même fichier, livré avec le code)
// pour PRÉPARER une version ; le lanceur revérifie de toute façon avant
// d'installer.
//
// Tant que le propriétaire n'a pas généré sa paire (scripts/maj/generer-cle.mjs),
// « actuelle » est vide : la mise à jour à distance est alors DÉSACTIVÉE, avec
// un motif lisible au siège — jamais un paquet accepté sans vérification.
const fs = require('node:fs');
const path = require('node:path');
const { chargerClePublique } = require('./signature.cjs');

const FICHIER_CLES = 'cles-publiques.json';
const CHEMIN_DEFAUT = path.join(__dirname, FICHIER_CLES);

const MOTIF_SANS_CLE =
  'Mise à jour à distance désactivée : aucune clé publique de signature n’est installée dans ce programme.';

/**
 * Renvoie `{ trousseau: { actuelle, suivante } | null, motif: string | null }`.
 * `trousseau` null = mise à jour désactivée (`motif` dit pourquoi). Ne lève jamais.
 */
function chargerTrousseau(chemin = CHEMIN_DEFAUT) {
  let brut;
  try {
    brut = JSON.parse(fs.readFileSync(chemin, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { trousseau: null, motif: `${MOTIF_SANS_CLE} (fichier ${FICHIER_CLES} absent ou illisible)` };
  }
  const actuelle = typeof brut.actuelle === 'string' ? brut.actuelle.trim() : '';
  const suivante = typeof brut.suivante === 'string' ? brut.suivante.trim() : '';
  if (!actuelle) return { trousseau: null, motif: MOTIF_SANS_CLE };
  try {
    chargerClePublique(actuelle);
    if (suivante) chargerClePublique(suivante);
  } catch (e) {
    return { trousseau: null, motif: `Mise à jour à distance désactivée : clé publique illisible (${e.message}).` };
  }
  return { trousseau: { actuelle, suivante: suivante || null }, motif: null };
}

module.exports = { FICHIER_CLES, MOTIF_SANS_CLE, chargerTrousseau };
