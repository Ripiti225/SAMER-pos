/**
 * Logique métier des commandes : snapshots de prix, totaux, promotions auto.
 * Règles critiques :
 *  - Prix figés dans commande_items au moment de l'ajout (jamais recalculés
 *    depuis le catalogue ensuite).
 *  - Promotions appliquées automatiquement selon heure/jour, montant tracé
 *    dans promo_montant. Une commande PAYEE/ANNULEE n'est plus recalculée.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { CommandeVue, CommandeItemVue } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import {
  articles,
  combos,
  commandeItems,
  commandes,
  notesSplit,
  paiements,
  prixCanaux,
  promotions,
  servicesCaisse,
  supplements,
  tablesSalle,
} from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { promotionActive, type PromotionDb } from '../catalogue/promos.js';

export type CommandeDb = typeof commandes.$inferSelect;
export type ItemDb = typeof commandeItems.$inferSelect;

export const STATUTS_MODIFIABLES = ['OUVERTE', 'ENVOYEE_CUISINE', 'PRETE', 'SERVIE'] as const;

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
    const canaux = await tx.select().from(prixCanaux).where(eq(prixCanaux.article_id, article.id));
    nomSnapshot = article.nom;
    prixUnitaire = prixSelonCanal(article.prix_base, canaux, c.type, c.partenaire);

    if (corps.supplements.length > 0) {
      const dispo = await tx.select().from(supplements).where(eq(supplements.article_id, article.id));
      supplementsFiges = corps.supplements.map((s) => {
        const trouve = dispo.find((d) => d.id === s.id);
        if (!trouve) throw new ErreurMetier('Supplément inconnu pour cet article', 400);
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
  const total = Math.max(0, sousTotal - remise - promoMontant);

  const [maj] = await tx
    .update(commandes)
    .set({
      sous_total: sousTotal,
      remise_montant: remise,
      promo_id: meilleure?.promo.id ?? null,
      promo_montant: promoMontant,
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

  const [items, lignesPaiements, notes, promoLigne, tableLigne] = await Promise.all([
    dbx.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId)),
    dbx.select().from(paiements).where(eq(paiements.commande_id, commandeId)),
    dbx.select().from(notesSplit).where(eq(notesSplit.commande_id, commandeId)),
    c.promo_id
      ? dbx.select().from(promotions).where(eq(promotions.id, c.promo_id))
      : Promise.resolve([]),
    c.table_id
      ? dbx.select().from(tablesSalle).where(eq(tablesSalle.id, c.table_id))
      : Promise.resolve([]),
  ]);

  const paye = lignesPaiements.reduce((s, p) => s + p.montant, 0);
  const vueItems: CommandeItemVue[] = items.map((i) => ({
    id: i.id,
    article_id: i.article_id,
    combo_id: i.combo_id,
    nom_snapshot: i.nom_snapshot,
    prix_unitaire: i.prix_unitaire,
    quantite: i.quantite,
    options: (i.options as { groupe: string; choix: string[] }[]) ?? [],
    supplements: (i.supplements as { nom: string; prix: number }[]) ?? [],
    statut_cuisine: i.statut_cuisine as CommandeItemVue['statut_cuisine'],
    envoye: i.envoye_le !== null,
    total_ligne: i.statut_cuisine === 'ANNULE' ? 0 : totalLigne(i),
  }));

  return {
    id: c.id,
    numero_ticket: Number(c.numero_ticket),
    type: c.type,
    table_id: c.table_id,
    table_numero: tableLigne[0]?.numero ?? null,
    partenaire: c.partenaire,
    ref_partenaire: c.ref_partenaire,
    statut: c.statut,
    sous_total: c.sous_total,
    remise_montant: c.remise_montant,
    remise_motif: c.remise_motif,
    promo_montant: c.promo_montant,
    promo_nom: promoLigne[0]?.nom ?? null,
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
      const payeNote = lignesPaiements.filter((p) => p.note_id === n.id).reduce((s, p) => s + p.montant, 0);
      return { id: n.id, libelle: n.libelle, montant: n.montant, paye: payeNote, reste: Math.max(0, n.montant - payeNote) };
    }),
    created_at: c.created_at.toISOString(),
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
 * Envoi en cuisine : marque envoye_le sur les articles pas encore partis
 * (ils restent A_PREPARER — le KDS les passera EN_COURS) et passe la commande
 * à ENVOYEE_CUISINE. Seuls les NOUVEAUX articles partent (ajout en plusieurs
 * fois, §B2). Utilisé par la caisse ET par la validation d'une commande client.
 */
export async function marquerEnvoiCuisine(tx: DbOuTx, commandeId: string): Promise<void> {
  const items = await tx
    .select()
    .from(commandeItems)
    .where(and(eq(commandeItems.commande_id, commandeId), isNull(commandeItems.envoye_le)));
  for (const item of items) {
    if (item.statut_cuisine === 'ANNULE') continue;
    const [maj] = await tx
      .update(commandeItems)
      .set({ envoye_le: new Date() })
      .where(eq(commandeItems.id, item.id))
      .returning();
    await ecrireOutbox(tx, 'commande_items', 'UPDATE', item.id, maj as unknown as Record<string, unknown>);
  }
  const [maj] = await tx
    .update(commandes)
    .set({ statut: 'ENVOYEE_CUISINE', updated_at: new Date() })
    .where(eq(commandes.id, commandeId))
    .returning();
  await ecrireOutbox(tx, 'commandes', 'UPDATE', commandeId, maj as unknown as Record<string, unknown>);
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
