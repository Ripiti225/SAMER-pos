/** Statistiques d'un service caisse — utilisées par le rapport Z (figé) et le rapport X (live). */
import { and, eq, gte, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQLWrapper } from 'drizzle-orm';
import type { ModePaiement, RetoursVue, TypeCommande } from '@pos/shared';
import { MODES_PAIEMENT, PARTENAIRES_EXTERNES, TYPES_COMMANDE } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { auditLog, commandeItems, commandes, noteSplitItems, notesSplit, utilisateurs } from '../../db/schema/index.js';
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

/**
 * Une ligne « partenaire » du ticket Z. `nb` et `contacts` se lisent ensemble —
 * « Yango 5 commandes, 4 contacts » — et c'est tout l'intérêt : le trou entre
 * les deux est le nombre de livraisons qu'on ne saura rattacher à personne si
 * le client se plaint. `refs` fait la même chose pour le n° de commande côté
 * partenaire, celui qui sert à contester une course.
 */
export interface StatPartenaire {
  nb: number;
  total: number;
  contacts: number;
  refs: number;
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
  partenaires: Record<string, StatPartenaire>;
  /** Espèces rendues au client sur le shift — le besoin réel en monnaie. */
  monnaie_rendue: number;
  /** Nombre d'encaissements espèces qui ont demandé de rendre la monnaie. */
  nb_rendus: number;
  top_articles: { nom: string; quantite: number; total: number }[];
  sous_notes_incompletes: { numero_ticket: number; numero_paiement: number; montant_recu: number; reste: number }[];
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

  const notesArticles = await dbx
    .select({
      id: notesSplit.id,
      commande_id: notesSplit.commande_id,
      numero: notesSplit.numero,
      statut: notesSplit.statut,
      montant: notesSplit.montant,
      remise_montant: notesSplit.remise_montant,
      promo_montant: notesSplit.promo_montant,
      fidelite_montant: notesSplit.fidelite_montant,
      type_commande: commandes.type,
      numero_ticket: commandes.numero_ticket,
      remise_motif: commandes.remise_motif,
      remise_par: commandes.remise_par,
      partenaire: commandes.partenaire,
      contact_client: commandes.contact_client,
      ref_partenaire: commandes.ref_partenaire,
    })
    .from(notesSplit)
    .innerJoin(commandes, eq(commandes.id, notesSplit.commande_id))
    .where(and(eq(notesSplit.type, 'ARTICLES'), eq(notesSplit.service_id, serviceId), eq(notesSplit.statut, 'PAYEE')));
  const commandesAvecArticles = await dbx
    .select({ commande_id: notesSplit.commande_id })
    .from(notesSplit)
    .where(eq(notesSplit.type, 'ARTICLES'));
  const idsCommandesArticles = new Set(commandesAvecArticles.map((note) => note.commande_id));
  const payees = lignesCommandes.filter((c) => c.statut === 'PAYEE' && !idsCommandesArticles.has(c.id));
  const annulees = lignesCommandes.filter((c) => c.statut === 'ANNULEE');

  // Noms des managers ayant accordé une remise (pour le détail Z/X)
  const idsRemiseurs = [
    ...new Set(
      [...payees.map((c) => c.remise_par), ...notesArticles.map((note) => note.remise_par)]
        .filter((x): x is string => !!x),
    ),
  ];
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

  // Monnaie rendue du shift. Volontairement HORS de `par_mode` : ce n'est pas
  // un encaissement. Le billet entre dans le tiroir à l'instant où la monnaie
  // en sort, donc ni la vente ni l'écart de caisse ne bougent. Le chiffre ne
  // sert qu'à savoir combien de petites coupures il faut pour tenir un service.
  const [ligneMonnaie] = await dbx
    .select({
      total: sql<string>`COALESCE(SUM(${paiements.monnaie_rendue}), 0)`,
      nb: sql<string>`COUNT(*) FILTER (WHERE ${paiements.monnaie_rendue} > 0)`,
    })
    .from(paiements)
    .where(eq(paiements.service_id, serviceId));

