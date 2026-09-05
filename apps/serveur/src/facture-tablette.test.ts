import { describe, expect, it } from 'vitest';
import { lignesFactureNumerique } from './facture-tablette';

describe('facture numérique de la tablette serveur', () => {
  it('affiche les produits vendables, leurs options, suppléments et montants', () => {
    const lignes = lignesFactureNumerique({
      items: [
        {
          id: '1', nom_snapshot: 'Poulet braisé', prix_unitaire: 8_000, quantite: 2,
          total_ligne: 17_000,
          statut_cuisine: 'EN_PREPARATION', supplements: [{ nom: 'Attiéké', prix: 500 }],
          options: [{ groupe: 'Cuisson', choix: ['Bien cuit'] }],
        },
        {
          id: '2', nom_snapshot: 'Ancienne ligne', prix_unitaire: 1_000, quantite: 1,
          total_ligne: 0,
          statut_cuisine: 'ANNULE', supplements: [], options: [],
        },
      ],
    });

    expect(lignes).toEqual([{
      id: '1', nom: 'Poulet braisé', quantite: 2, prix_unitaire: 8_000,
      total: 17_000, supplements: ['Attiéké (+500 F)'], options: ['Cuisson : Bien cuit'],
    }]);
  });
});
