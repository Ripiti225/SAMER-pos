/** Statistiques d'un service caisse — utilisées par le rapport Z (figé) et le rapport X (live). */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { ModePaiement } from '@pos/shared';
import { MODES_PAIEMENT } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { commandeItems, commandes, paiements } from '../../db/schema/index.js';

export interface StatsService {
  nb_commandes_payees: number;
  nb_commandes_annulees: number;
  total_ventes: number;
  total_remises: number;
  total_promos: number;
  par_mode: Record<ModePaiement, number>;
  partenaires: Record<string, { nb: number; total: number }>;
  top_articles: { nom: string; quantite: number; total: number }[];
}

export async function calculerStatsService(dbx: DbOuTx, serviceId: string): Promise<StatsService> {
  const lignesCommandes = await dbx
    .select()
    .from(commandes)
    .where(eq(commandes.service_id, serviceId));

  const payees = lignesCommandes.filter((c) => c.statut === 'PAYEE');
  const annulees = lignesCommandes.filter((c) => c.statut === 'ANNULEE');

  const lignesPaiements = await dbx
    .select({ mode: paiements.mode, total: sql<string>`SUM(${paiements.montant})` })
    .from(paiements)
    .where(eq(paiements.service_id, serviceId))
    .groupBy(paiements.mode);

  const parMode = Object.fromEntries(MODES_PAIEMENT.map((m) => [m, 0])) as Record<ModePaiement, number>;
  for (const l of lignesPaiements) parMode[l.mode] = Number(l.total);

  const partenaires: Record<string, { nb: number; total: number }> = {};
  for (const c of payees) {
    if (c.type !== 'LIVRAISON' || !c.partenaire) continue;
    const entree = (partenaires[c.partenaire] ??= { nb: 0, total: 0 });
    entree.nb += 1;
    entree.total += c.total;
  }

  const top = await dbx
    .select({
      nom: commandeItems.nom_snapshot,
      quantite: sql<string>`SUM(${commandeItems.quantite})`,
      total: sql<string>`SUM(${commandeItems.prix_unitaire} * ${commandeItems.quantite})`,
    })
    .from(commandeItems)
    .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
    .where(
      and(
        eq(commandes.service_id, serviceId),
        eq(commandes.statut, 'PAYEE'),
        ne(commandeItems.statut_cuisine, 'ANNULE'),
      ),
    )
    .groupBy(commandeItems.nom_snapshot)
    .orderBy(sql`SUM(${commandeItems.quantite}) DESC`)
    .limit(10);

  return {
    nb_commandes_payees: payees.length,
    nb_commandes_annulees: annulees.length,
    total_ventes: payees.reduce((s, c) => s + c.total, 0),
    total_remises: payees.reduce((s, c) => s + c.remise_montant, 0),
    total_promos: payees.reduce((s, c) => s + c.promo_montant, 0),
    par_mode: parMode,
    top_articles: top.map((t) => ({ nom: t.nom, quantite: Number(t.quantite), total: Number(t.total) })),
    partenaires,
  };
}
