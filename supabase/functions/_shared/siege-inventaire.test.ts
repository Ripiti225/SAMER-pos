import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  construireParametresDecision,
  explicationUtile,
  lignesExpliquees,
} from './siege-inventaire.ts';

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
