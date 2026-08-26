import { and, eq, ne } from 'drizzle-orm';
import type { CreerSousNoteInput } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { commandeItems, commandes, noteSplitItems, notesSplit, paiements, pointsFidelite } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { journaliser } from '../audit/audit.js';
import { lireBareme, trouverOuCreer, utiliserPoints } from '../fidelite/service.js';
import { recalculerTotaux, totalLigne, verrouillerCommande } from '../commandes/service.js';

type AllocationActive = {
  commande_item_id: string;
  quantite: number;
  statut: string;
  promo_montant: number;
  remise_montant: number;
  fidelite_montant: number;
  sous_total: number;
};

/**
 * Alloue une part entière d'un poste de réduction. Le dernier convive reçoit
 * automatiquement le reliquat, ce qui garantit qu'aucun franc n'est perdu.
 */
function allouerReduction(montantRestant: number, brutSelectionne: number, brutDisponible: number): number {
  if (montantRestant <= 0 || brutSelectionne <= 0 || brutDisponible <= 0) return 0;
  if (brutSelectionne === brutDisponible) return montantRestant;
  return Math.floor((montantRestant * brutSelectionne) / brutDisponible);
}

async function allocationsActives(tx: DbOuTx, commandeId: string): Promise<AllocationActive[]> {
  return tx
    .select({
      commande_item_id: noteSplitItems.commande_item_id,
      quantite: noteSplitItems.quantite,
      statut: notesSplit.statut,
      promo_montant: notesSplit.promo_montant,
      remise_montant: notesSplit.remise_montant,
      fidelite_montant: notesSplit.fidelite_montant,
      sous_total: notesSplit.sous_total,
    })
    .from(noteSplitItems)
    .innerJoin(notesSplit, eq(notesSplit.id, noteSplitItems.note_id))
    .where(and(eq(notesSplit.commande_id, commandeId), ne(notesSplit.statut, 'ANNULEE')));
}

