import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, ne, sql } from 'drizzle-orm';
import { MODES_PAIEMENT, type ModePaiement } from '@pos/shared';
import { db } from '../../db/client.js';
import { commandeItems, commandes, paiements, servicesCaisse } from '../../db/schema/index.js';

function debutDuJour(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function routesRapports(app: FastifyInstance): void {
  const gardeManager = app.exigerRole('MANAGER', 'PROPRIETAIRE');

  // Ventes du jour (tous services confondus) — manager / propriétaire
  app.get('/api/rapports/jour', { preHandler: gardeManager }, async () => {
    const depuis = debutDuJour();
    const lignes = await db
      .select()
      .from(commandes)
      .where(and(gte(commandes.created_at, depuis), eq(commandes.statut, 'PAYEE')));

    const parModeLignes = await db
      .select({ mode: paiements.mode, total: sql<string>`SUM(${paiements.montant})` })
      .from(paiements)
      .where(gte(paiements.created_at, depuis))
      .groupBy(paiements.mode);
    const parMode = Object.fromEntries(MODES_PAIEMENT.map((m) => [m, 0])) as Record<ModePaiement, number>;
    for (const l of parModeLignes) parMode[l.mode] = Number(l.total);

    const parType: Record<string, { nb: number; total: number }> = {};
    for (const c of lignes) {
      const entree = (parType[c.type] ??= { nb: 0, total: 0 });
      entree.nb += 1;
      entree.total += c.total;
    }

    return {
      date: depuis.toISOString().slice(0, 10),
      nb_commandes: lignes.length,
      total_ventes: lignes.reduce((s, c) => s + c.total, 0),
      total_remises: lignes.reduce((s, c) => s + c.remise_montant, 0),
      total_promos: lignes.reduce((s, c) => s + c.promo_montant, 0),
      par_mode: parMode,
      par_type: parType,
    };
  });

  // Top plats du jour — manager / propriétaire
  app.get('/api/rapports/top-plats', { preHandler: gardeManager }, async () => {
    const depuis = debutDuJour();
    const top = await db
      .select({
        nom: commandeItems.nom_snapshot,
        quantite: sql<string>`SUM(${commandeItems.quantite})`,
        total: sql<string>`SUM(${commandeItems.prix_unitaire} * ${commandeItems.quantite})`,
      })
      .from(commandeItems)
      .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
      .where(
        and(
          gte(commandes.created_at, depuis),
          eq(commandes.statut, 'PAYEE'),
          ne(commandeItems.statut_cuisine, 'ANNULE'),
        ),
      )
      .groupBy(commandeItems.nom_snapshot)
      .orderBy(sql`SUM(${commandeItems.quantite}) DESC`)
      .limit(10);
    return top.map((t) => ({ nom: t.nom, quantite: Number(t.quantite), total: Number(t.total) }));
  });

  // Ventes par heure du jour — manager / propriétaire
  app.get('/api/rapports/par-heure', { preHandler: gardeManager }, async () => {
    const depuis = debutDuJour();
    const lignes = await db
      .select({
        heure: sql<string>`EXTRACT(HOUR FROM ${commandes.created_at})`,
        nb: sql<string>`COUNT(*)`,
        total: sql<string>`SUM(${commandes.total})`,
      })
      .from(commandes)
      .where(and(gte(commandes.created_at, depuis), eq(commandes.statut, 'PAYEE')))
      .groupBy(sql`EXTRACT(HOUR FROM ${commandes.created_at})`)
      .orderBy(sql`EXTRACT(HOUR FROM ${commandes.created_at})`);
    return lignes.map((l) => ({ heure: Number(l.heure), nb: Number(l.nb), total: Number(l.total) }));
  });

  /**
   * « Mes ventes » du caissier connecté : liste de ses commandes du service
   * en cours. Pas de total espèces ni de théorique — le comptage reste aveugle.
   */
  app.get('/api/rapports/mes-ventes', { preHandler: app.exigerAuth }, async (req) => {
    const [service] = await db
      .select()
      .from(servicesCaisse)
      .where(
        and(eq(servicesCaisse.caissier_id, req.session!.utilisateur_id), eq(servicesCaisse.statut, 'OUVERT')),
      );
    if (!service) return { service: null, commandes: [] };

    const lignes = await db
      .select({
        id: commandes.id,
        numero_ticket: commandes.numero_ticket,
        type: commandes.type,
        statut: commandes.statut,
        total: commandes.total,
        created_at: commandes.created_at,
      })
      .from(commandes)
      .where(eq(commandes.service_id, service.id))
      .orderBy(desc(commandes.created_at));

    return {
      service: { id: service.id, ouvert_le: service.ouvert_le.toISOString() },
      commandes: lignes.map((l) => ({
        ...l,
        numero_ticket: Number(l.numero_ticket),
        created_at: l.created_at.toISOString(),
      })),
      nb_payees: lignes.filter((l) => l.statut === 'PAYEE').length,
      total_payees: lignes.filter((l) => l.statut === 'PAYEE').reduce((s, l) => s + l.total, 0),
    };
  });
}
