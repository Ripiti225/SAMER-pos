/**
 * Page santé — voyant Internet/Synchro (§D). Lecture seule ; la caisse (pastille
 * discrète) et le manager lisent le MÊME état, source unique côté serveur.
 */
import type { FastifyInstance } from 'fastify';
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
  // Liveness simple (déjà utilisé par le harnais / les PWA)
  app.get('/api/sante', async () => ({ ok: true }));

  // État de synchronisation détaillé (tout utilisateur connecté)
  app.get('/api/sante/synchro', { preHandler: app.exigerAuth }, async () => etatSynchro());

  // Déclenchement MANUEL d'une montée (bouton « Synchroniser maintenant »).
  // Ne bloque jamais une vente ; renvoie l'état de synchro rafraîchi.
  app.post('/api/sante/synchro/forcer', { preHandler: app.exigerAuth }, async () => {
    const r = await moteurSync.synchroniserMaintenant();
    return { ...(await etatSynchro()), synchro_active: r.actif };
  });
}
