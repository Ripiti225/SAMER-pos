/**
 * Vue « reçu » d'une sous-note.
 *
 * Un paiement individuel doit sortir comme un VRAI reçu : même logo, même
 * entête, mêmes tailles de caractères, même pied de page qu'un ticket complet.
 * Seul le contenu change — les articles et les règlements de la personne
 * concernée, et rien de ceux des autres convives.
 *
 * Le moyen le plus sûr d'y arriver est de ne pas réécrire une mise en page :
 * on fabrique une `CommandeVue` restreinte à la sous-note et on la donne au
 * générateur de ticket habituel. Toute évolution du reçu profite alors aux deux
 * sans qu'on y pense. Fonction PURE, partagée entre l'ESC/POS et le PDF.
 */
import type { CommandeVue, NoteSplitVue } from './types.js';

export function vueSousNote(commande: CommandeVue, note: NoteSplitVue): CommandeVue {
  const parId = new Map(commande.items.map((item) => [item.id, item]));
  return {
    ...commande,
    sous_total: note.sous_total,
    promo_montant: note.promo_montant,
    remise_montant: note.remise_montant,
    fidelite_montant: note.fidelite_montant,
    client_fidelite_id: note.client_fidelite_id,
    total: note.montant,
    paye: note.paye,
    reste: note.reste,
    paiements: note.paiements,
    items: note.items.map((allocation) => {
      const source = parId.get(allocation.commande_item_id)!;
      return {
        ...source,
        quantite: allocation.quantite,
        quantite_reservee: 0,
        quantite_payee: allocation.quantite,
        quantite_disponible: 0,
        total_ligne: allocation.montant_brut,
      };
    }),
  };
}

/** Titre du reçu d'un paiement individuel : « RECU - PAIEMENT 2 ». */
export function titreRecuSousNote(note: NoteSplitVue): string {
  return `RECU - PAIEMENT ${note.numero}`;
}
