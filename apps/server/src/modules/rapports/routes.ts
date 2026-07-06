import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte, ne, sql } from 'drizzle-orm';
import { MODES_PAIEMENT, type ModePaiement } from '@pos/shared';
import { db } from '../../db/client.js';
import { commandeItems, commandes, notations, paiements, servicesCaisse, utilisateurs } from '../../db/schema/index.js';

function debutDuJour(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function debutIlYaJours(jours: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (jours - 1));
  return d;
}

export function routesRapports(app: FastifyInstance): void {
  const gardeManager = app.exigePermission('rapports.z');
  const gardeProprio = app.exigePermission('rapports.tableau_bord');

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

  /**
   * C3 — Tableau de bord PROPRIÉTAIRE (lecture LOCALE uniquement) : CA, tickets,
   * panier moyen, ventes par heure, top 10 plats, répartition par mode, écarts
   * de caisse par caissier, sur le jour ou une période glissante 7/30 jours.
   */
  app.get('/api/rapports/tableau-bord', { preHandler: gardeProprio }, async (req) => {
    const q = (req.query as { periode?: string }).periode ?? 'jour';
    const depuis = q === '7' ? debutIlYaJours(7) : q === '30' ? debutIlYaJours(30) : debutDuJour();

    const [payees, parModeLignes, parHeure, top, ecarts] = await Promise.all([
      db.select({ total: commandes.total, type: commandes.type }).from(commandes)
        .where(and(gte(commandes.created_at, depuis), eq(commandes.statut, 'PAYEE'))),
      db.select({ mode: paiements.mode, total: sql<string>`SUM(${paiements.montant})` }).from(paiements)
        .where(gte(paiements.created_at, depuis)).groupBy(paiements.mode),
      db.select({ heure: sql<string>`EXTRACT(HOUR FROM ${commandes.created_at})`, total: sql<string>`SUM(${commandes.total})` }).from(commandes)
        .where(and(gte(commandes.created_at, depuis), eq(commandes.statut, 'PAYEE')))
        .groupBy(sql`EXTRACT(HOUR FROM ${commandes.created_at})`).orderBy(sql`EXTRACT(HOUR FROM ${commandes.created_at})`),
      db.select({ nom: commandeItems.nom_snapshot, quantite: sql<string>`SUM(${commandeItems.quantite})`, total: sql<string>`SUM(${commandeItems.prix_unitaire} * ${commandeItems.quantite})` })
        .from(commandeItems).innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
        .where(and(gte(commandes.created_at, depuis), eq(commandes.statut, 'PAYEE'), ne(commandeItems.statut_cuisine, 'ANNULE')))
        .groupBy(commandeItems.nom_snapshot).orderBy(sql`SUM(${commandeItems.quantite}) DESC`).limit(10),
      db.select({ nom: utilisateurs.nom_complet, ecart: sql<string>`SUM(${servicesCaisse.ecart})`, nb: sql<string>`COUNT(*)` })
        .from(servicesCaisse).innerJoin(utilisateurs, eq(utilisateurs.id, servicesCaisse.caissier_id))
        .where(and(eq(servicesCaisse.statut, 'CLOTURE'), gte(servicesCaisse.ouvert_le, depuis)))
        .groupBy(utilisateurs.nom_complet),
    ]);

    const parMode = Object.fromEntries(MODES_PAIEMENT.map((m) => [m, 0])) as Record<ModePaiement, number>;
    for (const l of parModeLignes) parMode[l.mode] = Number(l.total);
    const ca = payees.reduce((s, c) => s + c.total, 0);

    return {
      periode: q,
      depuis: depuis.toISOString().slice(0, 10),
      ca,
      tickets: payees.length,
      panier_moyen: payees.length ? Math.round(ca / payees.length) : 0,
      par_mode: parMode,
      par_heure: parHeure.map((h) => ({ heure: Number(h.heure), total: Number(h.total) })),
      top_plats: top.map((t) => ({ nom: t.nom, quantite: Number(t.quantite), total: Number(t.total) })),
      ecarts_par_caissier: ecarts.map((e) => ({ nom: e.nom, ecart: Number(e.ecart), nb_services: Number(e.nb) })),
    };
  });

  /** C4 — Récap notation (manager) : moyennes 7/30 j + dernières mauvaises notes. */
  app.get('/api/rapports/notations', { preHandler: app.exigePermission('rapports.notation') }, async () => {
    const calcul = async (jours: number) => {
      const depuis = debutIlYaJours(jours);
      const [r] = await db
        .select({
          cuisine: sql<string>`AVG(${notations.cuisine})`,
          service: sql<string>`AVG(${notations.service})`,
          ambiance: sql<string>`AVG(${notations.ambiance})`,
          nb: sql<string>`COUNT(*)`,
        })
        .from(notations)
        .where(gte(notations.created_at, depuis));
      return {
        cuisine: r?.cuisine ? Number(Number(r.cuisine).toFixed(2)) : null,
        service: r?.service ? Number(Number(r.service).toFixed(2)) : null,
        ambiance: r?.ambiance ? Number(Number(r.ambiance).toFixed(2)) : null,
        nb: Number(r?.nb ?? 0),
      };
    };
    const mauvaises = await db
      .select({ cuisine: notations.cuisine, service: notations.service, ambiance: notations.ambiance, commentaire: notations.commentaire, created_at: notations.created_at })
      .from(notations)
      .where(and(gte(notations.created_at, debutIlYaJours(30)), lte(notations.cuisine, 2)))
      .orderBy(desc(notations.created_at))
      .limit(10);
    return {
      moyennes_7j: await calcul(7),
      moyennes_30j: await calcul(30),
      dernieres_mauvaises: mauvaises.map((m) => ({ ...m, created_at: m.created_at.toISOString() })),
    };
  });
}