export async function creerSousNoteArticles(
  tx: DbOuTx,
  commandeId: string,
  corps: CreerSousNoteInput,
  utilisateurId: string,
): Promise<string> {
  const c = await verrouillerCommande(tx, commandeId);
  if (c.statut === 'PAYEE' || c.statut === 'ANNULEE') {
    throw new ErreurMetier('Cette commande ne peut plus être encaissée', 409);
  }

  const demandeParId = new Map<string, number>();
  for (const selection of corps.items) {
    demandeParId.set(selection.commande_item_id, (demandeParId.get(selection.commande_item_id) ?? 0) + selection.quantite);
  }

  const [items, allocations, notesExistantes] = await Promise.all([
    tx.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId)),
    allocationsActives(tx, commandeId),
    tx.select().from(notesSplit).where(eq(notesSplit.commande_id, commandeId)),
  ]);
  const actifs = items.filter((item) => item.statut_cuisine !== 'ANNULE');
  const reserveParItem = new Map<string, number>();
  for (const a of allocations) reserveParItem.set(a.commande_item_id, (reserveParItem.get(a.commande_item_id) ?? 0) + a.quantite);

  const lignes = [...demandeParId.entries()].map(([itemId, quantite]) => {
    const item = actifs.find((i) => i.id === itemId);
    if (!item) throw new ErreurMetier('Un article sélectionné n’existe plus sur cette commande', 404);
    const disponible = item.quantite - (reserveParItem.get(item.id) ?? 0);
    if (quantite > disponible) {
      throw new ErreurMetier('Cette quantité vient d’être sélectionnée par un autre paiement', 409);
    }
    const prixUnitaireComplet = totalLigne({ ...item, quantite: 1 });
    return { item, quantite, montant_brut: prixUnitaireComplet * quantite };
  });
  const sousTotal = lignes.reduce((s, ligne) => s + ligne.montant_brut, 0);
  if (sousTotal <= 0) throw new ErreurMetier('Sélectionnez au moins un article à payer', 400);

  const brutDejaAlloue = allocations.reduce((s, a) => s + a.sous_total, 0);
  const brutDisponible = Math.max(sousTotal, c.sous_total - brutDejaAlloue);
  const promoDeja = allocations.reduce((s, a) => s + a.promo_montant, 0);
  const remiseDeja = allocations.reduce((s, a) => s + a.remise_montant, 0);
  const fideliteDeja = allocations.reduce((s, a) => s + a.fidelite_montant, 0);
  const promoMontant = allouerReduction(Math.max(0, c.promo_montant - promoDeja), sousTotal, brutDisponible);
  const remiseMontant = allouerReduction(Math.max(0, c.remise_montant - remiseDeja), sousTotal, brutDisponible);

  let clientFideliteId = corps.client_fidelite_id ?? null;
  if (corps.telephone_fidelite) {
    clientFideliteId = (await trouverOuCreer(tx, corps.telephone_fidelite)).id;
  }
  let fideliteMontant = allouerReduction(Math.max(0, c.fidelite_montant - fideliteDeja), sousTotal, brutDisponible);
  let fidelitePersonnelle = 0;
  if (corps.fidelite_points > 0) {
    if (!clientFideliteId) throw new ErreurMetier('Choisissez le client qui utilise ses points', 400);
    const bareme = await lireBareme(tx);
    fidelitePersonnelle = corps.fidelite_points * bareme.valeur_point_fcfa;
    fideliteMontant += fidelitePersonnelle;
  }
  const montant = sousTotal - promoMontant - remiseMontant - fideliteMontant;
  if (montant <= 0) throw new ErreurMetier('Cette sélection doit conserver un montant positif', 400);

  const numero = notesExistantes.reduce((max, n) => Math.max(max, n.numero), 0) + 1;
  const [note] = await tx
    .insert(notesSplit)
    .values({
      commande_id: commandeId,
      numero,
      libelle: `Paiement ${numero}`,
      type: 'ARTICLES',
      statut: 'A_PAYER',
      sous_total: sousTotal,
      promo_montant: promoMontant,
      remise_montant: remiseMontant,
      fidelite_montant: fideliteMontant,
      client_fidelite_id: clientFideliteId,
      fidelite_points: corps.fidelite_points,
      montant,
    })
    .returning();
  await ecrireOutbox(tx, 'notes_split', 'INSERT', note!.id, note as unknown as Record<string, unknown>);

  if (corps.fidelite_points > 0 && clientFideliteId) {
    const utilisation = await utiliserPoints(
      tx,
      clientFideliteId,
      commandeId,
      corps.fidelite_points,
      note!.id,
    );
    await journaliser(tx, {
      user_id: utilisateurId,
      action: 'UTILISATION_POINTS',
      entite: 'notes_split',
      entite_id: note!.id,
      montant: utilisation.montant,
      meta: { client_id: clientFideliteId, points: utilisation.points, commande_id: commandeId },
    });
    const [commandeMaj] = await tx
      .update(commandes)
      .set({ fidelite_montant: c.fidelite_montant + fidelitePersonnelle, updated_at: new Date() })
      .where(eq(commandes.id, commandeId))
      .returning();
    await ecrireOutbox(tx, 'commandes', 'UPDATE', commandeId, commandeMaj as unknown as Record<string, unknown>);
  }

  for (const ligne of lignes.sort((a, b) => a.item.id.localeCompare(b.item.id))) {
    const [allocation] = await tx
      .insert(noteSplitItems)
      .values({
        note_id: note!.id,
        commande_item_id: ligne.item.id,
        quantite: ligne.quantite,
        montant_brut: ligne.montant_brut,
      })
      .returning();
    await ecrireOutbox(tx, 'note_split_items', 'INSERT', allocation!.id, allocation as unknown as Record<string, unknown>);
  }
  if (fidelitePersonnelle > 0) await recalculerTotaux(tx, commandeId);
  await journaliser(tx, {
    user_id: utilisateurId,
    action: 'CREATION_SOUS_NOTE_ARTICLES',
    entite: 'notes_split',
    entite_id: note!.id,
    montant,
    meta: { commande_id: commandeId, numero, items: corps.items },
  });
  return note!.id;
}

