/** Statistiques d'un service caisse — utilisées par le rapport Z (figé) et le rapport X (live). */
import { and, eq, gte, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQLWrapper } from 'drizzle-orm';
import type { ModePaiement, RetoursVue, TypeCommande } from '@pos/shared';
import { MODES_PAIEMENT, PARTENAIRES_EXTERNES, TYPES_COMMANDE } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { auditLog, commandeItems, commandes, utilisateurs } from '../../db/schema/index.js';
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
  retours: RetoursVue;
}

/**
 * RETOURS d'un service : plats **déjà partis en cuisine** qui ne seront pas
 * vendus, parce qu'un manager a supprimé la ligne — ou la commande entière.
 *
 * Discriminant : `envoye_le` renseigné, ET
 *   - `statut_cuisine = 'ANNULE'` (ligne supprimée une par une), OU
 *   - `commandes.statut = 'ANNULEE'` (la commande entière a sauté).
 *
 * **Les deux, et c'est un point de CONTRÔLE, pas de comptage.** Ne compter que
 * les lignes laisserait une porte ouverte : un manager encaisse, puis supprime
 * la table entière au lieu de l'article — plus rien nulle part. En prenant
 * aussi les commandes annulées, le geste reste visible, avec son motif et le
 * nom de qui l'a autorisé. Ne jamais restreindre ce filtre à la ligne seule.
 *
 * Une ligne corrigée AVANT l'envoi en cuisine n'est pas un retour : rien n'a
 * été produit, c'est une faute de frappe.
 *
 * Aucun de ces articles ne pèse sur quoi que ce soit : la vente est recalculée
 * sans eux, les sorties d'inventaire les excluent déjà. Ce bloc ne sert qu'à
 * les rendre VISIBLES — un site qui refait souvent ses plats se voit ici.
 */
export async function retoursDuService(dbx: DbOuTx, serviceId: string): Promise<RetoursVue> {
  return construireRetours(dbx, eq(commandes.service_id, serviceId));
}

/** Mêmes retours, sur la JOURNÉE (tous services) — rapports et supervision. */
export async function retoursDepuis(dbx: DbOuTx, depuis: Date): Promise<RetoursVue> {
  return construireRetours(dbx, gte(commandes.created_at, depuis));
}

async function construireRetours(dbx: DbOuTx, portee: SQLWrapper): Promise<RetoursVue> {
  const lignes = await dbx
    .select({
      commande_id: commandeItems.commande_id,
      numero_ticket: commandes.numero_ticket,
      statut_commande: commandes.statut,
      nom: commandeItems.nom_snapshot,
      quantite: commandeItems.quantite,
      prix_unitaire: commandeItems.prix_unitaire,
      motif: commandeItems.annule_motif,
      annule_par: commandeItems.annule_par,
    })
    .from(commandeItems)
    .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
    .where(
      and(
        portee,
        isNotNull(commandeItems.envoye_le),
        or(eq(commandeItems.statut_cuisine, 'ANNULE'), eq(commandes.statut, 'ANNULEE')),
      ),
    );

  // Commande annulée EN ENTIER : ni le motif ni le manager ne sont sur la
  // ligne (la route d'annulation ne touche pas les items). Ils sont dans le
  // journal d'audit, seule trace de qui a autorisé — on va les y chercher,
  // sinon un retour par suppression de table apparaîtrait sans responsable.
  const commandesAnnulees = [
    ...new Set(lignes.filter((l) => l.statut_commande === 'ANNULEE' && !l.annule_par).map((l) => l.commande_id)),
  ];
  const journal = commandesAnnulees.length
    ? await dbx
        .select({ entite_id: auditLog.entite_id, user_id: auditLog.user_id, motif: auditLog.motif })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'ANNULATION_COMMANDE'), inArray(auditLog.entite_id, commandesAnnulees)))
    : [];
  const annulationParCommande = new Map(journal.map((j) => [j.entite_id!, j]));

  const ids = [
    ...new Set(
      [...lignes.map((l) => l.annule_par), ...journal.map((j) => j.user_id)].filter((x): x is string => !!x),
    ),
  ];
  const noms = ids.length
    ? await dbx
        .select({ id: utilisateurs.id, nom: utilisateurs.nom_complet })
        .from(utilisateurs)
        .where(inArray(utilisateurs.id, ids))
    : [];
  const nomParId = new Map(noms.map((u) => [u.id, u.nom]));

  const parProduit = new Map<string, { nom: string; quantite: number; montant: number }>();
  let nb = 0;
  let montant = 0;
  const detail = lignes.map((l) => {
    const montantLigne = l.prix_unitaire * l.quantite;
    nb += l.quantite;
    montant += montantLigne;
    const agr = parProduit.get(l.nom) ?? { nom: l.nom, quantite: 0, montant: 0 };
    agr.quantite += l.quantite;
    agr.montant += montantLigne;
    parProduit.set(l.nom, agr);

    const surCommande = l.annule_par ? null : annulationParCommande.get(l.commande_id);
    const parId = l.annule_par ?? surCommande?.user_id ?? null;
    return {
      numero_ticket: Number(l.numero_ticket),
      nom: l.nom,
      quantite: l.quantite,
      montant: montantLigne,
      // « Commande annulée » est déjà une information en soi : elle distingue,
      // à l'œil, la suppression d'un plat de celle de toute une table.
      motif: l.motif ?? (surCommande ? `Commande annulée — ${surCommande.motif ?? 'sans motif'}` : null),
      par_nom: parId ? (nomParId.get(parId) ?? null) : null,
    };
  });

  return {
    nb,
    montant,
    par_produit: [...parProduit.values()].sort((a, b) => b.quantite - a.quantite || a.nom.localeCompare(b.nom)),
    detail: detail.sort((a, b) => a.numero_ticket - b.numero_ticket),
  };
}

