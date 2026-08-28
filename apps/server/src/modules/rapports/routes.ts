import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte, ne, notInArray, sql } from 'drizzle-orm';
import { MODES_PAIEMENT, type ModePaiement } from '@pos/shared';
import { db } from '../../db/client.js';
import { commandeItems, commandes, notations, noteSplitItems, notesSplit, paiements, servicesCaisse, utilisateurs } from '../../db/schema/index.js';
import { aPermission } from '../../plugins/sessions.js';
import { retoursDepuis, retoursDuService } from '../services/rapport.js';

function debutDuJour(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Retours d'un service, montants masqués si l'utilisateur n'a pas le Rapport X :
 * le caissier voit les plats refaits, pas le chiffre d'affaires.
 */
async function retoursServiceVisible(dbx: typeof db, serviceId: string, voitMontants: boolean) {
  const r = await retoursDuService(dbx, serviceId);
  if (voitMontants) return r;
  return {
    nb: r.nb,
    montant: 0,
    par_produit: r.par_produit.map((p) => ({ ...p, montant: 0 })),
    detail: r.detail.map((d) => ({ ...d, montant: 0 })),
  };
}

function debutIlYaJours(jours: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (jours - 1));
  return d;
}

/** Ventes reconnues une seule fois : commande historique, ou sous-note ARTICLES soldée. */
async function ventesAnalytiquesDepuis(depuis: Date) {
  const commandesArticles = await db
    .select({ commande_id: notesSplit.commande_id })
    .from(notesSplit)
    .where(eq(notesSplit.type, 'ARTICLES'));
  const ids = [...new Set(commandesArticles.map((note) => note.commande_id))];
  const historiques = await db
    .select({
      commande_id: commandes.id,
      total: commandes.total,
      remise: commandes.remise_montant,
      promo: commandes.promo_montant,
      type: commandes.type,
      reconnue_le: commandes.created_at,
    })
    .from(commandes)
    .where(and(
      gte(commandes.created_at, depuis),
      eq(commandes.statut, 'PAYEE'),
      ...(ids.length ? [notInArray(commandes.id, ids)] : []),
    ));
  const parArticles = await db
    .select({
      commande_id: notesSplit.commande_id,
      total: notesSplit.montant,
      remise: notesSplit.remise_montant,
      promo: notesSplit.promo_montant,
      type: commandes.type,
      reconnue_le: notesSplit.payee_le,
    })
    .from(notesSplit)
    .innerJoin(commandes, eq(commandes.id, notesSplit.commande_id))
    .where(and(eq(notesSplit.type, 'ARTICLES'), eq(notesSplit.statut, 'PAYEE'), gte(notesSplit.payee_le, depuis)));
  return [...historiques, ...parArticles].map((vente) => ({ ...vente, reconnue_le: vente.reconnue_le! }));
}

function compterTickets(ventes: { commande_id: string }[]): number {
  return new Set(ventes.map((vente) => vente.commande_id)).size;
}

