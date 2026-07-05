/**
 * Moteur de synchronisation : deux boucles de fond (montée, descente) +
 * purge quotidienne de l'outbox. Indépendant du reste : une panne de synchro
 * ne bloque JAMAIS une vente. Démarré depuis index.ts uniquement (pas en test).
 */
import { chargerConfigSync, prochainBackoff } from './config.js';
import { ClientCloud, ErreurSync } from './cloud-client.js';
import { compterEnAttente, pousserUnLot, purgerOutbox } from './montee.js';
import { tirerCatalogue } from './descente.js';
import { etatSync } from './etat.js';

export class MoteurSync {
  private client: ClientCloud | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private arrete = false;

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
  }

  arreter(): void {
    this.arrete = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private planifier(fn: () => void, delai: number): void {
    if (this.arrete) return;
    this.timers.push(setTimeout(fn, delai));
  }

  /** Vide la file par lots jusqu'à épuisement ou premier échec. */
  private async cycleMontee(): Promise<void> {
    for (;;) {
      const r = await pousserUnLot(this.client!);
      if (r.fini) break;
      // Pas de progrès (ligne bloquante en tête) → on stoppe pour ne pas boucler.
      if (r.acquitte_jusqua_seq === 0) break;
    }
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
