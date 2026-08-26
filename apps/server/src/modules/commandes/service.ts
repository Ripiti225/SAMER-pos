/**
 * Logique métier des commandes : snapshots de prix, totaux, promotions auto.
 * Règles critiques :
 *  - Prix figés dans commande_items au moment de l'ajout (jamais recalculés
 *    depuis le catalogue ensuite).
 *  - Promotions appliquées automatiquement selon heure/jour, montant tracé
 *    dans promo_montant. Une commande PAYEE/ANNULEE n'est plus recalculée.
 */
import { randomInt } from 'node:crypto';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { CommandeVue, CommandeItemVue, TypeCommande } from '@pos/shared';
import { categorieVisiblePour, libellePartenaire, PREFIXE_CODE_TYPE } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import {
  articles,
  categories,
  combos,
  commandeItems,
  commandes,
  noteSplitItems,
  notesSplit,
  paiements,
  prixCanaux,
  promotions,
  servicesCaisse,
  tablesSalle,
} from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { promotionActive, type PromotionDb } from '../catalogue/promos.js';
import { optionsAutoriseesPourArticle } from '../catalogue/options.js';

export type CommandeDb = typeof commandes.$inferSelect;
export type ItemDb = typeof commandeItems.$inferSelect;

export const STATUTS_MODIFIABLES = ['OUVERTE', 'ENVOYEE_CUISINE', 'PRETE', 'SERVIE'] as const;

/**
 * Génère un code court lisible (ex. « SP215 ») : préfixe selon le type +
 * 3 chiffres aléatoires. Unique dans le service (ou, à défaut de service —
 * commande client QR —, parmi les commandes actives). Le numero_ticket reste
 * la séquence continue d'audit ; ce code n'est qu'un repère opérationnel.
 */
export async function genererCodeCommande(
  tx: DbOuTx,
  type: TypeCommande,
  serviceId: string | null,
): Promise<string> {
  const prefixe = PREFIXE_CODE_TYPE[type];
  for (let essai = 0; essai < 40; essai++) {
    // 3 chiffres après ~30 essais on élargit à 4 pour garantir la terminaison.
    const chiffres = essai < 30 ? 1000 : 10000;
    const candidat = `${prefixe}${String(randomInt(chiffres)).padStart(essai < 30 ? 3 : 4, '0')}`;
    const conflits = serviceId
      ? await tx
          .select({ id: commandes.id })
          .from(commandes)
          .where(and(eq(commandes.service_id, serviceId), eq(commandes.code_commande, candidat)))
          .limit(1)
      : await tx
          .select({ id: commandes.id })
          .from(commandes)
          .where(and(eq(commandes.code_commande, candidat), notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])))
          .limit(1);
    if (conflits.length === 0) return candidat;
  }
  // Repli théoriquement inatteignable : préfixe + horodatage court.
  return `${prefixe}${Date.now().toString().slice(-5)}`;
}

export function totalLigne(item: Pick<ItemDb, 'prix_unitaire' | 'quantite' | 'supplements'>): number {
  const suppls = (item.supplements as { nom: string; prix: number }[]) ?? [];
  const prixSupplements = suppls.reduce((s, x) => s + x.prix, 0);
  return (item.prix_unitaire + prixSupplements) * item.quantite;
}

/** Prix figé selon le canal : livraison partenaire = prix_canaux sinon prix_base. */
export function prixSelonCanal(
  prixBase: number,
  canaux: { canal: string; prix: number }[],
  type: 'SUR_PLACE' | 'EMPORTER' | 'LIVRAISON',
  partenaire: string | null,
): number {
  if (type === 'LIVRAISON' && partenaire) {
    const surcharge = canaux.find((c) => c.canal === partenaire);
    if (surcharge) return surcharge.prix;
  }
  if (type === 'EMPORTER') {
    const surcharge = canaux.find((c) => c.canal === 'EMPORTER');
    if (surcharge) return surcharge.prix;
  }
  return prixBase;
}

/** Verrouille la ligne commande (FOR UPDATE) pour sérialiser paiements/modifs. */
export async function verrouillerCommande(tx: DbOuTx, commandeId: string): Promise<CommandeDb> {
  const lignes = await tx
    .select()
    .from(commandes)
    .where(eq(commandes.id, commandeId))
    .for('update');
  const c = lignes[0];
  if (!c) throw introuvable('Commande');
  return c;
}

