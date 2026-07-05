import type { TypeCommande } from '@pos/shared';

/**
 * Sons différenciés (§A3) : un fichier par type de commande + une alerte
 * pour les cartes passées en rouge. Le mute se réactive seul après 30 min.
 */
const FICHIERS: Record<TypeCommande, string> = {
  SUR_PLACE: '/sons/sur-place.wav',
  EMPORTER: '/sons/emporter.wav',
  LIVRAISON: '/sons/livraison.wav',
};

const DUREE_MUTE_MS = 30 * 60 * 1000;

class GestionnaireSons {
  private muetJusqua = 0;

  get muet(): boolean {
    return Date.now() < this.muetJusqua;
  }

  basculerMute(): boolean {
    this.muetJusqua = this.muet ? 0 : Date.now() + DUREE_MUTE_MS;
    return this.muet;
  }

  nouvelleCommande(type: TypeCommande): void {
    this.jouer(FICHIERS[type]);
  }

  alerteRetard(): void {
    this.jouer('/sons/alerte.wav');
  }

  private jouer(src: string): void {
    if (this.muet) return;
    // L'autoplay est débloqué par le clic de connexion (interaction utilisateur)
    void new Audio(src).play().catch(() => undefined);
  }
}

export const sons = new GestionnaireSons();
