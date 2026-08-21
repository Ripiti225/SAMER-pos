import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { estLivraisonSansEncaissement, OffrirSchema, PaiementSchema, SplitSchema } from '@pos/shared';
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

export function routesPaiements(app: FastifyInstance): void {
  const gardeCaisse = app.exigePermission('caisse.encaisser');

  /**
   * Split de note : somme des notes == total de la commande, avant tout paiement.
   * Chaque note est ensuite payée séparément (paiement mixte autorisé par note).
   */
  app.post('/api/commandes/:id/split', { preHandler: gardeCaisse }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(SplitSchema, req.body);

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut === 'PAYEE' || c.statut === 'ANNULEE') {
        throw new ErreurMetier('Cette commande ne peut plus être divisée', 409);
      }
      if (c.total <= 0) throw new ErreurMetier('Ajoutez des articles avant de diviser la note', 400);

      const dejaPaye = await tx.select().from(paiements).where(eq(paiements.commande_id, id));
      if (dejaPaye.length > 0) {
        throw new ErreurMetier('Impossible de diviser une note déjà partiellement encaissée', 409);
      }

      const somme = corps.notes.reduce((s, n) => s + n.montant, 0);
      if (somme !== c.total) {
        throw new ErreurMetier('La somme des notes doit être égale au total de la commande', 400);
      }

      await tx.delete(notesSplit).where(eq(notesSplit.commande_id, id));
      const inserees = await tx
        .insert(notesSplit)
        .values(corps.notes.map((n) => ({ commande_id: id, libelle: n.libelle, montant: n.montant })))
        .returning();
      for (const note of inserees) {
        await ecrireOutbox(tx, 'notes_split', 'INSERT', note.id, note as unknown as Record<string, unknown>);
      }
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'SPLIT_NOTE',
        entite: 'commandes',
        entite_id: id,
        montant: c.total,
        meta: { notes: corps.notes },
      });
      return chargerCommandeVue(tx, id);
    });

    app.diffuser('commande', id);
    return vue;
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
    const service = await serviceOuvertDe(db, req.session!.utilisateur_id);

    const { vue, payee } = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut === 'ANNULEE') throw new ErreurMetier('Cette commande est annulée', 409);
      if (c.statut === 'PAYEE') throw new ErreurMetier('Cette commande est déjà encaissée', 409);
      if (c.total <= 0) throw new ErreurMetier('Ajoutez des articles avant d’encaisser', 400);

      const existants = await tx.select().from(paiements).where(eq(paiements.commande_id, id));
      const dejaPaye = existants.reduce((s, p) => s + p.montant, 0);
      if (dejaPaye + corps.montant > c.total) {
        throw new ErreurMetier('Le montant dépasse le reste à payer', 400);
      }

      if (corps.note_id) {
        const [note] = await tx.select().from(notesSplit).where(eq(notesSplit.id, corps.note_id));
        if (!note || note.commande_id !== id) throw new ErreurMetier('Note de split inconnue', 404);
        const payeNote = existants
          .filter((p) => p.note_id === corps.note_id)
          .reduce((s, p) => s + p.montant, 0);
        if (payeNote + corps.montant > note.montant) {
          throw new ErreurMetier('Le montant dépasse le reste à payer de cette note', 400);
        }
      }

      const [paiement] = await tx
        .insert(paiements)
        .values({
          commande_id: id,
          note_id: corps.note_id ?? null,
          mode: corps.mode,
          montant: corps.montant,
          encaisse_par: req.session!.utilisateur_id,
          service_id: service.id,
        })
        .returning();
      await ecrireOutbox(tx, 'paiements', 'INSERT', paiement!.id, paiement as unknown as Record<string, unknown>);

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
      if (totalPaye === c.total) {
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
        if (c.client_fidelite_id) {
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
      return { vue: await chargerCommandeVue(tx, id), payee: estPayee };
    });

    if (payee) {
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
