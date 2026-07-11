import type { TypeCommande, CarteKds } from '@pos/shared';

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

  /**
   * Énonce la commande à haute voix : "Commande 925 - un demi braisé, une
   * pizza royale grande, un nems". Utilise Web Speech API (navigateur).
   */
  enoncerCommande(carte: CarteKds): void {
    if (this.muet) return;
    try {
      const texte = this.construireTexteCommande(carte);
      const utterance = new SpeechSynthesisUtterance(texte);
      utterance.lang = 'fr-FR';
      utterance.rate = 0.95; // légèrement plus lent pour clarté
      speechSynthesis.cancel(); // annule annonces précédentes (ne pas empiler)
      speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('Énoncé commande impossible', e);
    }
  }

  private construireTexteCommande(carte: CarteKds): string {
    const plats = carte.items
      .filter((i) => i.statut_cuisine !== 'ANNULE')
      .map((i) => `${this.pluraliser(i.quantite, i.nom_snapshot.toLowerCase())}`)
      .join(', ');
    return `Commande ${carte.numero_ticket} : ${plats}`;
  }

  /** Pluralise un nom : 1 → "un nems", 2+ → "deux nems". */
  private pluraliser(quantite: number, nom: string): string {
    if (quantite === 1) {
      const article = 'aeiouyàâäéèêëïîôöœuù'.includes(nom[0]!) ? "un'" : 'un';
      return `${article} ${nom}`;
    }
    return `${quantite} ${nom}${nom.endsWith('s') ? '' : 's'}`;
  }

  private jouer(src: string): void {
    if (this.muet) return;
    // L'autoplay est débloqué par le clic de connexion (interaction utilisateur)
    void new Audio(src).play().catch(() => undefined);
  }
}

export const sons = new GestionnaireSons();
