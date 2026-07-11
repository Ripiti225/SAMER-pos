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
import { hier, reconcilierJour } from './reconcile.js';
import { etatSync } from './etat.js';

export class MoteurSync {
  private client: ClientCloud | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private tacheReconcile: ScheduledTask | null = null;
  private arrete = false;
  private monteeEnCours = false;

  async demarrer(): Promise<void> {
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

    // Réconciliation quotidienne à 03h00 (heure locale du mini-PC).
    this.tacheReconcile = schedule('0 3 * * *', () => {
      void reconcilierJour(this.client!, hier()).catch((e) => console.error('Réconciliation:', e));
    });
  }

  arreter(): void {
    this.arrete = true;
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
        // Pas de progrès (ligne bloquante en tête) → on stoppe pour ne pas boucler.
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
