/** Statistiques d'un service caisse — utilisées par le rapport Z (figé) et le rapport X (live). */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ModePaiement, TypeCommande } from '@pos/shared';
import { MODES_PAIEMENT, TYPES_COMMANDE } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { commandeItems, commandes, utilisateurs } from '../../db/schema/index.js';
import { paiements } from '../../db/schema/index.js';

export interface RemiseDetail {
  numero_ticket: number;
  montant: number;
  motif: string | null;
  par_nom: string | null;
}
export interface AnnulationDetail {
  numero_ticket: number;
  total: number;
}

export interface StatsService {
  nb_commandes_payees: number;
  nb_commandes_annulees: number;
  total_ventes: number;
  total_remises: number;
  total_promos: number;
  total_fidelite: number;
  panier_moyen: number;
  par_mode: Record<ModePaiement, number>;
  par_type: Record<TypeCommande, { nb: number; total: number }>;
  partenaires: Record<string, { nb: number; total: number }>;
  top_articles: { nom: string; quantite: number; total: number }[];
  remises_detail: RemiseDetail[];
  annulations_detail: AnnulationDetail[];
}

export async function calculerStatsService(dbx: DbOuTx, serviceId: string): Promise<StatsService> {
  const lignesCommandes = await dbx
    .select()
    .from(commandes)
    .where(eq(commandes.service_id, serviceId));

  const payees = lignesCommandes.filter((c) => c.statut === 'PAYEE');
  const annulees = lignesCommandes.filter((c) => c.statut === 'ANNULEE');

  // Noms des managers ayant accordé une remise (pour le détail Z/X)
  const idsRemiseurs = [...new Set(payees.map((c) => c.remise_par).filter((x): x is string => !!x))];
  const nomsRemiseurs = idsRemiseurs.length
    ? await dbx.select({ id: utilisateurs.id, nom: utilisateurs.nom_complet }).from(utilisateurs).where(inArray(utilisateurs.id, idsRemiseurs))
    : [];
  const nomParId = new Map(nomsRemiseurs.map((u) => [u.id, u.nom]));

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

  // Ventes par type (sur place / à emporter / livraison)
  const parType = Object.fromEntries(TYPES_COMMANDE.map((t) => [t, { nb: 0, total: 0 }])) as Record<TypeCommande, { nb: number; total: number }>;
  for (const c of payees) {
    parType[c.type].nb += 1;
    parType[c.type].total += c.total;
  }

  // Détails remises (qui / motif) et annulations
  const remisesDetail: RemiseDetail[] = payees
    .filter((c) => c.remise_montant > 0)
    .map((c) => ({
      numero_ticket: Number(c.numero_ticket),
      montant: c.remise_montant,
      motif: c.remise_motif,
      par_nom: c.remise_par ? (nomParId.get(c.remise_par) ?? null) : null,
    }));
  const annulationsDetail: AnnulationDetail[] = annulees.map((c) => ({ numero_ticket: Number(c.numero_ticket), total: c.total }));

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

  const totalVentes = payees.reduce((s, c) => s + c.total, 0);
  return {
    nb_commandes_payees: payees.length,
    nb_commandes_annulees: annulees.length,
    total_ventes: totalVentes,
    total_remises: payees.reduce((s, c) => s + c.remise_montant, 0),
    total_promos: payees.reduce((s, c) => s + c.promo_montant, 0),
    total_fidelite: payees.reduce((s, c) => s + c.fidelite_montant, 0),
    panier_moyen: payees.length ? Math.round(totalVentes / payees.length) : 0,
    par_mode: parMode,
    par_type: parType,
    top_articles: top.map((t) => ({ nom: t.nom, quantite: Number(t.quantite), total: Number(t.total) })),
    partenaires,
    remises_detail: remisesDetail,
    annulations_detail: annulationsDetail,
  };
}