async function topAnalytiqueDepuis(depuis: Date) {
  const commandesArticles = await db.select({ commande_id: notesSplit.commande_id }).from(notesSplit).where(eq(notesSplit.type, 'ARTICLES'));
  const ids = [...new Set(commandesArticles.map((note) => note.commande_id))];
  const historiques = await db
    .select({ nom: commandeItems.nom_snapshot, quantite: sql<string>`SUM(${commandeItems.quantite})`, total: sql<string>`SUM(${commandeItems.prix_unitaire} * ${commandeItems.quantite})` })
    .from(commandeItems)
    .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
    .where(and(gte(commandes.created_at, depuis), eq(commandes.statut, 'PAYEE'), ne(commandeItems.statut_cuisine, 'ANNULE'), ...(ids.length ? [notInArray(commandes.id, ids)] : [])))
    .groupBy(commandeItems.nom_snapshot);
  const articles = await db
    .select({ nom: commandeItems.nom_snapshot, quantite: sql<string>`SUM(${noteSplitItems.quantite})`, total: sql<string>`SUM(${noteSplitItems.montant_brut})` })
    .from(noteSplitItems)
    .innerJoin(notesSplit, eq(notesSplit.id, noteSplitItems.note_id))
    .innerJoin(commandeItems, eq(commandeItems.id, noteSplitItems.commande_item_id))
    .where(and(eq(notesSplit.type, 'ARTICLES'), eq(notesSplit.statut, 'PAYEE'), gte(notesSplit.payee_le, depuis)))
    .groupBy(commandeItems.nom_snapshot);
  const parNom = new Map<string, { nom: string; quantite: number; total: number }>();
  for (const ligne of [...historiques, ...articles]) {
    const valeur = parNom.get(ligne.nom) ?? { nom: ligne.nom, quantite: 0, total: 0 };
    valeur.quantite += Number(ligne.quantite);
    valeur.total += Number(ligne.total);
    parNom.set(ligne.nom, valeur);
  }
  return [...parNom.values()].sort((a, b) => b.quantite - a.quantite).slice(0, 10);
}

