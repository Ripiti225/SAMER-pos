// ──────────────────────────────────────────────────────────────────────────────
// Tests de samtrackly-inventaire.ts — conversion inventaire POS → Samtrackly.
//
// Deuxième partie du pont qui manipule de l'argent (après samtrackly-shift.ts) :
// une erreur ici déduit un montant faux sur la paie d'un caissier.
//
// Exécution locale : node --test supabase/functions/_shared/samtrackly-inventaire.test.ts
// ──────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  typeShiftDe,
  construireInventaireShift,
  construireLignesInventaire,
  construireEntreesShift,
  correspondanceRompue,
} from './samtrackly-inventaire.ts';

describe('typeShiftDe — le créneau le plus proche', () => {
  test('08:00 pile → matin', () => {
    assert.equal(typeShiftDe('08:00'), 'matin');
  });

  test('16:00 pile → soir', () => {
    assert.equal(typeShiftDe('16:00'), 'soir');
  });

  test('00:05 → nuit (le plus proche de minuit)', () => {
    assert.equal(typeShiftDe('00:05'), 'nuit');
  });

  test('23:50 → nuit malgré la distance en horloge murale (proximité circulaire à minuit)', () => {
    assert.equal(typeShiftDe('23:50'), 'nuit');
  });

  test('12:00 pile → double', () => {
    assert.equal(typeShiftDe('12:00'), 'double');
  });

  test('égalité exacte (10:00, à 2h de matin et de double) → le créneau le plus matinal l’emporte', () => {
    assert.equal(typeShiftDe('10:00'), 'matin');
  });

  test('heure absente → repli sur matin, jamais une exception', () => {
    assert.equal(typeShiftDe(null), 'matin');
  });

  test('heure mal formée → repli sur matin, jamais une exception', () => {
    assert.equal(typeShiftDe('pas une heure'), 'matin');
  });
});

describe('construireInventaireShift — la ligne d’en-tête', () => {
  const CTX = {
    pointId: 'point-1',
    restaurantId: 'resto-1',
    caissierId: 'user-1',
    date: '2026-08-19',
    heureDebut: '16:00',
    heureFin: '00:00',
    posServiceId: 'svc-1',
  };

  test('validé normalement → montant_a_deduire reprend le manquant du POS', () => {
    const inv = { id: 'inv-1', valide: true, debloque_par: null, montant_manquant: 3_500 };
    const ligne = construireInventaireShift(inv, CTX);
    assert.equal(ligne.montant_a_deduire, 3_500);
    assert.equal(ligne.valide, true);
    assert.equal(ligne.pos_service_id, 'svc-1');
    assert.equal(ligne.type_shift, 'soir');
  });

  test('débloqué par un manager → montant_a_deduire à zéro, même si le POS a un manquant chiffré', () => {
    const inv = { id: 'inv-1', valide: false, debloque_par: 'mgr-1', montant_manquant: 7_000 };
    const ligne = construireInventaireShift(inv, CTX);
    assert.equal(ligne.montant_a_deduire, 0, 'un comptage admis incomplet par un manager ne doit jamais déduire');
  });

  test('valide ET débloqué en même temps (état impossible en théorie, non protégé par une CHECK en base) → traité comme débloqué, par prudence', () => {
    const inv = { id: 'inv-1', valide: true, debloque_par: 'mgr-1', montant_manquant: 7_000 };
    const ligne = construireInventaireShift(inv, CTX);
    assert.equal(ligne.montant_a_deduire, 0);
  });
});