export interface NouvelItem {
  article_id?: string | null;
  combo_id?: string | null;
  quantite: number;
  options: { groupe: string; choix: string[] }[];
  supplements: { id: string }[];
}

/**
 * Fige et insère un article/combo dans une commande : nom + prix snapshot
 * (canal appliqué), suppléments figés, ligne outbox — dans la transaction.
 * Utilisé par la caisse ET par l'app serveur tablette (sprint 2).
 * `envoye` = true quand l'article part directement en cuisine (tablette).
 */
export async function figerNouvelItem(
  tx: DbOuTx,
  c: CommandeDb,
  corps: NouvelItem,
  envoye = false,
): Promise<ItemDb> {
  let nomSnapshot: string;
  let prixUnitaire: number;
  let supplementsFiges: { nom: string; prix: number }[] = [];

  if (corps.article_id) {
    const [article] = await tx.select().from(articles).where(eq(articles.id, corps.article_id));
    if (!article || !article.actif) throw introuvable('Article');
    if (!article.disponible) throw new ErreurMetier('Cet article n’est plus disponible aujourd’hui', 409);

    // Catégorie réservée à un partenaire (migration 0023) : la règle est
    // appliquée ICI et pas seulement à l'affichage. Les trois apps masquent
    // déjà ces catégories, mais un plat « Glovo spéciale » vendu en salle
    // fausserait la facturation du partenaire — la carte n'est pas la même.
    const [categorie] = await tx
      .select({ nom: categories.nom, partenaires: categories.partenaires })
      .from(categories)
      .where(eq(categories.id, article.categorie_id));
    if (!categorieVisiblePour(categorie?.partenaires, c.partenaire)) {
      throw new ErreurMetier(
        `« ${article.nom} » ne se vend que pour ${(categorie?.partenaires ?? []).map(libellePartenaire).join(' ou ')}`,
        409,
      );
    }
    const canaux = await tx.select().from(prixCanaux).where(eq(prixCanaux.article_id, article.id));
    nomSnapshot = article.nom;
    prixUnitaire = prixSelonCanal(article.prix_base, canaux, c.type, c.partenaire);

    // Extras choisis (migration 0020) : les ids viennent de options_catalogue,
    // et sont validés contre l'ensemble EXACT que la caisse a pu proposer —
    // options de la catégorie de l'article + options de l'article. Le prix est
    // figé ici depuis la base, jamais depuis ce que le client a envoyé.
    if (corps.supplements.length > 0) {
      const autorisees = await optionsAutoriseesPourArticle(tx, article.id, article.categorie_id);
      supplementsFiges = corps.supplements.map((s) => {
        const trouve = autorisees.find((d) => d.id === s.id);
        if (!trouve) throw new ErreurMetier('Option inconnue pour cet article', 400);
        return { nom: trouve.nom, prix: trouve.prix };
      });
    }
  } else {
    const [combo] = await tx.select().from(combos).where(eq(combos.id, corps.combo_id!));
    if (!combo || !combo.actif) throw introuvable('Combo');
    if (!combo.disponible) throw new ErreurMetier('Ce combo n’est plus disponible aujourd’hui', 409);
    nomSnapshot = combo.nom;
    prixUnitaire = combo.prix;
  }

  const [item] = await tx
    .insert(commandeItems)
    .values({
      commande_id: c.id,
      article_id: corps.article_id ?? null,
      combo_id: corps.combo_id ?? null,
      nom_snapshot: nomSnapshot,
      prix_unitaire: prixUnitaire,
      quantite: corps.quantite,
      options: corps.options,
      supplements: supplementsFiges,
      envoye_le: envoye ? new Date() : null,
    })
    .returning();
  await ecrireOutbox(tx, 'commande_items', 'INSERT', item!.id, item as unknown as Record<string, unknown>);
  return item!;
}

export function exigerModifiable(c: CommandeDb): void {
  if (c.statut === 'PAYEE') {
    throw new ErreurMetier('Cette commande est déjà encaissée — demandez une réouverture au manager', 409);
  }
  if (c.statut === 'ANNULEE') {
    throw new ErreurMetier('Cette commande est annulée', 409);
  }
}

