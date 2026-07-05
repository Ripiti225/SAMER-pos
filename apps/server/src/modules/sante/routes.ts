/**
 * Page santé — voyant Internet/Synchro (§D). Lecture seule ; la caisse (pastille
 * discrète) et le manager lisent le MÊME état, source unique côté serveur.
 */
import type { FastifyInstance } from 'fastify';
import { and, gte, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pointages } from '../../db/schema/index.js';
import { etatSync } from '../sync/etat.js';
import { compterEnAttente } from '../sync/montee.js';

export function routesSante(app: FastifyInstance): void {
  // Liveness simple (déjà utilisé par le harnais / les PWA)
  app.get('/api/sante', async () => ({ ok: true }));

  // État de synchronisation détaillé (tout utilisateur connecté)
  app.get('/api/sante/synchro', { preHandler: app.exigerAuth }, async () => {
    // Recompte les lignes en attente à la volée (juste même si le moteur dort).
    const enAttente = await compterEnAttente().catch(() => etatSync.lignes_en_attente);
    etatSync.majEnAttente(enAttente);
    const voyant = etatSync.voyant();

    // Sprint 4 A4 : alerte départs oubliés du jour (non corrigés)
    const debut = new Date();
    debut.setHours(0, 0, 0, 0);
    const [oublies] = await db
      .select({ n: sql<string>`COUNT(*)` })
      .from(pointages)
      .where(and(gte(pointages.arrivee, debut), eq(pointages.depart_oublie, true)));

    return {
      voyant, // { couleur: 'vert'|'orange'|'rouge', message }
      lignes_en_attente: enAttente,
      dernier_acquittement: etatSync.dernier_acquittement?.toISOString() ?? null,
      derniere_erreur: etatSync.derniere_erreur,
      derniere_reconciliation: etatSync.derniere_reconciliation,
      pointages_oublies: Number(oublies?.n ?? 0),
    };
  });
}
