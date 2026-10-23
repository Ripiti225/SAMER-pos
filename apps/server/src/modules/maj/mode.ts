/**
 * Mode du serveur vis-à-vis de la mise à jour (contrat § 5) :
 *
 * - NORMAL : tout fonctionne ;
 * - VALIDATION : démarrage juste après l'échange de code
 *   (`POS_MODE_VALIDATION=1`). Aucune boucle de fond (synchro, ordres,
 *   SamerTrackly, mise à jour), et toute l'API répond 503 sauf `/api/sante*`
 *   et `/api/maj/*` : le lanceur contrôle la santé de la nouvelle version sans
 *   qu'une seule vente puisse être enregistrée — si elle est refusée, la base
 *   est restaurée et une vente faite entre-temps serait perdue ;
 * - ARRET : le lanceur a annoncé l'installation. Même filtre que VALIDATION ;
 *   la route d'arrêt attend la fin des requêtes déjà commencées (un paiement
 *   en cours va au bout) avant de rendre la main.
 *
 * Les fichiers de la caisse (HTML, JS) restent servis : le contrôle de santé
 * vérifie justement que la page de la caisse est servie, et sans API derrière
 * elle n'enregistre rien.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type ModeServeur = 'NORMAL' | 'VALIDATION' | 'ARRET';

export const MESSAGE_MAJ_EN_COURS = 'Mise à jour en cours — la caisse revient dans 2 à 3 minutes';

class EtatMode {
  mode: ModeServeur = process.env.POS_MODE_VALIDATION === '1' ? 'VALIDATION' : 'NORMAL';
  private enCours = 0;
  private attentes: (() => void)[] = [];

  entrer(): void {
    this.enCours += 1;
  }

  sortir(): void {
    this.enCours = Math.max(0, this.enCours - 1);
    if (this.enCours === 0) {
      for (const r of this.attentes.splice(0)) r();
    }
  }

  private enAttenteDeValidation: (() => void)[] = [];

  /**
   * Lance `fn` tout de suite en mode NORMAL, sinon à la sortie du mode
   * validation (boucles de synchro, d'ordres, SamerTrackly, mise à jour).
   */
  quandNormal(fn: () => void): void {
    if (this.mode === 'NORMAL') fn();
    else this.enAttenteDeValidation.push(fn);
  }

  /** Sortie du mode validation (route `/api/maj/lanceur/valider`). Idempotent. */
  valider(): boolean {
    if (this.mode !== 'VALIDATION') return false;
    this.mode = 'NORMAL';
    for (const fn of this.enAttenteDeValidation.splice(0)) {
      try {
        fn();
      } catch (e) {
        console.error('Démarrage après validation :', e);
      }
    }
    return true;
  }

  get requetesEnCours(): number {
    return this.enCours;
  }

  /** Résout quand plus aucune requête d'API n'est en cours (ou après `delaiMs`). */
  attendreRequetesFinies(delaiMs: number): Promise<boolean> {
    if (this.enCours === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const minuteur = setTimeout(() => resolve(false), delaiMs);
      this.attentes.push(() => {
        clearTimeout(minuteur);
        resolve(true);
      });
    });
  }
}

export const etatMode = new EtatMode();

/** Routes toujours servies, même pendant une mise à jour. */
function exemptee(url: string): boolean {
  return url.startsWith('/api/sante') || url.startsWith('/api/maj/');
}

declare module 'fastify' {
  interface FastifyRequest {
    compteeMaj?: boolean;
  }
}

export function enregistrerModeMaj(app: FastifyInstance): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    const url = req.url;
    if (!url.startsWith('/api/') || exemptee(url)) return;
    if (etatMode.mode !== 'NORMAL') {
      return reply.code(503).header('retry-after', '60').send({ erreur: MESSAGE_MAJ_EN_COURS, maj_en_cours: true });
    }
    req.compteeMaj = true;
    etatMode.entrer();
  });
  const liberer = async (req: FastifyRequest) => {
    if (req.compteeMaj) {
      req.compteeMaj = false;
      etatMode.sortir();
    }
  };
  app.addHook('onResponse', liberer);
  app.addHook('onRequestAbort', liberer);
}
