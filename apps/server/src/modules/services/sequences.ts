/**
 * Séquence de caisse (journée) : regroupe tous les shifts (services) depuis la
 * dernière fermeture. Détail par caissier, agrégation, et « rasage » par un
 * porteur de la permission `caisse.fermer_sequence` (le gérant par défaut).
 *
 * UNE SÉQUENCE = UNE JOURNÉE DE TRAVAIL, comme dans SamerTrackly. Le créneau
 * n'est PAS figé : un restaurant 24h peut commencer sa journée à 00h, à 03h ou
 * à 08h35, et elle se termine quand le dernier point se termine (00h, 01h,
 * 03h…). Un shift commencé la veille et fini le lendemain reste un shift de la
 * VEILLE. Aucune règle d'horloge ne peut donc décider seule de la composition
 * d'une journée : c'est LE GÉRANT qui choisit les shifts qu'il rase, la
 * journée calculée ne servant qu'à les pré-cocher. Corollaire : un shift
 * encore ouvert n'empêche plus de raser — il repart dans la séquence suivante.
 */
import type { FastifyInstance } from 'fastify';
import { asc, eq, inArray } from 'drizzle-orm';
import { CloturerSequenceSchema } from '@pos/shared';
import type { RapportSequence, RecapSequence, SequenceCourante, ShiftSequence } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { db } from '../../db/client.js';
import { sequencesCaisse, servicesCaisse, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';

/** Id de la séquence OUVERTE (créée à la volée si aucune). */
export async function sequenceOuverte(tx: DbOuTx): Promise<string> {
  const [existante] = await tx
    .select({ id: sequencesCaisse.id })
    .from(sequencesCaisse)
    .where(eq(sequencesCaisse.statut, 'OUVERTE'))
    .limit(1);
  if (existante) return existante.id;
  const [creee] = await tx.insert(sequencesCaisse).values({}).returning({ id: sequencesCaisse.id });
  return creee!.id;
}

function recAdditif(): Record<string, number> {
  return {};
}
function ajoute(acc: Record<string, number>, src: Record<string, number> | null | undefined): void {
  for (const [k, v] of Object.entries(src ?? {})) acc[k] = (acc[k] ?? 0) + (Number(v) || 0);
}

/**
 * Journée de travail d'un shift (AAAA-MM-JJ) : la date de son OUVERTURE.
 * Un point 16h→01h appartient donc à la veille, comme dans SamerTrackly.
 * Abidjan est à UTC+0 toute l'année (pas d'heure d'été) : la date ISO est la
 * date locale, quelle que soit l'horloge du poste.
 */
function journeeDe(ouvertLe: Date): string {
  return ouvertLe.toISOString().slice(0, 10);
}

/** Détail des shifts d'une séquence (un par caissier / relève). */
async function detailShifts(dbx: DbOuTx, sequenceId: string): Promise<ShiftSequence[]> {
  const rows = await dbx
    .select({
      id: servicesCaisse.id,
      caissier: utilisateurs.nom_complet,
      ouvert_le: servicesCaisse.ouvert_le,
      cloture_le: servicesCaisse.cloture_le,
      statut: servicesCaisse.statut,
      fond_de_caisse: servicesCaisse.fond_de_caisse,
      especes_comptees: servicesCaisse.especes_comptees,
      ecart: servicesCaisse.ecart,
      vente_totale: servicesCaisse.vente_totale,
      total_systeme: servicesCaisse.total_systeme,
      depenses: servicesCaisse.depenses,
      reconciliation: servicesCaisse.reconciliation,
    })
    .from(servicesCaisse)
    .leftJoin(utilisateurs, eq(utilisateurs.id, servicesCaisse.caissier_id))
    .where(eq(servicesCaisse.sequence_id, sequenceId))
    .orderBy(asc(servicesCaisse.ouvert_le));

  return rows.map((r) => {
    const rec = (r.reconciliation ?? {}) as {
      livraisons?: Record<string, number>;
      // Absent des shifts clôturés AVANT l'arrivée des Kdo : on retombe sur 0.
      offerts?: { nb: number; total: number };
      modes?: Record<string, number>;
    };
    return {
      service_id: r.id,
      caissier: r.caissier ?? '—',
      ouvert_le: r.ouvert_le.toISOString(),
      journee: journeeDe(r.ouvert_le),
      cloture_le: r.cloture_le ? r.cloture_le.toISOString() : null,
      statut: r.statut as 'OUVERT' | 'CLOTURE',
      fond_de_caisse: r.fond_de_caisse,
      especes_comptees: r.especes_comptees,
      ecart: r.ecart,
      vente_totale: r.vente_totale,
      total_systeme: r.total_systeme,
      depenses: r.depenses,
      livraisons: rec.livraisons ?? {},
      offerts: rec.offerts ?? { nb: 0, total: 0 },
      modes_declares: rec.modes ?? {},
    };
  });
}

/** Agrège les shifts CLÔTURÉS d'une séquence en un récap. */
function agreger(shifts: ShiftSequence[]): RecapSequence {
  const livraisons = recAdditif();
  const modes = recAdditif();
  const offerts = { nb: 0, total: 0 };
  let vente_totale = 0;
  let total_systeme = 0;
  let especes_comptees = 0;
  let depenses = 0;
  let ecart_especes = 0;
  for (const s of shifts) {
    if (s.statut !== 'CLOTURE') continue;
    vente_totale += s.vente_totale ?? 0;
    total_systeme += s.total_systeme ?? 0;
    especes_comptees += s.especes_comptees ?? 0;
    depenses += s.depenses ?? 0;
    ecart_especes += s.ecart ?? 0;
    ajoute(livraisons, s.livraisons);
    ajoute(modes, s.modes_declares);
    offerts.nb += s.offerts?.nb ?? 0;
    offerts.total += s.offerts?.total ?? 0;
  }
  return { vente_totale, total_systeme, diff: vente_totale - total_systeme, especes_comptees, depenses, ecart_especes, livraisons, offerts, modes };
}

export function routesSequences(app: FastifyInstance): void {
  const garde = app.exigePermission('caisse.fermer_sequence');

  // Séquence courante (ouverte) avec le détail par caissier — vue gérant.
  app.get('/api/sequences/courante', { preHandler: garde }, async (): Promise<SequenceCourante | null> => {
    const [seq] = await db.select().from(sequencesCaisse).where(eq(sequencesCaisse.statut, 'OUVERTE')).limit(1);
    if (!seq) return null;
    const shifts = await detailShifts(db, seq.id);
    return {
      id: seq.id,
      ouverte_le: seq.ouverte_le.toISOString(),
      shifts,
      nb_shifts_ouverts: shifts.filter((s) => s.statut === 'OUVERT').length,
      totaux: agreger(shifts),
    };
  });

  /**
   * Aperçu des totaux d'une SÉLECTION de shifts, avant rasage. Le gérant coche
   * et décoche ; le chiffre qu'il lit à l'écran doit être exactement celui que
   * le serveur figera. Aucun montant n'est additionné dans le navigateur —
   * même règle que l'addition d'une commande (§ CLAUDE.md).
   */
  app.post('/api/sequences/apercu', { preHandler: garde }, async (req): Promise<RecapSequence> => {
    const corps = valider(CloturerSequenceSchema, req.body ?? {});
    const [seq] = await db.select().from(sequencesCaisse).where(eq(sequencesCaisse.statut, 'OUVERTE')).limit(1);
    if (!seq) throw new ErreurMetier('Aucune séquence ouverte', 409);
    const tous = await detailShifts(db, seq.id);
    const demandes = corps.service_ids;
    // `agreger` ne compte que les shifts CLÔTURÉS : un shift ouvert coché par
    // erreur ne peut donc pas gonfler l'aperçu.
    return agreger(demandes ? tous.filter((s) => demandes.includes(s.service_id)) : tous);
  });

  /**
   * Fermer (raser) la séquence. Le gérant peut choisir les shifts qui
   * composent la journée (`service_ids`) — par défaut, tous les shifts
   * CLÔTURÉS. Ce qui n'est pas retenu (shift encore ouvert, ou shift clôturé
   * que le gérant range dans le lendemain) est REPORTÉ sur une nouvelle
   * séquence ouverte dans la foulée : rien ne se perd, rien ne bloque.
   *
   * Seul un shift CLÔTURÉ peut être rasé : un shift ouvert n'a ni comptage
   * aveugle ni rapport Z, il n'y a donc rien à agréger — l'inclure
   * inventerait un chiffre de vente.
   */
  app.post('/api/sequences/cloturer', { preHandler: garde }, async (req): Promise<RapportSequence> => {
    const corps = valider(CloturerSequenceSchema, req.body ?? {});

    const rapport = await db.transaction(async (tx) => {
      const [seq] = await tx
        .select()
        .from(sequencesCaisse)
        .where(eq(sequencesCaisse.statut, 'OUVERTE'))
        .limit(1)
        .for('update');
      if (!seq) throw new ErreurMetier('Aucune séquence ouverte à fermer', 409);

      const tous = await detailShifts(tx, seq.id);
      const clotures = tous.filter((s) => s.statut === 'CLOTURE');

      let retenus: ShiftSequence[];
      if (corps.service_ids) {
        const demandes = new Set(corps.service_ids);
        const connus = new Set(tous.map((s) => s.service_id));
        for (const id of demandes) {
          if (!connus.has(id)) throw new ErreurMetier('Un des shifts choisis n’appartient pas à cette séquence', 400);
        }
        const ouvertChoisi = tous.find((s) => demandes.has(s.service_id) && s.statut !== 'CLOTURE');
        if (ouvertChoisi) {
          throw new ErreurMetier(
            `Le shift de ${ouvertChoisi.caissier} est encore ouvert : il ne peut pas être rasé, seulement laissé pour la séquence suivante`,
            409,
          );
        }
        retenus = clotures.filter((s) => demandes.has(s.service_id));
      } else {
        retenus = clotures;
      }

      if (retenus.length === 0) {
        throw new ErreurMetier('Aucun shift clôturé à raser — la séquence serait vide', 409);
      }

      const retenusIds = new Set(retenus.map((s) => s.service_id));
      const reportes = tous.filter((s) => !retenusIds.has(s.service_id));

      const recap = agreger(retenus);
      const clotureeLe = new Date();
      const rapportSeq: RapportSequence = {
        ...recap,
        sequence_id: seq.id,
        ouverte_le: seq.ouverte_le.toISOString(),
        cloturee_le: clotureeLe.toISOString(),
        cloturee_par: req.session!.nom_complet,
        nb_shifts: retenus.length,
        shifts_reportes: reportes.length,
        shifts: retenus,
      };

      const [maj] = await tx
        .update(sequencesCaisse)
        .set({ statut: 'CLOTUREE', cloturee_le: clotureeLe, cloturee_par: req.session!.utilisateur_id, rapport: rapportSeq })
        .where(eq(sequencesCaisse.id, seq.id))
        .returning();
      await ecrireOutbox(tx, 'sequences_caisse', 'UPDATE', seq.id, maj as unknown as Record<string, unknown>);

      // Report : la séquence suivante s'ouvre TOUT DE SUITE et récupère les
      // shifts laissés. Après la mise à jour ci-dessus, sinon l'index unique
      // « une seule séquence OUVERTE » refuserait l'insertion.
      if (reportes.length > 0) {
        const [suivante] = await tx.insert(sequencesCaisse).values({}).returning();
        await ecrireOutbox(tx, 'sequences_caisse', 'INSERT', suivante!.id, suivante as unknown as Record<string, unknown>);
        const deplaces = await tx
          .update(servicesCaisse)
          .set({ sequence_id: suivante!.id })
          .where(inArray(servicesCaisse.id, reportes.map((s) => s.service_id)))
          .returning();
        for (const s of deplaces) {
          await ecrireOutbox(tx, 'services_caisse', 'UPDATE', s.id, s as unknown as Record<string, unknown>);
        }
      }

      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'CLOTURE_SEQUENCE',
        entite: 'sequences_caisse',
        entite_id: seq.id,
        montant: recap.vente_totale,
        meta: {
          nb_shifts: retenus.length,
          diff: recap.diff,
          shifts_reportes: reportes.map((s) => ({ service_id: s.service_id, caissier: s.caissier, statut: s.statut })),
          choix_manuel: corps.service_ids !== undefined,
        },
      });
      return rapportSeq;
    });

    // Le gérant repart avec le papier : détail de chaque shift + totaux du jour.
    // Hors transaction (une panne d'imprimante ne doit pas annuler le rasage) ;
    // le rapport reste refaisable depuis « Réimprimer le récap ».
    await app.imprimante.imprimerRapportSequence(rapport);
    app.diffuser('service', rapport.sequence_id);
    return rapport;
  });

  /**
   * Réimpression du récap d'une séquence déjà rasée (papier perdu, bourrage,
   * imprimante hors ligne au moment du rasage). Lit le rapport figé en base.
   */
  app.post('/api/sequences/:id/reimprimer', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const [seq] = await db.select().from(sequencesCaisse).where(eq(sequencesCaisse.id, id));
    if (!seq) throw new ErreurMetier('Séquence introuvable', 404);
    if (!seq.rapport) throw new ErreurMetier('Cette séquence n’a pas encore été fermée', 409);
    await app.imprimante.imprimerRapportSequence(seq.rapport as RapportSequence);
    return { ok: true };
  });
}