/**
 * Valeurs auto de réconciliation d'un shift :
 * - `modes` : somme des paiements par mode, HORS livraisons EXTERNES
 *   (Yango/Glovo, réglées chez le partenaire → comptées à part). Samer Delly,
 *   réglée au comptoir, reste dans les modes comme une vente normale.
 * - `livraisons` : total des commandes payées par partenaire EXTERNE seulement.
 * - `offerts` : Kdo. Ces commandes n'ont AUCUNE ligne de paiement, donc elles
 *   sont déjà absentes de `modes` sans qu'on ait à les filtrer — le théorique
 *   espèces les ignore par construction. On les compte ici pour les afficher
 *   à la clôture, à côté des livraisons, car elles pèsent dans la vente du
 *   shift : vendre 25 000 et offrir 5 000 fait bien 30 000 de vente.
 * `modes.ESPECES` sert au théorique côté serveur (jamais exposé avant comptage).
 */
export async function reconciliationAuto(
  dbx: DbOuTx,
  serviceId: string,
): Promise<{
  modes: Record<ModePaiement, number>;
  livraisons: Record<string, number>;
  offerts: { nb: number; total: number };
}> {
  const externes = [...PARTENAIRES_EXTERNES];
  const lignesModes = await dbx
    .select({ mode: paiements.mode, total: sql<string>`SUM(${paiements.montant})` })
    .from(paiements)
    .innerJoin(commandes, eq(commandes.id, paiements.commande_id))
    .where(
      and(
        eq(paiements.service_id, serviceId),
        or(isNull(commandes.partenaire), notInArray(commandes.partenaire, externes)),
      ),
    )
    .groupBy(paiements.mode);
  const modes = Object.fromEntries(MODES_PAIEMENT.map((m) => [m, 0])) as Record<ModePaiement, number>;
  for (const l of lignesModes) modes[l.mode] = Number(l.total);

  const lignesPart = await dbx
    .select({ partenaire: commandes.partenaire, total: sql<string>`SUM(${commandes.total})` })
    .from(commandes)
    .where(and(eq(commandes.service_id, serviceId), eq(commandes.statut, 'PAYEE'), inArray(commandes.partenaire, externes)))
    .groupBy(commandes.partenaire);
  const livraisons: Record<string, number> = {};
  for (const l of lignesPart) if (l.partenaire) livraisons[l.partenaire] = Number(l.total);

  const [ligneOfferts] = await dbx
    .select({
      nb: sql<string>`COUNT(*)`,
      total: sql<string>`COALESCE(SUM(${commandes.total}), 0)`,
    })
    .from(commandes)
    .where(
      and(
        eq(commandes.service_id, serviceId),
        eq(commandes.statut, 'PAYEE'),
        eq(commandes.offert, true),
      ),
    );
  const offerts = {
    nb: Number(ligneOfferts?.nb ?? 0),
    total: Number(ligneOfferts?.total ?? 0),
  };

  return { modes, livraisons, offerts };
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
    retours: await retoursDuService(dbx, serviceId),
  };
}
