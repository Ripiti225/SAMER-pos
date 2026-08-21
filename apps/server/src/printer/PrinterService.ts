import type { CommandeItemVue, CommandeVue, PosteImpression, RapportSequence, RapportZ } from '@pos/shared';

/**
 * Interface d'impression. Implémentations : ConsolePrinter (repli/dev) et
 * EscposPrinter (thermique réel, routé par poste).
 */
export interface PrinterService {
  /** Facture / addition AVANT paiement (pas de lignes de règlement). */
  imprimerFacture(commande: CommandeVue): Promise<void>;
  imprimerTicket(commande: CommandeVue): Promise<void>;
  imprimerRapportZ(rapport: RapportZ): Promise<void>;
  /**
   * Récapitulatif de fin de journée remis au gérant quand il rase la séquence :
   * une ligne de synthèse par shift, puis les totaux consolidés.
   */
  imprimerRapportSequence(rapport: RapportSequence): Promise<void>;
  /**
   * Bon de préparation : à l'envoi en cuisine, imprime sur l'imprimante du
   * poste (CUISINE/BAR/CAISSE) uniquement les articles routés vers ce poste.
   * Pas de prix — c'est un bon de production, il accompagne la commande.
   */
  imprimerBon(commande: CommandeVue, poste: PosteImpression, items: CommandeItemVue[]): Promise<void>;
}