/** Montant de remise qu'une promotion produirait sur les items actifs. */
function remisePourPromo(promo: PromotionDb, itemsActifs: ItemDb[], sousTotal: number): number {
  if (promo.article_id) {
    const lignes = itemsActifs.filter((i) => i.article_id === promo.article_id);
    if (lignes.length === 0) return 0;
    const base = lignes.reduce((s, i) => s + totalLigne(i), 0);
    if (promo.type === 'POURCENTAGE') return Math.round((base * promo.valeur) / 100);
    return Math.min(promo.valeur * lignes.reduce((s, i) => s + i.quantite, 0), base);
  }
  if (promo.type === 'POURCENTAGE') return Math.round((sousTotal * promo.valeur) / 100);
  return Math.min(promo.valeur, sousTotal);
}

/**
 * Recalcule sous_total, promotion automatique et total, puis écrit la ligne
 * outbox UPDATE de la commande — le tout dans la transaction fournie.
 */
export async function recalculerTotaux(tx: DbOuTx, commandeId: string, quand = new Date()): Promise<CommandeDb> {
  const items = await tx.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId));
  const actifs = items.filter((i) => i.statut_cuisine !== 'ANNULE');
  const sousTotal = actifs.reduce((s, i) => s + totalLigne(i), 0);

  const promosActives = (await tx.select().from(promotions).where(eq(promotions.actif, true))).filter(
    (p) => promotionActive(p, quand),
  );
  let meilleure: { promo: PromotionDb; montant: number } | null = null;
  for (const p of promosActives) {
    const montant = remisePourPromo(p, actifs, sousTotal);
    if (montant > 0 && (!meilleure || montant > meilleure.montant)) meilleure = { promo: p, montant };
  }

  const [avant] = await tx.select().from(commandes).where(eq(commandes.id, commandeId));
  if (!avant) throw introuvable('Commande');
  const remise = Math.min(avant.remise_montant, sousTotal);
  const promoMontant = meilleure ? Math.min(meilleure.montant, sousTotal - remise) : 0;
  // Sprint 4 B : la remise fidélité (points) réduit aussi le total.
  const fidelite = Math.min(avant.fidelite_montant, Math.max(0, sousTotal - remise - promoMontant));
  let total = Math.max(0, sousTotal - remise - promoMontant - fidelite);

  // Une sous-note ARTICLES est un mini-reçu figé. Les ajouts ou augmentations
  // ultérieurs ne doivent jamais modifier ce qu'un convive a déjà accepté.
  const notesArticles = await tx
    .select()
    .from(notesSplit)
    .where(and(eq(notesSplit.commande_id, commandeId), eq(notesSplit.type, 'ARTICLES'), sql`${notesSplit.statut} <> 'ANNULEE'`));
  if (notesArticles.length > 0) {
    const allocations = await tx
      .select({ montant_brut: noteSplitItems.montant_brut })
      .from(noteSplitItems)
      .innerJoin(notesSplit, eq(notesSplit.id, noteSplitItems.note_id))
      .where(and(eq(notesSplit.commande_id, commandeId), eq(notesSplit.type, 'ARTICLES'), sql`${notesSplit.statut} <> 'ANNULEE'`));
    const brutFige = allocations.reduce((s, allocation) => s + allocation.montant_brut, 0);
    const notesFigees = notesArticles.reduce((s, note) => s + note.montant, 0);
    const remiseFigee = notesArticles.reduce((s, note) => s + note.remise_montant, 0);
    const promoFigee = notesArticles.reduce((s, note) => s + note.promo_montant, 0);
    const fideliteFigee = notesArticles.reduce((s, note) => s + note.fidelite_montant, 0);
    const libreBrut = Math.max(0, sousTotal - brutFige);
    const libreRemise = Math.max(0, remise - remiseFigee);
    const librePromo = Math.max(0, promoMontant - promoFigee);
    const libreFidelite = Math.max(0, fidelite - fideliteFigee);
    total = notesFigees + Math.max(0, libreBrut - libreRemise - librePromo - libreFidelite);
  }

  const [maj] = await tx
    .update(commandes)
    .set({
      sous_total: sousTotal,
      remise_montant: remise,
      promo_id: meilleure?.promo.id ?? null,
      promo_montant: promoMontant,
      fidelite_montant: fidelite,
      total,
      updated_at: new Date(),
    })
    .where(eq(commandes.id, commandeId))
    .returning();
  await ecrireOutbox(tx, 'commandes', 'UPDATE', commandeId, maj as unknown as Record<string, unknown>);
  return maj!;
}

