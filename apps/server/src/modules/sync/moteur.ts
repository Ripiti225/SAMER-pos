/**
 * Moteur de synchronisation : deux boucles de fond (montée, descente) +
 * purge quotidienne de l'outbox. Indépendant du reste : une panne de synchro
 * ne bloque JAMAIS une vente. Démarré depuis index.ts uniquement (pas en test).
 */
import { schedule, type ScheduledTask } from 'node-cron';
import { chargerConfigSync, prochainBackoff } from './config.js';
import { ClientCloud, ErreurSync } from './cloud-client.js';
import { compterEnAttente, pousserUnLot, purgerOutbox } from './montee.js';
import { tirerCatalogue } from './descente.js';
import { executerOrdre, type EffetsOrdre } from './ordres.js';
import { hier, reconcilierJour } from './reconcile.js';
import { etatSync } from './etat.js';

export class MoteurSync {
  private client: ClientCloud | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private tacheReconcile: ScheduledTask | null = null;
  private arrete = false;
  private monteeEnCours = false;
  /**
   * Imprimante et diffusion temps réel, branchées au démarrage du serveur : le
   * moteur ne connaît pas Fastify, et un ordre du siège doit pourtant sortir le
   * papier du gérant. Sans elles, la boucle d'ordres ne démarre pas — un script
   * qui lance le moteur hors serveur n'exécutera donc aucun ordre, ce qui est
   * exactement ce qu'on veut.
   */
  private effetsOrdres: EffetsOrdre | null = null;

  /** Synchro cloud réellement branchée sur ce poste (site enrôlé + URL). */
  get actif(): boolean {
    return this.client !== null;
  }

  /** À appeler AVANT `demarrer()` (voir index.ts). */
  brancherOrdres(effets: EffetsOrdre): void {
    this.effetsOrdres = effets;
  }

  async demarrer(): Promise<void> {
    this.arrete = false; // redémarrage possible après un arreter() (ré-enrôlement)
    const cfg = await chargerConfigSync();
    if (!cfg.actif || !cfg.url || !cfg.cleSite) {
      console.log('Synchro cloud désactivée (SUPABASE_SYNC_URL / CLE_SITE manquants).');
      return;
    }
    this.client = new ClientCloud(cfg.url, cfg.cleSite);
    etatSync.majEnAttente(await compterEnAttente().catch(() => 0));
    console.log('Synchro cloud activée.');

    this.boucleMontee(cfg.intervalleMonteeMs);
    this.boucleDescente(cfg.intervalleDescenteMs);
    this.bouclePurge();
    // Cadence de la MONTÉE (30 s) et non de la descente : un gérant qui rase
    // depuis le siège ne va pas attendre cinq minutes devant sa caisse.
    if (this.effetsOrdres) this.boucleOrdres(cfg.intervalleMonteeMs);

    // Réconciliation quotidienne à 03h00 (heure locale du mini-PC).
    this.tacheReconcile = schedule('0 3 * * *', () => {
      void reconcilierJour(this.client!, hier()).catch((e) => console.error('Réconciliation:', e));
    });
  }

  /**
   * Stoppe les boucles ET oublie la clé de site : appelé aussi quand le poste
   * change d'identité (Réglages → Restaurant), où continuer à pousser avec
   * l'ancienne clé attribuerait les ventes au restaurant précédent.
   */
  arreter(): void {
    this.arrete = true;
    this.client = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.tacheReconcile?.stop();
    this.tacheReconcile = null;
  }

  private planifier(fn: () => void, delai: number): void {
    if (this.arrete) return;
    this.timers.push(setTimeout(fn, delai));
  }