export async function annulerSousNoteArticles(
  tx: DbOuTx,
  commandeId: string,
  noteId: string,
  utilisateurId: string,
): Promise<void> {
  const c = await verrouillerCommande(tx, commandeId);
  const [note] = await tx
    .select()
    .from(notesSplit)
    .where(and(eq(notesSplit.id, noteId), eq(notesSplit.commande_id, commandeId)));
  if (!note || note.type !== 'ARTICLES') throw new ErreurMetier('Paiement par articles inconnu', 404);
  if (note.statut === 'ANNULEE') return;
  const [paiement] = await tx.select({ id: paiements.id }).from(paiements).where(eq(paiements.note_id, noteId)).limit(1);
  if (paiement || note.statut !== 'A_PAYER') {
    throw new ErreurMetier('Une sélection ayant reçu un paiement ne peut plus être annulée', 409);
  }
  const [maj] = await tx.update(notesSplit).set({ statut: 'ANNULEE' }).where(eq(notesSplit.id, noteId)).returning();
  await ecrireOutbox(tx, 'notes_split', 'UPDATE', noteId, maj as unknown as Record<string, unknown>);
  let pointsRestitues = 0;
  if (note.fidelite_points > 0 && note.client_fidelite_id) {
    const [restitution] = await tx
      .insert(pointsFidelite)
      .values({
        client_id: note.client_fidelite_id,
        commande_id: commandeId,
        note_id: noteId,
        points: note.fidelite_points,
        source: 'POS',
      })
      .returning();
    await ecrireOutbox(tx, 'points_fidelite', 'INSERT', restitution!.id, restitution as unknown as Record<string, unknown>);
    const bareme = await lireBareme(tx);
    pointsRestitues = note.fidelite_points;
    const [commandeMaj] = await tx
      .update(commandes)
      .set({
        fidelite_montant: Math.max(0, c.fidelite_montant - note.fidelite_points * bareme.valeur_point_fcfa),
        updated_at: new Date(),
      })
      .where(eq(commandes.id, commandeId))
      .returning();
    await ecrireOutbox(tx, 'commandes', 'UPDATE', commandeId, commandeMaj as unknown as Record<string, unknown>);
    await recalculerTotaux(tx, commandeId);
  }
  await journaliser(tx, {
    user_id: utilisateurId,
    action: 'ANNULATION_SOUS_NOTE_ARTICLES',
    entite: 'notes_split',
    entite_id: noteId,
    montant: note.montant,
    meta: { commande_id: commandeId, numero: note.numero, points_restitues: pointsRestitues },
  });
}

export async function commandeEntierementAlloueeEtPayee(tx: DbOuTx, commandeId: string): Promise<boolean> {
  const [items, allocations] = await Promise.all([
    tx.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId)),
    allocationsActives(tx, commandeId),
  ]);
  const payeeParItem = new Map<string, number>();
  for (const allocation of allocations) {
    if (allocation.statut === 'PAYEE') {
      payeeParItem.set(allocation.commande_item_id, (payeeParItem.get(allocation.commande_item_id) ?? 0) + allocation.quantite);
    }
  }
  return items
    .filter((item) => item.statut_cuisine !== 'ANNULE')
    .every((item) => (payeeParItem.get(item.id) ?? 0) === item.quantite);
}

export async function quantiteAlloueePourItem(tx: DbOuTx, commandeId: string, itemId: string): Promise<number> {
  const allocations = await allocationsActives(tx, commandeId);
  return allocations
    .filter((allocation) => allocation.commande_item_id === itemId)
    .reduce((s, allocation) => s + allocation.quantite, 0);
}

export async function sousNoteArticlesActiveExiste(tx: DbOuTx, commandeId: string): Promise<boolean> {
  const [note] = await tx
    .select({ id: notesSplit.id })
    .from(notesSplit)
    .where(and(eq(notesSplit.commande_id, commandeId), eq(notesSplit.type, 'ARTICLES'), ne(notesSplit.statut, 'ANNULEE')))
    .limit(1);
  return !!note;
}

export async function paiementExistePourCommande(tx: DbOuTx, commandeId: string): Promise<boolean> {
  const [paiement] = await tx.select({ id: paiements.id }).from(paiements).where(eq(paiements.commande_id, commandeId)).limit(1);
  return !!paiement;
}
