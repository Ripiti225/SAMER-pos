/**
 * Son d'alerte caisse (correction 2) : joué à chaque demande d'addition.
 * Le mute est possible mais se réactive SEUL après 15 min — la caisse ne
 * doit jamais rester muette par oubli.
 */
const DUREE_MUTE_MS = 15 * 60 * 1000;

class SonsCaisse {
  private muetJusqua = 0;
  private dernieresLectures = new Set<string>();

  get muet(): boolean {
    return Date.now() < this.muetJusqua;
  }

  basculerMute(): boolean {
    this.muetJusqua = this.muet ? 0 : Date.now() + DUREE_MUTE_MS;
    return this.muet;
  }

  /** Joue le son d'addition une seule fois par événement (clé de déduplication). */
  additionDemandee(cleEvenement: string): void {
    if (this.dernieresLectures.has(cleEvenement)) return;
    this.dernieresLectures.add(cleEvenement);
    if (this.dernieresLectures.size > 200) this.dernieresLectures.clear();
    if (this.muet) return;
    void new Audio('/sons/addition.mp3').play().catch(() => undefined);
  }
}

export const sons = new SonsCaisse();