/** Charge la vue complète d'une commande (items, paiements, notes, reste). */
export async function chargerCommandeVue(dbx: DbOuTx, commandeId: string): Promise<CommandeVue> {
  const [c] = await dbx.select().from(commandes).where(eq(commandes.id, commandeId));
  if (!c) throw introuvable('Commande');

  const [items, lignesPaiements, notes, allocations, promoLigne, tableLigne] = await Promise.all([
    dbx.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId)),
    dbx.select().from(paiements).where(eq(paiements.commande_id, commandeId)),
    dbx.select().from(notesSplit).where(eq(notesSplit.commande_id, commandeId)),
    dbx
      .select({
        id: noteSplitItems.id,
        note_id: noteSplitItems.note_id,
        commande_item_id: noteSplitItems.commande_item_id,
        quantite: noteSplitItems.quantite,
        montant_brut: noteSplitItems.montant_brut,
        statut_note: notesSplit.statut,
      })
      .from(noteSplitItems)
      .innerJoin(notesSplit, eq(notesSplit.id, noteSplitItems.note_id))
      .where(eq(notesSplit.commande_id, commandeId)),
    c.promo_id
      ? dbx.select().from(promotions).where(eq(promotions.id, c.promo_id))
      : Promise.resolve([]),
    c.table_id
      ? dbx.select().from(tablesSalle).where(eq(tablesSalle.id, c.table_id))
      : Promise.resolve([]),
  ]);

  const paye = lignesPaiements.reduce((s, p) => s + p.montant, 0);
  const vueItems: CommandeItemVue[] = items.map((i) => {
    const allocationsItem = allocations.filter((a) => a.commande_item_id === i.id && a.statut_note !== 'ANNULEE');
    const quantitePayee = allocationsItem
      .filter((a) => a.statut_note === 'PAYEE')
      .reduce((s, a) => s + a.quantite, 0);
    const quantiteReservee = allocationsItem
      .filter((a) => a.statut_note !== 'PAYEE')
      .reduce((s, a) => s + a.quantite, 0);
    return {
    id: i.id,
    article_id: i.article_id,
    combo_id: i.combo_id,
    nom_snapshot: i.nom_snapshot,
    prix_unitaire: i.prix_unitaire,
    quantite: i.quantite,
    quantite_reservee: quantiteReservee,
    quantite_payee: quantitePayee,
    quantite_disponible: Math.max(0, i.quantite - quantiteReservee - quantitePayee),
    options: (i.options as { groupe: string; choix: string[] }[]) ?? [],
    supplements: (i.supplements as { nom: string; prix: number }[]) ?? [],
    statut_cuisine: i.statut_cuisine as CommandeItemVue['statut_cuisine'],
    envoye: i.envoye_le !== null,
    total_ligne: i.statut_cuisine === 'ANNULE' ? 0 : totalLigne(i),
    };
  });

  return {
    id: c.id,
    numero_ticket: Number(c.numero_ticket),
    code_commande: c.code_commande,
    type: c.type,
    table_id: c.table_id,
    table_numero: tableLigne[0]?.numero ?? null,
    partenaire: c.partenaire,
    ref_partenaire: c.ref_partenaire,
    contact_client: c.contact_client,
    statut: c.statut,
    offert: c.offert,
    motif_offert: c.motif_offert,
    sous_total: c.sous_total,
    remise_montant: c.remise_montant,
    remise_motif: c.remise_motif,
    promo_montant: c.promo_montant,
    promo_nom: promoLigne[0]?.nom ?? null,
    fidelite_montant: c.fidelite_montant,
    client_fidelite_id: c.client_fidelite_id,
    total: c.total,
    paye,
    reste: Math.max(0, c.total - paye),
    items: vueItems,
    paiements: lignesPaiements.map((p) => ({
      id: p.id,
      mode: p.mode,
      montant: p.montant,
      note_id: p.note_id,
      created_at: p.created_at.toISOString(),
    })),
    notes: notes.map((n) => {
      const paiementsNote = lignesPaiements.filter((p) => p.note_id === n.id);
      const payeNote = paiementsNote.reduce((s, p) => s + p.montant, 0);
      const allocationsNote = allocations.filter((a) => a.note_id === n.id);
      return {
        id: n.id,
        numero: n.numero,
        libelle: n.libelle,
        type: n.type as 'ARTICLES' | 'MONTANT_HISTORIQUE',
        statut: n.statut as 'A_PAYER' | 'PARTIELLEMENT_PAYEE' | 'PAYEE' | 'ANNULEE',
        sous_total: n.sous_total,
        promo_montant: n.promo_montant,
        remise_montant: n.remise_montant,
        fidelite_montant: n.fidelite_montant,
        client_fidelite_id: n.client_fidelite_id,
        fidelite_points: n.fidelite_points,
        montant: n.montant,
        paye: payeNote,
        reste: Math.max(0, n.montant - payeNote),
        payee_le: n.payee_le?.toISOString() ?? null,
        items: allocationsNote.map((a) => {
          const item = items.find((i) => i.id === a.commande_item_id)!;
          return {
            id: a.id,
            commande_item_id: a.commande_item_id,
            nom_snapshot: item.nom_snapshot,
            prix_unitaire: item.prix_unitaire,
            quantite: a.quantite,
            montant_brut: a.montant_brut,
            options: (item.options as { groupe: string; choix: string[] }[]) ?? [],
            supplements: (item.supplements as { nom: string; prix: number }[]) ?? [],
          };
        }),
        paiements: paiementsNote.map((p) => ({
          id: p.id,
          mode: p.mode,
          montant: p.montant,
          note_id: p.note_id,
          created_at: p.created_at.toISOString(),
        })),
      };
    }),
    created_at: c.created_at.toISOString(),
  };
}

