import type { CommandeVue, RapportZ } from '@pos/shared';

/**
 * Interface d'impression (§ périmètre sprint 1) : l'impression ESC/POS réelle
 * arrive dans un sprint ultérieur — seule cette interface est prévue,
 * avec l'implémentation ConsolePrinter.
 */
export interface PrinterService {
  /** Facture / addition AVANT paiement (pas de lignes de règlement). */
  imprimerFacture(commande: CommandeVue): Promise<void>;
  imprimerTicket(commande: CommandeVue): Promise<void>;
  imprimerRapportZ(rapport: RapportZ): Promise<void>;
}
