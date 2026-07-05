/**
 * État runtime de la synchro pour la page santé (§D). Singleton en mémoire :
 * ne stocke aucune donnée métier, seulement l'observabilité.
 */
export type CouleurVoyant = 'vert' | 'orange' | 'rouge';

export interface ReconciliationVue {
  jour: string;
  statut: 'OK' | 'ECART';
  ecart: number;
  quand: string;
}

class EtatSync {
  dernier_acquittement: Date | null = null;
  lignes_en_attente = 0;
  derniere_erreur: string | null = null;
  echecs_consecutifs = 0;
  premier_echec: Date | null = null;
  revoque = false;
  derniere_reconciliation: ReconciliationVue | null = null;

  succesMontee(lignesRestantes: number): void {
    this.dernier_acquittement = new Date();
    this.lignes_en_attente = lignesRestantes;
    this.derniere_erreur = null;
    this.echecs_consecutifs = 0;
    this.premier_echec = null;
    this.revoque = false;
  }

  echecMontee(message: string, revoque = false): void {
    this.derniere_erreur = message;
    this.echecs_consecutifs += 1;
    this.revoque = revoque;
    if (!this.premier_echec) this.premier_echec = new Date();
  }

  majEnAttente(n: number): void {
    this.lignes_en_attente = n;
  }

  /**
   * Voyant Internet/Synchro (§15.3) :
   *  vert   = dernier acquittement < 5 min ;
   *  rouge  = clé révoquée, écart de réconciliation, ou erreurs > 24 h ;
   *  orange = hors ligne / en attente (les ventes continuent normalement).
   */
  voyant(): { couleur: CouleurVoyant; message: string } {
    if (this.revoque) {
      return { couleur: 'rouge', message: 'Site révoqué — contactez le siège pour réactiver la clé' };
    }
    if (this.derniere_reconciliation?.statut === 'ECART') {
      return { couleur: 'rouge', message: 'Écart de réconciliation — vérification requise' };
    }
    const erreurAncienne =
      this.premier_echec && Date.now() - this.premier_echec.getTime() > 24 * 3600 * 1000;
    if (erreurAncienne) {
      return { couleur: 'rouge', message: 'Synchro en échec depuis plus de 24 h — vérifiez internet' };
    }
    const recent =
      this.dernier_acquittement && Date.now() - this.dernier_acquittement.getTime() < 5 * 60 * 1000;
    if (recent && this.lignes_en_attente === 0) {
      return { couleur: 'vert', message: 'Synchronisé' };
    }
    if (this.lignes_en_attente > 0 || this.derniere_erreur) {
      return {
        couleur: 'orange',
        message: `Hors ligne — ${this.lignes_en_attente} vente(s) en attente, les ventes continuent normalement`,
      };
    }
    return { couleur: 'vert', message: 'Synchronisé' };
  }
}

export const etatSync = new EtatSync();
