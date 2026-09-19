import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  construireEntreesJournee,
  construireParametresDecision,
  explicationUtile,
  lignesExpliquees,
} from './siege-inventaire.ts';

describe('inventaire siège — entrées de la journée', () => {
  test('réunit les réceptions POS et SamerTrackly sans perdre les entrées agrégées', () => {
    const entrees = construireEntreesJournee([
      {
        id: 'shift-pos', restaurant_id: 'r1', date: '2026-09-15', type_shift: 'matin',
        caissier_id: 'u1', pos_service_id: 'service-1',
        entrees_shift: [
          {
            id: 'e1', inventaire_id: 'shift-pos', produit_id: 'p1', produit_nom: 'Pain',
            quantite: '3', fournisseur_nom: 'Boulangerie', source: 'reception',
            created_at: '2026-09-15T08:00:00Z',
          },
        ],
        inventaire_lignes: [
          { id: 'l1', produit_id: 'p1', produit_nom: 'Pain', entrees: '3' },
          { id: 'l2', produit_id: 'b7', produit_nom: 'Darina', entrees: '5' },
        ],
      },
      {
        id: 'shift-st', restaurant_id: 'r2', date: '2026-09-15', type_shift: 'soir',
        caissier_id: 'u2', pos_service_id: null,
        entrees_shift: [
          {
            id: 'e2', inventaire_id: 'shift-st', produit_id: 'p2', produit_nom: 'Poulet',
            quantite: 4, fournisseur_nom: null, source: 'reception', created_at: null,
          },
        ],
        inventaire_lignes: [],
      },
    ]);

    assert.deepEqual(
      entrees.map((entree) => ({
        id: entree.id,
        produit: entree.produit_nom,
        quantite: entree.quantite,
        fournisseur: entree.fournisseur_nom,
        origine: entree.origine,
      })),
      [
        { id: 'e1', produit: 'Pain', quantite: 3, fournisseur: 'Boulangerie', origine: 'POS' },
        { id: 'ligne:shift-pos:b7', produit: 'Darina', quantite: 5, fournisseur: null, origine: 'POS' },
        { id: 'e2', produit: 'Poulet', quantite: 4, fournisseur: null, origine: 'SAMERTRACKLY' },
      ],
    );
  });

  test('ne double pas une entrée déjà détaillée et ignore les quantités nulles', () => {
    const entrees = construireEntreesJournee([
      {
        id: 'shift-1', restaurant_id: 'r1', date: '2026-09-15', type_shift: 'matin',
        caissier_id: null, pos_service_id: 'service-1',
        entrees_shift: [
          {
            id: 'e1', inventaire_id: 'shift-1', produit_id: 'p1', produit_nom: 'Pain',
            quantite: 2, fournisseur_nom: null, source: null, created_at: null,
          },
        ],
        inventaire_lignes: [
          { id: 'l1', produit_id: 'p1', produit_nom: 'Pain', entrees: 2 },
          { id: 'l2', produit_id: 'p2', produit_nom: 'Poulet', entrees: 0 },
        ],
      },
    ]);

    assert.deepEqual(entrees.map((entree) => entree.id), ['e1']);
  });

  test('garde l’agrégat positif quand le détail correspondant est nul', () => {
    const entrees = construireEntreesJournee([
      {
        id: 'shift-1', restaurant_id: 'r1', date: '2026-09-15', type_shift: 'matin',
        caissier_id: null, pos_service_id: 'service-1',
        entrees_shift: [
          {
            id: 'e-nulle', inventaire_id: 'shift-1', produit_id: 'p1', produit_nom: 'Pain',
            quantite: 0, fournisseur_nom: null, source: null, created_at: null,
          },
        ],
        inventaire_lignes: [
          { id: 'l1', produit_id: 'p1', produit_nom: 'Pain', entrees: 3 },
        ],
      },
    ]);

    assert.deepEqual(
      entrees.map((entree) => ({ id: entree.id, quantite: entree.quantite })),
      [{ id: 'ligne:shift-1:p1', quantite: 3 }],
    );
  });
});

describe('inventaire siège — sélection', () => {
  test('ne garde que les lignes portant une explication utile', () => {
    const lignes = lignesExpliquees([
      { id: 'a', explication: '  Produit renversé  ', nombre_explique: '1' },
      { id: 'b', explication: '   ', nombre_explique: '0' },
      { id: 'c', explication: null, nombre_explique: '2' },
    ]);
    assert.deepEqual(lignes.map((ligne) => ligne.id), ['a', 'c']);
    assert.equal(lignes[0]?.explication, 'Produit renversé');
  });

  test('une quantité expliquée positive suffit même sans texte', () => {
    assert.equal(explicationUtile({ explication: null, nombre_explique: 0.5 }), true);
    assert.equal(explicationUtile({ explication: null, nombre_explique: 0 }), false);
  });
});

describe('inventaire siège — décision RPC', () => {
  test('le prix vient du snapshot serveur', () => {
    assert.deepEqual(
      construireParametresDecision({ ligneId: 'l1', statut: 'refusee', prixSnapshot: '8000', auteur: 'Samer' }),
      { p_ligne_id: 'l1', p_statut: 'refusee', p_quantite_acceptee: null, p_prix: 8000, p_par: 'Samer' },
    );
  });

  test('refuse un statut ou un prix invalide', () => {
    assert.throws(
      () => construireParametresDecision({ ligneId: 'l1', statut: 'autre', prixSnapshot: 8000, auteur: 'Samer' }),
      /Décision invalide/,
    );
    assert.throws(
      () => construireParametresDecision({ ligneId: 'l1', statut: 'validee', prixSnapshot: -1, auteur: 'Samer' }),
      /Prix produit invalide/,
    );
  });
});