  /** Vide la file par lots jusqu'à épuisement ou premier échec. */
  private async cycleMontee(): Promise<void> {
    // Garde anti-chevauchement : le déclenchement manuel ne double pas la boucle.
    if (this.monteeEnCours) return;
    this.monteeEnCours = true;
    try {
      for (;;) {
        const r = await pousserUnLot(this.client!);
        if (r.fini) break;
        // Garde-fou : un lot sans progrès lève désormais une ErreurSync (voir
        // montee.ts), donc on ne devrait jamais passer ici. On garde le break
        // pour qu'un cloud qui répondrait autrement ne fasse pas tourner la
        // boucle à vide.
        if (r.acquitte_jusqua_seq === 0) break;
      }
    } finally {
      this.monteeEnCours = false;
    }
  }

  /**
   * Déclenchement MANUEL d'une montée (bouton « Synchroniser maintenant »).
   * Ne fait rien si la synchro cloud est désactivée. Ne bloque jamais : les
   * erreurs sont enregistrées dans l'état de santé, pas propagées.
   */
  async synchroniserMaintenant(): Promise<{ actif: boolean; en_attente: number }> {
    if (!this.client) {
      const attente = await compterEnAttente().catch(() => etatSync.lignes_en_attente);
      return { actif: false, en_attente: attente };
    }
    try {
      await this.cycleMontee();
      etatSync.majEnAttente(await compterEnAttente().catch(() => 0));
    } catch (e) {
      const err = e instanceof ErreurSync ? e : new ErreurSync(String(e), 0);
      etatSync.echecMontee(err.message, err.estRevocation);
    }
    return { actif: true, en_attente: etatSync.lignes_en_attente };
  }

  private boucleMontee(base: number): void {
    const tick = async () => {
      let delai = base;
      try {
        await this.cycleMontee();
      } catch (e) {
        const err = e instanceof ErreurSync ? e : new ErreurSync(String(e), 0);
        etatSync.echecMontee(err.message, err.estRevocation);
        // Révocation : inutile de marteler, on garde l'intervalle de base.
        delai = err.estRevocation ? base : prochainBackoff(etatSync.echecs_consecutifs);
      }
      this.planifier(() => void tick(), delai);
    };
    this.planifier(() => void tick(), base);
  }

  private boucleDescente(base: number): void {
    const tick = async () => {
      try {
        await tirerCatalogue(this.client!);
      } catch {
        /* la descente n'est pas critique : on réessaie au prochain cycle */
      }
      this.planifier(() => void tick(), base);
    };
    this.planifier(() => void tick(), base);
  }

  /**
   * Va chercher les ordres du siège, les exécute, rend compte.
   *
   * Chaque ordre est traité indépendamment : un ordre qui échoue est acquitté
   * en ECHEC avec son motif — le siège doit voir POURQUOI — et le suivant est
   * traité quand même. Un acquittement qui n'arrive pas n'est pas grave :
   * `actions_recues` empêche la seconde exécution au prochain passage.
   */
  private boucleOrdres(base: number): void {
    const tick = async () => {
      try {
        const { ordres } = await this.client!.ordres();
        for (const ordre of ordres) {
          const acquittement = await executerOrdre(ordre, this.effetsOrdres!);
          if (!acquittement) continue; // déjà traité lors d'un passage précédent
          await this.client!
            .acquitterOrdre(ordre.id, acquittement.statut, {
              resultat: acquittement.resultat,
              erreur: acquittement.erreur,
            })
            .catch(() => {
              /* le siège le reverra EN_ATTENTE ; l'anti-doublon tiendra */
            });
        }
      } catch {
        /* cloud injoignable : on repassera. Rien de critique pour la caisse. */
      }
      this.planifier(() => void tick(), base);
    };
    this.planifier(() => void tick(), base);
  }

  private bouclePurge(): void {
    const tick = async () => {
      try {
        await purgerOutbox();
      } catch {
        /* sans conséquence */
      }
      this.planifier(() => void tick(), 24 * 3600 * 1000);
    };
    this.planifier(() => void tick(), 60_000); // 1re purge peu après le démarrage
  }
}

export const moteurSync = new MoteurSync();