describe('construireLignesInventaire — le détail par produit', () => {
  test('produit_id devient le code, pas l’uuid POS', () => {
    const lignes = [
      { produit_id: 'uuid-p1', produit_code: 'p1', produit_nom: 'Pain chawarma', produit_prix: 2_500, stock_initial: '10', entrees: '0', sorties: '8', stock_compte: '2', ecart: '0', quantite_expliquee: '0', explication: null },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(l.produit_id, 'p1');
    assert.equal(l.inventaire_id, 'inv-shift-1');
  });

  test('manquant non expliqué chiffré : même formule que calcul.ts (écart négatif − expliqué, jamais sous zéro, arrondi au FCFA)', () => {
    // po8 : écart −3, rien d'expliqué, prix 8000 → 3 × 8000 = 24 000
    const lignes = [
      { produit_id: 'uuid-po8', produit_code: 'po8', produit_nom: 'Total poulet', produit_prix: 8_000, stock_initial: '20', entrees: '0', sorties: '17', stock_compte: '17', ecart: '-3', quantite_expliquee: '0', explication: null },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(l.montant_deduit, 24_000);
  });

  test('une quantité expliquée réduit le manquant chiffré avant l’arrondi', () => {
    // écart −3, 1 unité expliquée → 2 restantes × 8000 = 16 000
    const lignes = [
      { produit_id: 'uuid-po8', produit_code: 'po8', produit_nom: 'Total poulet', produit_prix: 8_000, stock_initial: '20', entrees: '0', sorties: '17', stock_compte: '17', ecart: '-3', quantite_expliquee: '1', explication: 'cassé' },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(l.montant_deduit, 16_000);
  });

  test('un surplus (écart positif) ne déduit jamais rien', () => {
    const lignes = [
      { produit_id: 'uuid-p1', produit_code: 'p1', produit_nom: 'Pain chawarma', produit_prix: 2_500, stock_initial: '10', entrees: '0', sorties: '5', stock_compte: '6', ecart: '1', quantite_expliquee: '0', explication: null },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(l.montant_deduit, 0);
  });

  test('inventaire débloqué → montant_deduit à zéro sur toutes les lignes, même avec un écart réel', () => {
    const lignes = [
      { produit_id: 'uuid-po8', produit_code: 'po8', produit_nom: 'Total poulet', produit_prix: 8_000, stock_initial: '20', entrees: '0', sorties: '17', stock_compte: '17', ecart: '-3', quantite_expliquee: '0', explication: null },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', false);
    assert.equal(l.montant_deduit, 0);
  });

  test('une explication avec écart réel → explication_statut en_attente, MÊME sur un inventaire débloqué', () => {
    const lignes = [
      { produit_id: 'uuid-po8', produit_code: 'po8', produit_nom: 'Total poulet', produit_prix: 8_000, stock_initial: '20', entrees: '0', sorties: '17', stock_compte: '17', ecart: '-3', quantite_expliquee: '1', explication: 'cassé' },
    ];
    const [validee] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    const [debloquee] = construireLignesInventaire(lignes, 'inv-shift-1', false);
    assert.equal(validee.explication_statut, 'en_attente');
    assert.equal(debloquee.explication_statut, 'en_attente', 'le déblocage manager évite la retenue automatique, pas la revue du vérificateur');
  });

  test('un écart nul avec une explication ne déclenche pas la revue (rien à revoir)', () => {
    const lignes = [
      { produit_id: 'uuid-p1', produit_code: 'p1', produit_nom: 'Pain chawarma', produit_prix: 2_500, stock_initial: '10', entrees: '0', sorties: '10', stock_compte: '10', ecart: '0', quantite_expliquee: '0', explication: 'texte sans objet' },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(l.explication_statut, undefined);
  });

  test('sans explication et sans écart → pas de statut du tout', () => {
    const lignes = [
      { produit_id: 'uuid-p1', produit_code: 'p1', produit_nom: 'Pain chawarma', produit_prix: 2_500, stock_initial: '10', entrees: '0', sorties: '10', stock_compte: '10', ecart: '0', quantite_expliquee: '0', explication: null },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(l.explication_statut, undefined);
  });

  test('une ligne sans snapshot (montée par un site pas encore migré) est écartée plutôt que de faire planter le transfert', () => {
    const lignes = [
      { produit_id: 'uuid-vieux', produit_code: null, produit_nom: null, produit_prix: null, stock_initial: '1', entrees: '0', sorties: '1', stock_compte: '0', ecart: '0', quantite_expliquee: '0', explication: null },
    ];
    const resultat = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(resultat.length, 0);
  });

  test('le prix figé sur la ligne l’emporte : un changement de catalogue après coup ne rechiffre pas un manquant déjà compté', () => {
    const lignes = [
      { produit_id: 'uuid-po8', produit_code: 'po8', produit_nom: 'Total poulet', produit_prix: 8_000, stock_initial: '20', entrees: '0', sorties: '17', stock_compte: '17', ecart: '-2', quantite_expliquee: '0', explication: null },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(l.montant_deduit, 16_000);
  });

  test('entrees est reprise telle quelle depuis la ligne figée du POS', () => {
    const lignes = [
      { produit_id: 'uuid-p1', produit_code: 'p1', produit_nom: 'Pain chawarma', produit_prix: 2_500, stock_initial: '10', entrees: '5', sorties: '8', stock_compte: '7', ecart: '0', quantite_expliquee: '0', explication: null },
    ];
    const [l] = construireLignesInventaire(lignes, 'inv-shift-1', true);
    assert.equal(l.entrees, 5);
  });
});

describe('construireEntreesShift — les réceptions détaillées', () => {
  test('une entrée normale devient une ligne entrees_shift avec le code produit', () => {
    const entrees = [{ produit_id: 'uuid-p1', produit_code: 'p1', produit_nom: 'Pain chawarma', produit_prix: 2_500, quantite: '20', fournisseur: 'Boulangerie Awa' }];
    const [l] = construireEntreesShift(entrees, 'inv-shift-1');
    assert.equal(l.produit_id, 'p1');
    assert.equal(l.produit_nom, 'Pain chawarma');
    assert.equal(l.quantite, 20);
    assert.equal(l.fournisseur_nom, 'Boulangerie Awa');
    assert.equal(l.fournisseur_id, null, 'le POS n’a qu’un texte libre, jamais un id fournisseur Samtrackly');
    assert.equal(l.source, 'reception');
    assert.equal(l.inventaire_id, 'inv-shift-1');
  });

  test('le produit Darina (b7) est exclu : son entrée vit dans inventaire_lignes.entrees, pas ici', () => {
    const entrees = [
      { produit_id: 'uuid-p1', produit_code: 'p1', produit_nom: 'Pain chawarma', produit_prix: 2_500, quantite: '20', fournisseur: null },
      { produit_id: 'uuid-b7', produit_code: 'b7', produit_nom: 'Darina', quantite: '4', fournisseur: null },
    ];
    const resultat = construireEntreesShift(entrees, 'inv-shift-1');
    assert.equal(resultat.length, 1);
    assert.equal(resultat[0].produit_id, 'p1');
  });

  test('un fournisseur absent devient null, jamais une chaîne vide', () => {
    const entrees = [{ produit_id: 'uuid-p1', produit_code: 'p1', produit_nom: 'Pain chawarma', produit_prix: 2_500, quantite: '3', fournisseur: null }];
    const [l] = construireEntreesShift(entrees, 'inv-shift-1');
    assert.equal(l.fournisseur_nom, null);
  });
});

describe('correspondanceRompue — le garde-fou du 2026-08-21', () => {
  test('34 lignes comptées, 0 traduite → rompue (site pas encore migré, aucun snapshot)', () => {
    assert.equal(correspondanceRompue(34, 0), true);
  });

  test('34 comptées, 33 traduites → normale : une ligne isolée sans snapshot s’écarte sans drame', () => {
    assert.equal(correspondanceRompue(34, 33), false);
  });

  test('34 comptées, 34 traduites → normale', () => {
    assert.equal(correspondanceRompue(34, 34), false);
  });

  test('aucune ligne comptée → PAS rompue : il n’y avait rien à traduire', () => {
    assert.equal(correspondanceRompue(0, 0), false);
  });
});
