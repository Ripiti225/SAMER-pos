import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { CreerSousNoteSchema, estLivraisonSansEncaissement, OffrirSchema, PaiementSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { appelsTable, commandes, notesSplit, paiements } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { crediterVente } from '../fidelite/service.js';
import {
  chargerCommandeVue,
  majStatutTable,
  serviceOuvertDe,
  verrouillerCommande,
} from '../commandes/service.js';
import {
  annulerSousNoteArticles,
  commandeEntierementAlloueeEtPayee,
  creerSousNoteArticles,
} from './sous-notes.js';

export function routesPaiements(app: FastifyInstance): void {
  const gardeCaisse = app.exigePermission('caisse.encaisser');

  app.post('/api/commandes/:id/sous-notes', { preHandler: gardeCaisse }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(CreerSousNoteSchema, req.body);
    const vue = await db.transaction(async (tx) => {
      await creerSousNoteArticles(tx, id, corps, req.session!.utilisateur_id);
      return chargerCommandeVue(tx, id);
    });
    app.diffuser('commande', id);
    return vue;
  });

  app.post('/api/commandes/:id/sous-notes/:noteId/annuler', { preHandler: gardeCaisse }, async (req) => {
    const { id, noteId } = req.params as { id: string; noteId: string };
    const vue = await db.transaction(async (tx) => {
      await annulerSousNoteArticles(tx, id, noteId, req.session!.utilisateur_id);
      return chargerCommandeVue(tx, id);
    });
    app.diffuser('commande', id);
    return vue;
  });

  app.post('/api/commandes/:id/sous-notes/:noteId/imprimer', { preHandler: gardeCaisse }, async (req) => {
    const { id, noteId } = req.params as { id: string; noteId: string };
    const vue = await chargerCommandeVue(db, id);
    const note = vue.notes.find((candidate) => candidate.id === noteId);
    if (!note || note.statut !== 'PAYEE') throw new ErreurMetier('Seul un paiement soldé peut être réimprimé', 409);
    await app.imprimante.imprimerSousNote(vue, note);
    return { ok: true };
  });

  // Conservée pour qu'une ancienne PWA affiche un message clair après le
  // déploiement. Les notes MONTANT_HISTORIQUE déjà en base restent encaissables
  // via /paiements, mais aucune nouvelle division monétaire n'est créée.
  app.post('/api/commandes/:id/split', { preHandler: gardeCaisse }, async () => {
    throw new ErreurMetier('Le partage par montant a été remplacé par « Payer par articles »', 410);
  });

  /**
   * Enregistrement d'un paiement (manuel, aucune API de mobile money).
   * Paiement mixte : plusieurs lignes jusqu'à couvrir le total.
   * La commande passe à PAYEE UNIQUEMENT quand SUM(paiements) == total,
   * vérifié ici en transaction avec la commande verrouillée.
   */
  app.post('/api/commandes/:id/paiements', { preHandler: gardeCaisse }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(PaiementSchema, req.body);

    // Le billet posé sur le comptoir n'a de sens qu'en espèces : un paiement
    // Wave ne rend pas de monnaie. On calcule le rendu ICI — la caisse ne
    // transmet que ce que le caissier a vu, jamais un montant calculé.
    const montantRecu = corps.mode === 'ESPECES' ? corps.montant_recu ?? null : null;
    if (montantRecu !== null && montantRecu < corps.montant) {
      throw new ErreurMetier('Les espèces reçues sont inférieures au montant encaissé', 400);
    }
    const monnaieRendue = montantRecu === null ? null : montantRecu - corps.montant;

    const service = await serviceOuvertDe(db, req.session!.utilisateur_id);

    const { vue, payee, notePayeeId } = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut === 'ANNULEE') throw new ErreurMetier('Cette commande est annulée', 409);
      if (c.statut === 'PAYEE') throw new ErreurMetier('Cette commande est déjà encaissée', 409);
      if (c.total <= 0) throw new ErreurMetier('Ajoutez des articles avant d’encaisser', 400);

      const existants = await tx.select().from(paiements).where(eq(paiements.commande_id, id));
      let noteId = corps.note_id ?? null;
      let notesCommande = await tx.select().from(notesSplit).where(eq(notesSplit.commande_id, id));
      // Paiement simple : l'API crée elle-même une sous-note ARTICLES couvrant
      // tout le disponible. On conserve ainsi le parcours en un geste et les
      // anciens clients API, sans ouvrir une nouvelle voie hors allocations.
      if (!noteId && notesCommande.length === 0 && existants.length === 0) {
        const vueCourante = await chargerCommandeVue(tx, id);
        const selection = vueCourante.items
          .filter((item) => item.statut_cuisine !== 'ANNULE' && item.quantite_disponible > 0)
          .map((item) => ({ commande_item_id: item.id, quantite: item.quantite_disponible }));
        noteId = await creerSousNoteArticles(tx, id, {
          items: selection,
          client_fidelite_id: c.client_fidelite_id,
          fidelite_points: 0,
        }, req.session!.utilisateur_id);
        notesCommande = await tx.select().from(notesSplit).where(eq(notesSplit.commande_id, id));
      }
      // Compatibilité des clients qui encaissent encore sans `note_id` : une
      // fois le premier versement enregistré, reprendre l'unique sous-note en
      // cours. Une sélection explicite encore vierge reste, elle, obligatoire
      // afin de ne jamais choisir silencieusement le convive à encaisser.
      if (!noteId && existants.length > 0) {
        const actives = notesCommande.filter((note) => note.type === 'ARTICLES' && note.statut !== 'ANNULEE');
        if (actives.length === 1 && existants.every((paiement) => paiement.note_id === actives[0]!.id)) {
          noteId = actives[0]!.id;
        }
      }
      const fluxArticles = notesCommande.some((note) => note.type === 'ARTICLES' && note.statut !== 'ANNULEE');
      if (fluxArticles && !noteId) {
        throw new ErreurMetier('Choisissez le paiement par articles à encaisser', 400);
      }
      const dejaPaye = existants.reduce((s, p) => s + p.montant, 0);
      if (dejaPaye + corps.montant > c.total) {
        throw new ErreurMetier('Le montant dépasse le reste à payer', 400);
      }

      let noteCible: typeof notesSplit.$inferSelect | null = null;
      if (noteId) {
        const [note] = await tx.select().from(notesSplit).where(eq(notesSplit.id, noteId));
        if (!note || note.commande_id !== id) throw new ErreurMetier('Note de split inconnue', 404);
        if (note.statut === 'ANNULEE') throw new ErreurMetier('Ce paiement par articles est annulé', 409);
        if (note.statut === 'PAYEE') throw new ErreurMetier('Ce paiement par articles est déjà soldé', 409);
        noteCible = note;
        const payeNote = existants
          .filter((p) => p.note_id === noteId)
          .reduce((s, p) => s + p.montant, 0);
        if (payeNote + corps.montant > note.montant) {
          throw new ErreurMetier('Le montant dépasse le reste à payer de cette note', 400);
        }
      }

      const [paiement] = await tx
        .insert(paiements)
        .values({
          commande_id: id,
          note_id: noteId,
          mode: corps.mode,
          montant: corps.montant,
          montant_recu: montantRecu,
          monnaie_rendue: monnaieRendue,
          encaisse_par: req.session!.utilisateur_id,
          service_id: service.id,
        })
        .returning();
      await ecrireOutbox(tx, 'paiements', 'INSERT', paiement!.id, paiement as unknown as Record<string, unknown>);
      if (noteCible) {
        await journaliser(tx, {
          user_id: req.session!.utilisateur_id,
          action: 'PAIEMENT_SOUS_NOTE',
          entite: 'notes_split',
          entite_id: noteCible.id,
          montant: corps.montant,
          meta: {
            commande_id: id,
            numero: noteCible.numero,
            paiement_id: paiement!.id,
            mode: corps.mode,
            montant_recu: montantRecu,
            monnaie_rendue: monnaieRendue,
          },
        });
      }

      let notePayeeId: string | null = null;
      if (noteCible) {
        const payeAvant = existants.filter((p) => p.note_id === noteCible!.id).reduce((s, p) => s + p.montant, 0);
        const noteSoldee = payeAvant + corps.montant === noteCible.montant;
        const [noteMaj] = await tx
          .update(notesSplit)
          .set(noteSoldee
            ? {
                statut: 'PAYEE',
                service_id: service.id,
                payee_par: req.session!.utilisateur_id,
                payee_le: new Date(),
              }
            : { statut: 'PARTIELLEMENT_PAYEE' })
          .where(eq(notesSplit.id, noteCible.id))
          .returning();
        await ecrireOutbox(tx, 'notes_split', 'UPDATE', noteCible.id, noteMaj as unknown as Record<string, unknown>);
        if (noteSoldee) {
          if (noteCible.type === 'ARTICLES') notePayeeId = noteCible.id;
          if (noteCible.type === 'ARTICLES' && noteCible.client_fidelite_id) {
            await crediterVente(tx, noteCible.client_fidelite_id, id, noteCible.montant, noteCible.id);
          }
        }
      }

      // Une commande prise sur tablette (sans service) est rattachée au
      // service du caissier qui l'encaisse : elle comptera dans SON rapport Z.
      if (c.service_id === null) {
        const [maj] = await tx
          .update(commandes)
          .set({ service_id: service.id, updated_at: new Date() })
          .where(eq(commandes.id, id))
          .returning();
        await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
        c.service_id = service.id;
      }

      const totalPaye = dejaPaye + corps.montant;
      let estPayee = false;
      const toutesQuantitesPayees = fluxArticles ? await commandeEntierementAlloueeEtPayee(tx, id) : true;
      if (totalPaye === c.total && toutesQuantitesPayees) {
        estPayee = true;
        const [maj] = await tx
          .update(commandes)
          .set({ statut: 'PAYEE', updated_at: new Date() })
          .where(eq(commandes.id, id))
          .returning();
        await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
        await majStatutTable(tx, c.table_id, 'LIBRE');
        // CORRECTIONS3 point 4 : l'encaissement efface les appels/badges
        // résiduels de la table (traités par le caissier).
        if (c.table_id) {
          await tx
            .update(appelsTable)
            .set({ statut: 'TRAITE', traite_le: new Date(), traite_par: req.session!.utilisateur_id })
            .where(and(eq(appelsTable.table_id, c.table_id), eq(appelsTable.statut, 'EN_ATTENTE')));
        }
        // Sprint 4 B : crédit des points fidélité, dans la transaction du paiement.
        if (!fluxArticles && c.client_fidelite_id) {
          await crediterVente(tx, c.client_fidelite_id, id, c.total);
        }
        await journaliser(tx, {
          user_id: req.session!.utilisateur_id,
          action: 'PAIEMENT',
          entite: 'commandes',
          entite_id: id,
          montant: c.total,
          meta: { numero_ticket: Number(c.numero_ticket), modes: [...existants.map((p) => p.mode), corps.mode] },
        });
      }
      return { vue: await chargerCommandeVue(tx, id), payee: estPayee, notePayeeId };
    });

    if (notePayeeId) {
      const note = vue.notes.find((n) => n.id === notePayeeId);
      if (note) {
        try {
          await app.imprimante.imprimerSousNote(vue, note);
        } catch (erreur) {
          app.log.error({ erreur, commande_id: id, note_id: note.id }, 'Échec impression sous-note après encaissement');
        }
      }
    } else if (payee) {
      await app.imprimante.imprimerTicket(vue);
    }
    app.diffuser('commande', id);
    return vue;
  });

  /**
   * Clôture d'une livraison EXTERNE (Yango/Glovo) : le client règle chez le
   * partenaire, jamais en caisse. La commande passe à PAYEE SANS ligne de
   * paiement — son montant est compté à part (bucket « livraisons » du rapport
   * Z), hors du théorique espèces. Samer Deliv est refusé ici : il encaisse
   * normalement via /paiements.
   */
  app.post('/api/commandes/:id/cloturer-livraison', { preHandler: gardeCaisse }, async (req) => {
    const { id } = req.params as { id: string };
    const service = await serviceOuvertDe(db, req.session!.utilisateur_id);

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut === 'ANNULEE') throw new ErreurMetier('Cette commande est annulée', 409);
      if (c.statut === 'PAYEE') throw new ErreurMetier('Cette commande est déjà clôturée', 409);
      if (c.total <= 0) throw new ErreurMetier('Ajoutez des articles avant de clôturer', 400);
      if (!estLivraisonSansEncaissement(c.partenaire)) {
        throw new ErreurMetier('Cette commande s’encaisse normalement', 400);
      }

      // Rattachement au service du caissier (comme un paiement) pour l'audit et
      // la comptabilisation dans SON rapport Z.
      const serviceId = c.service_id ?? service.id;
      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'PAYEE', service_id: serviceId, updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await majStatutTable(tx, c.table_id, 'LIBRE');
      // Fidélité : crédit des points même sans encaissement en caisse.
      if (c.client_fidelite_id) {
        await crediterVente(tx, c.client_fidelite_id, id, c.total);
      }
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'PAIEMENT',
        entite: 'commandes',
        entite_id: id,
        montant: c.total,
        meta: { numero_ticket: Number(c.numero_ticket), livraison: true, partenaire: c.partenaire },
      });
      return chargerCommandeVue(tx, id);
    });

    await app.imprimante.imprimerTicket(vue);
    app.diffuser('commande', id);
    return vue;
  });

  /**
   * Kdo : clôture d'un repas OFFERT, sans aucune ligne de paiement.
   *
   * Conséquence comptable voulue (décision client) : la commande compte dans la
   * vente du shift — vendre 25 000 et offrir 5 000 affiche 30 000 — mais le
   * théorique espèces ne bouge pas d'un franc, puisqu'il se calcule sur les
   * paiements encaissés. Le tiroir reste donc juste, sans écart.
   *
   * Le motif est obligatoire : c'est la seule trace qui distingue un geste
   * commercial d'une marchandise qui sort sans raison.
   */
  app.post('/api/commandes/:id/offrir', { preHandler: gardeCaisse }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(OffrirSchema, req.body);
    const service = await serviceOuvertDe(db, req.session!.utilisateur_id);

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut === 'ANNULEE') throw new ErreurMetier('Cette commande est annulée', 409);
      if (c.statut === 'PAYEE') throw new ErreurMetier('Cette commande est déjà clôturée', 409);
      if (!c.offert) throw new ErreurMetier('Cette commande n’est pas un Kdo', 400);
      if (c.total <= 0) throw new ErreurMetier('Ajoutez des articles avant de valider le Kdo', 400);

      const serviceId = c.service_id ?? service.id;
      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'PAYEE', motif_offert: corps.motif, service_id: serviceId, updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await majStatutTable(tx, c.table_id, 'LIBRE');
      // Pas de crédit de fidélité : un repas offert n'est pas un achat.
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'COMMANDE_OFFERTE',
        entite: 'commandes',
        entite_id: id,
        montant: c.total,
        motif: corps.motif,
        meta: { numero_ticket: Number(c.numero_ticket), code_commande: c.code_commande },
      });
      return chargerCommandeVue(tx, id);
    });

    await app.imprimante.imprimerTicket(vue);
    app.diffuser('commande', id);
    return vue;
  });
}