  // Même base que le montant de la ligne (les commandes PAYÉES) : le « 4/5 »
  // doit se lire en face des 25 000 F, pas contre un autre décompte.
  const partenaires: Record<string, StatPartenaire> = {};
  for (const c of payees) {
    if (c.type !== 'LIVRAISON' || !c.partenaire) continue;
    const entree = (partenaires[c.partenaire] ??= { nb: 0, total: 0, contacts: 0, refs: 0 });
    entree.nb += 1;
    entree.total += c.total;
    if (c.contact_client?.trim()) entree.contacts += 1;
    if (c.ref_partenaire?.trim()) entree.refs += 1;
  }
  const livraisonsArticles = new Map<string, {
    partenaire: string;
    total: number;
    contact: boolean;
    ref: boolean;
  }>();
  for (const note of notesArticles) {
    if (note.type_commande !== 'LIVRAISON' || !note.partenaire) continue;
    const livraison = livraisonsArticles.get(note.commande_id) ?? {
      partenaire: note.partenaire,
      total: 0,
      contact: !!note.contact_client?.trim(),
      ref: !!note.ref_partenaire?.trim(),
    };
    livraison.total += note.montant;
    livraisonsArticles.set(note.commande_id, livraison);
  }
  for (const livraison of livraisonsArticles.values()) {
    const entree = (partenaires[livraison.partenaire] ??= { nb: 0, total: 0, contacts: 0, refs: 0 });
    entree.nb += 1;
    entree.total += livraison.total;
    if (livraison.contact) entree.contacts += 1;
    if (livraison.ref) entree.refs += 1;
  }
  // Ventes par type (sur place / à emporter / livraison)
  const parType = Object.fromEntries(TYPES_COMMANDE.map((t) => [t, { nb: 0, total: 0 }])) as Record<TypeCommande, { nb: number; total: number }>;
  for (const c of payees) {
    parType[c.type].nb += 1;
    parType[c.type].total += c.total;
  }
  const commandesArticlesParType = new Set<string>();
  for (const note of notesArticles) {
    const cleCommande = `${note.type_commande}:${note.commande_id}`;
    if (!commandesArticlesParType.has(cleCommande)) {
      parType[note.type_commande].nb += 1;
      commandesArticlesParType.add(cleCommande);
    }
    parType[note.type_commande].total += note.montant;
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
  const remisesArticlesParCommande = new Map<string, RemiseDetail>();
  for (const note of notesArticles) {
    if (note.remise_montant <= 0) continue;
    const detail = remisesArticlesParCommande.get(note.commande_id) ?? {
      numero_ticket: Number(note.numero_ticket),
      montant: 0,
      motif: note.remise_motif,
      par_nom: note.remise_par ? (nomParId.get(note.remise_par) ?? null) : null,
    };
    detail.montant += note.remise_montant;
    remisesArticlesParCommande.set(note.commande_id, detail);
  }
  remisesDetail.push(...remisesArticlesParCommande.values());
  const annulationsDetail: AnnulationDetail[] = annulees.map((c) => ({ numero_ticket: Number(c.numero_ticket), total: c.total }));

  const topHistorique = await dbx
    .select({
      nom: commandeItems.nom_snapshot,
      quantite: sql<string>`SUM(${commandeItems.quantite})`,
      total: sql<string>`SUM(${commandeItems.prix_unitaire} * ${commandeItems.quantite})`,
    })
    .from(commandeItems)
    .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
    .where(and(
      eq(commandes.service_id, serviceId),
      eq(commandes.statut, 'PAYEE'),
      ne(commandeItems.statut_cuisine, 'ANNULE'),
      ...(idsCommandesArticles.size ? [notInArray(commandes.id, [...idsCommandesArticles])] : []),
    ))
    .groupBy(commandeItems.nom_snapshot)
    .orderBy(sql`SUM(${commandeItems.quantite}) DESC`)
    .limit(10);

  const topArticles = await dbx
    .select({
      nom: commandeItems.nom_snapshot,
      quantite: sql<string>`SUM(${noteSplitItems.quantite})`,
      total: sql<string>`SUM(${noteSplitItems.montant_brut})`,
    })
    .from(noteSplitItems)
    .innerJoin(notesSplit, eq(notesSplit.id, noteSplitItems.note_id))
    .innerJoin(commandeItems, eq(commandeItems.id, noteSplitItems.commande_item_id))
    .where(and(eq(notesSplit.type, 'ARTICLES'), eq(notesSplit.statut, 'PAYEE'), eq(notesSplit.service_id, serviceId)))
    .groupBy(commandeItems.nom_snapshot);

  const topParNom = new Map<string, { nom: string; quantite: number; total: number }>();
  for (const ligne of [...topHistorique, ...topArticles]) {
    const courant = topParNom.get(ligne.nom) ?? { nom: ligne.nom, quantite: 0, total: 0 };
    courant.quantite += Number(ligne.quantite);
    courant.total += Number(ligne.total);
    topParNom.set(ligne.nom, courant);
  }

  const incompletes = await dbx
    .select({
      numero_ticket: commandes.numero_ticket,
      numero_paiement: notesSplit.numero,
      montant: notesSplit.montant,
      montant_recu: sql<string>`SUM(${paiements.montant})`,
    })
    .from(paiements)
    .innerJoin(notesSplit, eq(notesSplit.id, paiements.note_id))
    .innerJoin(commandes, eq(commandes.id, notesSplit.commande_id))
    .where(and(
      eq(paiements.service_id, serviceId),
      eq(notesSplit.type, 'ARTICLES'),
      eq(notesSplit.statut, 'PARTIELLEMENT_PAYEE'),
    ))
    .groupBy(commandes.numero_ticket, notesSplit.numero, notesSplit.montant);

  const totalVentes = payees.reduce((s, c) => s + c.total, 0) + notesArticles.reduce((s, note) => s + note.montant, 0);
  const nbVentes = payees.length + new Set(notesArticles.map((note) => note.commande_id)).size;
  return {
    nb_commandes_payees: nbVentes,
    nb_commandes_annulees: annulees.length,
    total_ventes: totalVentes,
    total_remises: payees.reduce((s, c) => s + c.remise_montant, 0) + notesArticles.reduce((s, n) => s + n.remise_montant, 0),
    total_promos: payees.reduce((s, c) => s + c.promo_montant, 0) + notesArticles.reduce((s, n) => s + n.promo_montant, 0),
    total_fidelite: payees.reduce((s, c) => s + c.fidelite_montant, 0) + notesArticles.reduce((s, n) => s + n.fidelite_montant, 0),
    panier_moyen: nbVentes ? Math.round(totalVentes / nbVentes) : 0,
    par_mode: parMode,
    par_type: parType,
    monnaie_rendue: Number(ligneMonnaie?.total ?? 0),
    nb_rendus: Number(ligneMonnaie?.nb ?? 0),
    top_articles: [...topParNom.values()].sort((a, b) => b.quantite - a.quantite).slice(0, 10),
    sous_notes_incompletes: incompletes.map((note) => ({
      numero_ticket: Number(note.numero_ticket),
      numero_paiement: note.numero_paiement,
      montant_recu: Number(note.montant_recu),
      reste: note.montant - Number(note.montant_recu),
    })),
    partenaires,
    remises_detail: remisesDetail,
    annulations_detail: annulationsDetail,
    retours: await retoursDuService(dbx, serviceId),
  };
}
