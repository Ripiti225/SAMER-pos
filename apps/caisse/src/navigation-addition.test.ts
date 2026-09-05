import { describe, expect, it } from 'vitest';
import { destinationAddition } from './navigation-addition';

describe('navigation depuis une demande d’addition', () => {
  it('ouvre la commande de la table sans démarrer le paiement', () => {
    expect(destinationAddition({ commande_id: 'commande-1' })).toEqual({
      ecran: 'commande', commandeId: 'commande-1',
    });
  });

  it('revient au plan de salle si la commande a disparu', () => {
    expect(destinationAddition({ commande_id: null })).toEqual({ ecran: 'tables', commandeId: null });
  });
});
