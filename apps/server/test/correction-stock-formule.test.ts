import { describe, expect, it } from 'vitest';
import { effetCorrectionSortant } from '@pos/shared';

const ligne = (stock_compte: number, quantite_expliquee = 0) => ({
  stock_initial: 10,
  entrees: 0,
  sorties: 0,
  stock_compte,
  quantite_expliquee,
});

describe('effetCorrectionSortant', () => {
  it('annule un surplus sans ouvrir de litige', () => {
    expect(effetCorrectionSortant(ligne(12), 10)).toMatchObject({ ecart_avant: 2, ecart_apres: 0, litige: false });
  });
  it('un surplus qui devient manquant ouvre un litige', () => {
    expect(effetCorrectionSortant(ligne(12), 9)).toMatchObject({ ecart_apres: -1, manque_apres: 1, litige: true });
  });
  it('un stock juste qui devient manquant ouvre un litige', () => {
    expect(
      effetCorrectionSortant({ stock_initial: 14, entrees: 0, sorties: 0, stock_compte: 14, quantite_expliquee: 0 }, 12),
    ).toMatchObject({ ecart_avant: 0, ecart_apres: -2, manque_apres: 2, litige: true });
  });
  it('annule un manquant sans ouvrir de litige', () => {
    expect(effetCorrectionSortant(ligne(8), 10)).toMatchObject({ ecart_avant: -2, ecart_apres: 0, manque_apres: 0, litige: false });
  });
  it('une explication de surplus ne couvre pas un manquant neuf', () => {
    expect(effetCorrectionSortant(ligne(12, 2), 9)).toMatchObject({ manque_apres: 1, litige: true });
  });
  it('une explication de manquant reste acquise', () => {
    expect(effetCorrectionSortant(ligne(8, 2), 8)).toMatchObject({ manque_avant: 0, manque_apres: 0, litige: false });
    expect(effetCorrectionSortant(ligne(8, 2), 7)).toMatchObject({ manque_apres: 1, litige: true });
  });
});