/**
 * Addition suivante d'une table partiellement encaissée : uniquement les
 * quantités encore libres. Les sous-notes restent dans `notes` pour l'audit,
 * mais leurs articles et réductions figées sont retirés du document imprimé.
 */
export function construireFactureDisponible(c: CommandeVue): CommandeVue {
  const notesActives = c.notes.filter((note) => note.type === 'ARTICLES' && note.statut !== 'ANNULEE');
  if (notesActives.length === 0) return c;
  const sousTotalFige = notesActives.reduce((s, note) => s + note.sous_total, 0);
  const promoFigee = notesActives.reduce((s, note) => s + note.promo_montant, 0);
  const remiseFigee = notesActives.reduce((s, note) => s + note.remise_montant, 0);
  const fideliteFigee = notesActives.reduce((s, note) => s + note.fidelite_montant, 0);
  const montantFige = notesActives.reduce((s, note) => s + note.montant, 0);
  return {
    ...c,
    sous_total: Math.max(0, c.sous_total - sousTotalFige),
    promo_montant: Math.max(0, c.promo_montant - promoFigee),
    remise_montant: Math.max(0, c.remise_montant - remiseFigee),
    fidelite_montant: Math.max(0, c.fidelite_montant - fideliteFigee),
    total: Math.max(0, c.total - montantFige),
    paye: 0,
    reste: Math.max(0, c.total - montantFige),
    paiements: [],
    items: c.items
      .filter((item) => item.statut_cuisine !== 'ANNULE' && item.quantite_disponible > 0)
      .map((item) => ({
        ...item,
        quantite: item.quantite_disponible,
        quantite_reservee: 0,
        quantite_payee: 0,
        total_ligne: Math.round((item.total_ligne / item.quantite) * item.quantite_disponible),
      })),
  };
}

/**
 * Libère (ou occupe) la table liée à une commande sur place. Libérer une table
 * efface aussi son propriétaire (ouverte_par) — CORRECTIONS3 point 3.
 */
