/**
 * Annulation d'un paiement saisi par erreur (backlog du 2026-10-16, livré le
 * 2026-10-21).
 *
 * Cas réel : un ticket test encaissé en 2 000 espèces + 1 000 Wave + 2 000
 * Orange Money, tous fictifs, dans le shift encore ouvert d'une caissière.
 * Sans correction possible, elle aurait eu −2 000 au comptage à l'aveugle et
 * un ticket Z avec 3 000 de mobile money jamais reçus.
 *
 * Règles :
 * - seulement tant que le shift où le paiement a été encaissé est OUVERT —
 *   une fois clôturé, le ticket Z est figé et rien ne se corrige en caisse ;
 * - PIN ADMINISTRATEUR (propriétaire) + motif, vérifiés côté serveur ;
 * - le paiement n'est JAMAIS supprimé ni modifié : une ligne NÉGATIVE du même
 *   mode, sur le même shift et au nom du même caissier, le contre-passe. Les
 *   sommes du théorique espèces, du ticket Z, du mobile money, du cloud et de
 *   SamerTrackly (qui lit le rapport Z) retombent justes d'elles-mêmes ;
 * - fidélité : un paiement en POINTS rend ses points ; une vente qui ne l'est
 *   plus reprend les points qu'elle avait crédités ;
 * - la commande (et sa note) redevient payable, et annulable par la voie
 *   normale ;
 * - tout dans UNE transaction : contre-passation, notes, commande, points,
 *   audit `ANNULATION_PAIEMENT` et lignes outbox.
 */
import { and, eq } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { auditLog, commandes, notesSplit, paiements, pointsFidelite, servicesCaisse } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { journaliser } from '../audit/audit.js';
import { majStatutTable, verrouillerCommande } from '../commandes/service.js';
import { lireBareme, pointsPourMontant, pointsVenteCredites, SOURCE_ANNULATION_PAIEMENT } from '../fidelite/service.js';
import { paiementsActifs } from './actifs.js';
import { annulerSousNoteArticles } from './sous-notes.js';

type PaiementDb = typeof paiements.$inferSelect;

export interface ResultatAnnulation {
  commande_id: string;
  contrepassation_id: string;
}

/** Points débités par un paiement en POINTS, et le client débité. */
async function debitPointsDuPaiement(
  tx: DbOuTx,
  p: PaiementDb,
): Promise<{ client_id: string; points: number } | null> {
  // L'audit PAIEMENT_POINTS porte le nombre exact de points débités : le
  // barème a pu changer depuis, on rend ce qui a été pris, pas un recalcul.
  const audits = await tx
    .select({ meta: auditLog.meta })
    .from(auditLog)
    .where(and(eq(auditLog.action, 'PAIEMENT_POINTS'), eq(auditLog.entite_id, p.commande_id)));
  const trace = audits
    .map((a) => a.meta as { paiement_id?: string; points?: number; client_id?: string | null })
    .find((m) => m.paiement_id === p.id);
  const points = trace?.points ?? pointsPourMontant(await lireBareme(tx), p.montant);

  // Le client débité : celui de la ligne de débit (même commande, même note,
  // même nombre de points). L'audit le porte depuis le 2026-10-21 ; la ligne
  // de points reste la preuve pour les paiements plus anciens.
  let clientId = trace?.client_id ?? null;
  if (!clientId) {
    const debits = await tx
      .select({ client_id: pointsFidelite.client_id, note_id: pointsFidelite.note_id, created_at: pointsFidelite.created_at })
      .from(pointsFidelite)
      .where(and(eq(pointsFidelite.commande_id, p.commande_id), eq(pointsFidelite.points, -points)));
    const debit = debits
      .filter((d) => d.note_id === p.note_id)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    clientId = debit?.client_id ?? null;
  }
  return clientId && points > 0 ? { client_id: clientId, points } : null;
}

async function ecrirePoints(
  tx: DbOuTx,
  valeurs: { client_id: string; commande_id: string; note_id: string | null; points: number },
): Promise<void> {
  const [ligne] = await tx
    .insert(pointsFidelite)
    .values({ ...valeurs, source: SOURCE_ANNULATION_PAIEMENT })
    .returning();
  await ecrireOutbox(tx, 'points_fidelite', 'INSERT', ligne!.id, ligne as unknown as Record<string, unknown>);
}

