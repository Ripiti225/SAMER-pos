/**
 * Page santé — voyant Internet/Synchro (§D). Lecture seule ; la caisse (pastille
 * discrète) et le manager lisent le MÊME état, source unique côté serveur.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { etatSync } from '../sync/etat.js';
import { compterEnAttente } from '../sync/montee.js';
import { moteurSync } from '../sync/moteur.js';

/** État de synchro renvoyé à la caisse (source unique). */
async function etatSynchro() {
  const enAttente = await compterEnAttente().catch(() => etatSync.lignes_en_attente);
  etatSync.majEnAttente(enAttente);
  return {
    voyant: etatSync.voyant(),
    lignes_en_attente: enAttente,
    dernier_acquittement: etatSync.dernier_acquittement?.toISOString() ?? null,
    derniere_erreur: etatSync.derniere_erreur,
    derniere_reconciliation: etatSync.derniere_reconciliation,
  };
}

export function routesSante(app: FastifyInstance): void {
  /**
   * Readiness — « le POS peut-il servir ? », pas seulement « le processus
   * répond-il ? ». La route touche VRAIMENT la base : sans ça, un serveur
   * debout mais coupé de PostgreSQL répondait `ok` et la coquille kiosque
   * affichait une caisse **blanche, sans aucune donnée**, sans le moindre
   * message — le symptôme est indiscernable d'un plantage.
   *
   * `SELECT 1` sur le pool : deux secondes de garde pour ne pas laisser la
   * fenêtre attendre sur une base qui ne répond plus (machine sortie de veille,
   * PostgreSQL redémarré sous l'app). 503 = pas prêt → la coquille réessaie,
   * puis affiche son écran d'erreur en français.
   */
  app.get('/api/sante', async (_req, reponse) => {
    try {
      await Promise.race([
        db.execute(sql`SELECT 1`),
        new Promise((_, rejeter) => setTimeout(() => rejeter(new Error('délai dépassé')), 2000)),
      ]);
      return { ok: true, base: true };
    } catch (e) {
      return reponse.code(503).send({
        ok: false,
        base: false,
        message: 'La base de données ne répond pas',
        detail: (e as Error).message,
      });
    }
  });

  // État de synchronisation détaillé (tout utilisateur connecté)
  app.get('/api/sante/synchro', { preHandler: app.exigerAuth }, async () => etatSynchro());

  // Déclenchement MANUEL d'une montée (bouton « Synchroniser maintenant »).
  // Ne bloque jamais une vente ; renvoie l'état de synchro rafraîchi.
  app.post('/api/sante/synchro/forcer', { preHandler: app.exigerAuth }, async () => {
    const r = await moteurSync.synchroniserMaintenant();
    return { ...(await etatSynchro()), synchro_active: r.actif };
  });
}