export async function majStatutTable(tx: DbOuTx, tableId: string | null, statut: 'LIBRE' | 'OCCUPEE'): Promise<void> {
  if (!tableId) return;
  const valeurs = statut === 'LIBRE' ? { statut, ouverte_par: null } : { statut };
  await tx.update(tablesSalle).set(valeurs).where(eq(tablesSalle.id, tableId));
}

/**
 * Abandonne les commandes SANS AUCUN ARTICLE d'un service — tables ouvertes
 * par erreur, refermées sans que rien soit tapé. Elles passent ANNULEE (numéro
 * de ticket conservé : la séquence ne fait jamais de trou), leur table est
 * libérée, et surtout elles ne bloquent plus « J'ai fini » : demander à un
 * caissier d'« encaisser ou annuler » une commande à 0 F qu'il n'a jamais
 * saisie n'a aucun sens, et l'annulation manuelle réclamerait un PIN manager.
 *
 * Retourne les commandes abandonnées (pour la trace d'audit de l'appelant).
 */
export async function abandonnerCommandesVidesDuService(
  tx: DbOuTx,
  serviceId: string,
): Promise<{ id: string; table_id: string | null; numero_ticket: number }[]> {
  const vides = await tx
    .select({ id: commandes.id, table_id: commandes.table_id, numero_ticket: commandes.numero_ticket })
    .from(commandes)
    .where(
      and(
        eq(commandes.service_id, serviceId),
        eq(commandes.statut, 'OUVERTE'),
        sql`NOT EXISTS (SELECT 1 FROM commande_items ci WHERE ci.commande_id = ${commandes.id})`,
      ),
    );

  for (const c of vides) {
    const [maj] = await tx
      .update(commandes)
      .set({ statut: 'ANNULEE', updated_at: new Date() })
      .where(eq(commandes.id, c.id))
      .returning();
    await ecrireOutbox(tx, 'commandes', 'UPDATE', c.id, maj as unknown as Record<string, unknown>);
    await majStatutTable(tx, c.table_id, 'LIBRE');
  }
  return vides.map((c) => ({ ...c, numero_ticket: Number(c.numero_ticket) }));
}

/**
 * Envoi en cuisine : marque envoye_le sur les articles pas encore partis
 * (ils restent A_PREPARER — le KDS les passera EN_COURS) et passe la commande
 * à ENVOYEE_CUISINE. Seuls les NOUVEAUX articles partent (ajout en plusieurs
 * fois, §B2). Utilisé par la caisse ET par la validation d'une commande client.
 */
export async function marquerEnvoiCuisine(tx: DbOuTx, commandeId: string): Promise<string[]> {
  const items = await tx
    .select()
    .from(commandeItems)
    .where(and(eq(commandeItems.commande_id, commandeId), isNull(commandeItems.envoye_le)));
  const envoyes: string[] = [];
  for (const item of items) {
    if (item.statut_cuisine === 'ANNULE') continue;
    const [maj] = await tx
      .update(commandeItems)
      .set({ envoye_le: new Date() })
      .where(eq(commandeItems.id, item.id))
      .returning();
    await ecrireOutbox(tx, 'commande_items', 'UPDATE', item.id, maj as unknown as Record<string, unknown>);
    envoyes.push(item.id);
  }
  const [maj] = await tx
    .update(commandes)
    .set({ statut: 'ENVOYEE_CUISINE', updated_at: new Date() })
    .where(eq(commandes.id, commandeId))
    .returning();
  await ecrireOutbox(tx, 'commandes', 'UPDATE', commandeId, maj as unknown as Record<string, unknown>);
  // Renvoie les ids nouvellement envoyés → l'appelant imprime les bons APRÈS commit.
  return envoyes;
}

/** Le service ouvert du caissier courant est obligatoire pour encaisser. */
export async function serviceOuvertDe(dbx: DbOuTx, caissierId: string) {
  const [service] = await dbx
    .select()
    .from(servicesCaisse)
    .where(and(eq(servicesCaisse.caissier_id, caissierId), eq(servicesCaisse.statut, 'OUVERT')));
  if (!service) {
    throw new ErreurMetier('Ouvrez d’abord votre service (fond de caisse) avant d’encaisser', 409);
  }
  return service;
}

export { sql };