export async function annulerPaiement(
  tx: DbOuTx,
  paiementId: string,
  motif: string,
  administrateurId: string,
  demandeParId: string,
): Promise<ResultatAnnulation> {
  const [p] = await tx.select().from(paiements).where(eq(paiements.id, paiementId));
  if (!p) throw new ErreurMetier('Paiement introuvable', 404);
  if (p.contrepasse_de) throw new ErreurMetier('Cette ligne est déjà une annulation de paiement', 409);

  // Verrou du SHIFT d'abord : la clôture prend un FOR UPDATE sur la même ligne
  // avant de figer le rapport Z. L'une attend l'autre — jamais un ticket Z
  // calculé avec un paiement qu'on est en train d'annuler. « NO KEY » : un
  // encaissement concurrent (qui ne fait que référencer le shift) n'est pas
  // bloqué, ce qui écarte l'interblocage avec le verrou de la commande.
  const [service] = await tx
    .select()
    .from(servicesCaisse)
    .where(eq(servicesCaisse.id, p.service_id))
    .for('no key update');
  if (!service || service.statut !== 'OUVERT') {
    throw new ErreurMetier(
      'Le shift de ce paiement est clôturé : son ticket Z est figé, le paiement ne peut plus être annulé en caisse',
      409,
    );
  }

  const c = await verrouillerCommande(tx, p.commande_id);
  const lignesCommande = await tx.select().from(paiements).where(eq(paiements.commande_id, c.id));
  if (!paiementsActifs(lignesCommande).some((l) => l.id === p.id)) {
    throw new ErreurMetier('Ce paiement est déjà annulé', 409);
  }

  // 1. La contre-passation : même mode, même shift, même caissier, en négatif.
  //    Le billet et la monnaie rendue sont repris en négatif aussi.
  const [contre] = await tx
    .insert(paiements)
    .values({
      commande_id: p.commande_id,
      note_id: p.note_id,
      mode: p.mode,
      montant: -p.montant,
      montant_recu: p.montant_recu === null ? null : -p.montant_recu,
      monnaie_rendue: p.monnaie_rendue === null ? null : -p.monnaie_rendue,
      encaisse_par: p.encaisse_par,
      service_id: p.service_id,
      contrepasse_de: p.id,
      annule_par: administrateurId,
      annulation_motif: motif,
    })
    .returning();
  await ecrireOutbox(tx, 'paiements', 'INSERT', contre!.id, contre as unknown as Record<string, unknown>);

  // 2. Un paiement en POINTS rend ses points au client.
  let pointsRendus = 0;
  if (p.mode === 'POINTS') {
    const debit = await debitPointsDuPaiement(tx, p);
    if (debit) {
      await ecrirePoints(tx, { client_id: debit.client_id, commande_id: c.id, note_id: p.note_id, points: debit.points });
      pointsRendus = debit.points;
    }
  }

  let pointsRetires = 0;
  const reprendreCredit = async (clientId: string | null, noteId: string | null) => {
    if (!clientId) return;
    const credites = await pointsVenteCredites(tx, c.id, noteId);
    if (credites <= 0) return;
    await ecrirePoints(tx, { client_id: clientId, commande_id: c.id, note_id: noteId, points: -credites });
    pointsRetires += credites;
  };

  // 3. La commande soldée redevient ouverte : elle n'est plus payée.
  const etaitPayee = c.statut === 'PAYEE';
  if (etaitPayee) {
    const [maj] = await tx
      .update(commandes)
      .set({ statut: 'OUVERTE', updated_at: new Date() })
      .where(eq(commandes.id, c.id))
      .returning();
    await ecrireOutbox(tx, 'commandes', 'UPDATE', c.id, maj as unknown as Record<string, unknown>);
    // Comme une réouverture : la table sur place est de nouveau occupée.
    if (c.type === 'SUR_PLACE') await majStatutTable(tx, c.table_id, 'OCCUPEE');
    // Ancien parcours sans note : les points étaient crédités sur la commande.
    if (!p.note_id) await reprendreCredit(c.client_fidelite_id, null);
  }

  // 4. La note du paiement. Si elle était soldée, la vente n'existe plus : ses
  //    points de vente sont repris. S'il lui reste un autre versement, elle
  //    redevient partiellement payée. S'il ne lui reste RIEN, elle est annulée
  //    comme une sélection jamais encaissée : ses articles redeviennent libres
  //    (et ses points utilisés en remise sont rendus). Sans ça, la commande
  //    resterait bloquée par « Annulez d'abord les paiements par articles en
  //    attente », geste que la caisse n'offre pas.
  let noteAnnulee = false;
  if (p.note_id) {
    const [note] = await tx.select().from(notesSplit).where(eq(notesSplit.id, p.note_id));
    if (note && note.statut !== 'ANNULEE') {
      if (note.statut === 'PAYEE') await reprendreCredit(note.client_fidelite_id, note.id);
      const payeNote = paiementsActifs(lignesCommande)
        .filter((l) => l.note_id === note.id && l.id !== p.id)
        .reduce((s, l) => s + l.montant, 0);
      const [noteMaj] = await tx
        .update(notesSplit)
        .set({
          statut: payeNote > 0 ? 'PARTIELLEMENT_PAYEE' : 'A_PAYER',
          // Une note n'est rattachée à un shift, et signée, qu'une fois soldée.
          service_id: null,
          payee_par: null,
          payee_le: null,
        })
        .where(eq(notesSplit.id, note.id))
        .returning();
      await ecrireOutbox(tx, 'notes_split', 'UPDATE', note.id, noteMaj as unknown as Record<string, unknown>);
      if (payeNote === 0 && note.type === 'ARTICLES') {
        // Après la contre-passation, plus aucun paiement valable sur la note :
        // l'annulation normale de la sélection s'applique (audit compris).
        await annulerSousNoteArticles(tx, c.id, note.id, administrateurId);
        noteAnnulee = true;
      }
    }
  }

  await journaliser(tx, {
    user_id: administrateurId,
    action: 'ANNULATION_PAIEMENT',
    entite: 'paiements',
    entite_id: p.id,
    montant: p.montant,
    motif,
    meta: {
      commande_id: c.id,
      numero_ticket: Number(c.numero_ticket),
      code_commande: c.code_commande,
      mode: p.mode,
      note_id: p.note_id,
      service_id: p.service_id,
      encaisse_par: p.encaisse_par,
      contrepassation_id: contre!.id,
      demande_par: demandeParId,
      commande_rouverte: etaitPayee,
      note_annulee: noteAnnulee,
      points_rendus: pointsRendus,
      points_retires: pointsRetires,
    },
  });

  return { commande_id: c.id, contrepassation_id: contre!.id };
}