export function routesRapports(app: FastifyInstance): void {
  const gardeManager = app.exigePermission('rapports.z');
  const gardeProprio = app.exigePermission('rapports.tableau_bord');

  // Ventes du jour (tous services confondus) — manager / propriétaire
  app.get('/api/rapports/jour', { preHandler: gardeManager }, async () => {
    const depuis = debutDuJour();
    const lignes = await ventesAnalytiquesDepuis(depuis);

    const parModeLignes = await db
      .select({ mode: paiements.mode, total: sql<string>`SUM(${paiements.montant})` })
      .from(paiements)
      .where(gte(paiements.created_at, depuis))
      .groupBy(paiements.mode);
    const parMode = Object.fromEntries(MODES_PAIEMENT.map((m) => [m, 0])) as Record<ModePaiement, number>;
    for (const l of parModeLignes) parMode[l.mode] = Number(l.total);

    const parType: Record<string, { nb: number; total: number }> = {};
    const commandesParType = new Set<string>();
    for (const c of lignes) {
      const entree = (parType[c.type] ??= { nb: 0, total: 0 });
      const cleCommande = `${c.type}:${c.commande_id}`;
      if (!commandesParType.has(cleCommande)) {
        entree.nb += 1;
        commandesParType.add(cleCommande);
      }
      entree.total += c.total;
    }

    return {
      date: depuis.toISOString().slice(0, 10),
      nb_commandes: compterTickets(lignes),
      total_ventes: lignes.reduce((s, c) => s + c.total, 0),
      total_remises: lignes.reduce((s, c) => s + c.remise, 0),
      total_promos: lignes.reduce((s, c) => s + c.promo, 0),
      par_mode: parMode,
      par_type: parType,
    };
  });

  /**
   * BESOIN EN MONNAIE — combien de petites coupures le restaurant consomme
   * pour travailler, journée par journée.
   *
   * Le chiffre est la somme des monnaies rendues, regroupée sur la JOURNÉE
   * D'EXPLOITATION du shift (sa date d'ouverture), pas sur l'horloge : un
   * service 16h→01h reste une seule journée, comme partout ailleurs dans le
   * POS. Rendre la monnaie ne change ni la vente ni l'écart de caisse — le
   * billet entre dans le tiroir à l'instant où la monnaie en sort. Ce rapport
   * ne sert donc qu'à préparer le fond de monnaie du lendemain.
   *
   * `jours_traces` compte les journées qui portent vraiment la trace : avant
   * le 2026-08-28 le billet n'était pas saisi, et une journée à 0 F veut dire
   * « non renseigné », pas « aucune monnaie rendue ». La recommandation ne se
   * calcule que sur les journées tracées, sinon l'historique muet la tirerait
   * vers le bas.
   */
  app.get('/api/rapports/besoin-monnaie', { preHandler: gardeManager }, async (req) => {
    const demande = Number((req.query as { jours?: string }).jours ?? 14);
    const jours = Number.isFinite(demande) ? Math.min(90, Math.max(1, Math.trunc(demande))) : 14;
    const depuis = debutDuJour();
    depuis.setDate(depuis.getDate() - (jours - 1));

    const lignes = await db
      .select({
        journee: sql<string>`to_char(${servicesCaisse.ouvert_le}, 'YYYY-MM-DD')`,
        total: sql<string>`COALESCE(SUM(${paiements.monnaie_rendue}), 0)`,
        nb: sql<string>`COUNT(*) FILTER (WHERE ${paiements.monnaie_rendue} > 0)`,
        plus_gros: sql<string>`COALESCE(MAX(${paiements.monnaie_rendue}), 0)`,
      })
      .from(paiements)
      .innerJoin(servicesCaisse, eq(servicesCaisse.id, paiements.service_id))
      .where(gte(servicesCaisse.ouvert_le, depuis))
      .groupBy(sql`to_char(${servicesCaisse.ouvert_le}, 'YYYY-MM-DD')`)
      .orderBy(sql`to_char(${servicesCaisse.ouvert_le}, 'YYYY-MM-DD') DESC`);

    const parJour = lignes.map((l) => ({
      journee: l.journee,
      total: Number(l.total),
      nb: Number(l.nb),
      plus_gros: Number(l.plus_gros),
    }));
    const traces = parJour.filter((j) => j.nb > 0);
    const maximum = traces.reduce((m, j) => Math.max(m, j.total), 0);
    const moyenne = traces.length
      ? Math.round(traces.reduce((s, j) => s + j.total, 0) / traces.length)
      : 0;

    return {
      depuis: depuis.toISOString().slice(0, 10),
      jours,
      par_jour: parJour,
      jours_traces: traces.length,
      moyenne,
      maximum,
      // Le fond de monnaie se prépare en coupures, pas au franc près : on cale
      // sur la pire journée observée, arrondie au multiple de 5 000 F
      // supérieur. Tenir la moyenne laisserait la caisse à sec un jour sur deux.
      recommande: maximum > 0 ? Math.ceil(maximum / 5000) * 5000 : 0,
    };
  });

  // Top plats du jour — manager / propriétaire
  app.get('/api/rapports/top-plats', { preHandler: gardeManager }, async () => {
    const depuis = debutDuJour();
    return topAnalytiqueDepuis(depuis);
  });

  /**
   * RETOURS du jour (tous services) — articles déjà partis en cuisine puis
   * supprimés au PIN manager. Information seule : ils ne sont ni dans les
   * ventes, ni dans le tiroir, ni dans les sorties d'inventaire. C'est le
   * chiffre qui dit si un site refait souvent ses plats.
   */
  app.get('/api/rapports/retours-jour', { preHandler: gardeManager }, async () => {
    const depuis = debutDuJour();
    return { date: depuis.toISOString().slice(0, 10), ...(await retoursDepuis(db, depuis)) };
  });

  // Ventes par heure du jour — manager / propriétaire
  app.get('/api/rapports/par-heure', { preHandler: gardeManager }, async () => {
    const depuis = debutDuJour();
    const ventes = await ventesAnalytiquesDepuis(depuis);
    const parHeure = new Map<number, { heure: number; nb: number; total: number; commandes: Set<string> }>();
    for (const vente of ventes) {
      const heure = vente.reconnue_le.getHours();
      const ligne = parHeure.get(heure) ?? { heure, nb: 0, total: 0, commandes: new Set<string>() };
      if (!ligne.commandes.has(vente.commande_id)) {
        ligne.nb += 1;
        ligne.commandes.add(vente.commande_id);
      }
      ligne.total += vente.total;
      parHeure.set(heure, ligne);
    }
    return [...parHeure.values()]
      .sort((a, b) => a.heure - b.heure)
      .map(({ commandes: _commandes, ...ligne }) => ligne);
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
        code_commande: commandes.code_commande,
        type: commandes.type,
        statut: commandes.statut,
        total: commandes.total,
        created_at: commandes.created_at,
      })
      .from(commandes)
      .where(eq(commandes.service_id, service.id))
      .orderBy(desc(commandes.created_at));

    // Produits vendus du service (quantités, SANS montant) : pour l'inventaire
    // par le caissier, qui ne voit pas le chiffre d'affaires.
    const produits = await db
      .select({
        nom: commandeItems.nom_snapshot,
        quantite: sql<string>`SUM(${commandeItems.quantite})`,
      })
      .from(commandeItems)
      .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
      .where(
        and(
          eq(commandes.service_id, service.id),
          eq(commandes.statut, 'PAYEE'),
          ne(commandeItems.statut_cuisine, 'ANNULE'),
        ),
      )
      .groupBy(commandeItems.nom_snapshot)
      .orderBy(commandeItems.nom_snapshot);

    // Les montants (CA) ne sont envoyés QU'À qui a le Rapport X (manager/proprio).
    // Un caissier reçoit la liste des produits pour l'inventaire, sans argent.
    const voitMontants = await aPermission(req.session!, 'rapports.x');

    return {
      service: { id: service.id, ouvert_le: service.ouvert_le.toISOString() },
      commandes: lignes.map((l) => ({
        ...l,
        numero_ticket: Number(l.numero_ticket),
        created_at: l.created_at.toISOString(),
        total: voitMontants ? l.total : 0,
      })),
      produits: produits.map((p) => ({ nom: p.nom, quantite: Number(p.quantite) })),
      nb_payees: lignes.filter((l) => l.statut === 'PAYEE').length,
      total_payees: voitMontants ? lignes.filter((l) => l.statut === 'PAYEE').reduce((s, l) => s + l.total, 0) : undefined,
      // Retours du service en cours. Le caissier voit les QUANTITÉS (ce sont
      // les plats sortis de sa cuisine) ; les montants suivent la même règle
      // que le reste de l'écran — réservés au Rapport X.
      retours: await retoursServiceVisible(db, service.id, voitMontants),
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

    const [payees, top, parModeLignes, ecarts] = await Promise.all([
      ventesAnalytiquesDepuis(depuis),
      topAnalytiqueDepuis(depuis),
      db.select({ mode: paiements.mode, total: sql<string>`SUM(${paiements.montant})` }).from(paiements)
        .where(gte(paiements.created_at, depuis)).groupBy(paiements.mode),
      db.select({ nom: utilisateurs.nom_complet, ecart: sql<string>`SUM(${servicesCaisse.ecart})`, nb: sql<string>`COUNT(*)` })
        .from(servicesCaisse).innerJoin(utilisateurs, eq(utilisateurs.id, servicesCaisse.caissier_id))
        .where(and(eq(servicesCaisse.statut, 'CLOTURE'), gte(servicesCaisse.ouvert_le, depuis)))
        .groupBy(utilisateurs.nom_complet),
    ]);

    const parMode = Object.fromEntries(MODES_PAIEMENT.map((m) => [m, 0])) as Record<ModePaiement, number>;
    for (const l of parModeLignes) parMode[l.mode] = Number(l.total);
    const ca = payees.reduce((s, c) => s + c.total, 0);
    const tickets = compterTickets(payees);
    const heures = new Map<number, number>();
    for (const vente of payees) {
      const heure = vente.reconnue_le.getHours();
      heures.set(heure, (heures.get(heure) ?? 0) + vente.total);
    }

    return {
      periode: q,
      depuis: depuis.toISOString().slice(0, 10),
      ca,
      tickets,
      panier_moyen: tickets ? Math.round(ca / tickets) : 0,
      par_mode: parMode,
      par_heure: [...heures.entries()].sort(([a], [b]) => a - b).map(([heure, total]) => ({ heure, total })),
      top_plats: top,
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
