import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import {
  AjouterItemSchema,
  AnnulerCommandeSchema,
  AnnulerItemSchema,
  CreerCommandeSchema,
  ModifierItemSchema,
  RemiseSchema,
  ReouvrirSchema,
  estTableKdo,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { commandeItems, commandes, tablesSalle } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager } from '../auth/pin.js';
import { exigerAccesTable } from '../tables/propriete.js';
import { imprimerBonsEnvoi } from '../../printer/bons.js';
import {
  chargerCommandeVue,
  exigerModifiable,
  figerNouvelItem,
  genererCodeCommande,
  majStatutTable,
  marquerEnvoiCuisine,
  recalculerTotaux,
  serviceOuvertDe,
  verrouillerCommande,
} from './service.js';

export function routesCommandes(app: FastifyInstance): void {
  // Nouvelle commande — exige un service ouvert (le n° de ticket est définitif)
  app.post('/api/commandes', { preHandler: app.exigePermission('salle.commande') }, async (req) => {
    const corps = valider(CreerCommandeSchema, req.body);
    const service = await serviceOuvertDe(db, req.session!.utilisateur_id);

    let partenaire = corps.partenaire ?? null;
    // Un Kdo se reconnaît à SA TABLE, jamais à un drapeau envoyé par le client :
    // offrir un repas sort de la marchandise sans contrepartie, ça ne se décide
    // pas côté navigateur.
    let offert = false;
    if (corps.table_id) {
      const [table] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, corps.table_id));
      if (!table) throw introuvable('Table');
      if (corps.type === 'LIVRAISON' && table.partenaire) partenaire = table.partenaire;
      offert = estTableKdo(table.partenaire);
    }
    if (corps.type !== 'LIVRAISON') partenaire = null;

    const vueId = await db.transaction(async (tx) => {
      const code = await genererCodeCommande(tx, corps.type, service.id);
      const [c] = await tx
        .insert(commandes)
        .values({
          type: corps.type,
          code_commande: code,
          table_id: corps.table_id ?? null,
          partenaire,
          offert,
          ref_partenaire: corps.type === 'LIVRAISON' ? (corps.ref_partenaire ?? null) : null,
          service_id: service.id,
          caissier_id: req.session!.utilisateur_id,
        })
        .returning();
      await ecrireOutbox(tx, 'commandes', 'INSERT', c!.id, c as unknown as Record<string, unknown>);
      if (corps.type === 'SUR_PLACE') await majStatutTable(tx, corps.table_id ?? null, 'OCCUPEE');
      return c!.id;
    });

    app.diffuser('commande', vueId);
    return chargerCommandeVue(db, vueId);
  });

  // Commandes en cours (reprise depuis Tables ou Accueil)
  app.get('/api/commandes/ouvertes', { preHandler: app.exigerAuth }, async () => {
    const lignes = await db
      .select({
        id: commandes.id,
        numero_ticket: commandes.numero_ticket,
        type: commandes.type,
        statut: commandes.statut,
        total: commandes.total,
        table_id: commandes.table_id,
        table_numero: tablesSalle.numero,
        created_at: commandes.created_at,
      })
      .from(commandes)
      .leftJoin(tablesSalle, eq(tablesSalle.id, commandes.table_id))
      .where(notInArray(commandes.statut, ['PAYEE', 'ANNULEE']))
      .orderBy(desc(commandes.created_at));
    return lignes.map((l) => ({ ...l, numero_ticket: Number(l.numero_ticket), created_at: l.created_at.toISOString() }));
  });

  app.get('/api/commandes/:id', { preHandler: app.exigerAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const vue = await chargerCommandeVue(db, id);
    // Propriété de table (point 3) : un serveur ne voit pas la commande d'une
    // table ouverte par un autre serveur.
    await exigerAccesTable(db, req.session!, vue.table_id);
    return vue;
  });

  // Facture (addition) AVANT paiement : imprime côté serveur (ESC/POS) et trace
  // l'impression. Le serveur ne tire PAS la facture (il la DEMANDE) : c'est
  // l'encaisseur (caisse.encaisser) qui l'imprime — le serveur, qui n'encaisse
  // pas, en est exclu.
  app.post('/api/commandes/:id/facture', { preHandler: app.exigePermission('caisse.encaisser') }, async (req) => {
    const { id } = req.params as { id: string };
    const vue = await chargerCommandeVue(db, id);
    await exigerAccesTable(db, req.session!, vue.table_id);
    if (vue.items.filter((i) => i.statut_cuisine !== 'ANNULE').length === 0) {
      throw new ErreurMetier('Aucun article à facturer', 400);
    }
    await app.imprimante.imprimerFacture(vue);
    await db.transaction(async (tx) => {
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'FACTURE_IMPRIMEE',
        entite: 'commandes',
        entite_id: id,
        montant: vue.total,
      });
    });
    return vue;
  });

  // Ajout d'un article ou d'un combo — prix et nom figés immédiatement
  app.post('/api/commandes/:id/items', { preHandler: app.exigePermission('salle.commande') }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(AjouterItemSchema, req.body);

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      exigerModifiable(c);
      await figerNouvelItem(tx, c, corps);
      await recalculerTotaux(tx, id);
      return chargerCommandeVue(tx, id);
    });

    app.diffuser('commande', id);
    return vue;
  });

  // Changement de quantité (article pas encore envoyé en cuisine)
  app.patch('/api/commandes/:id/items/:itemId', { preHandler: app.exigePermission('salle.commande') }, async (req) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const corps = valider(ModifierItemSchema, req.body);

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      exigerModifiable(c);
      const [item] = await tx
        .select()
        .from(commandeItems)
        .where(and(eq(commandeItems.id, itemId), eq(commandeItems.commande_id, id)));
      if (!item) throw introuvable('Article de la commande');
      if (item.envoye_le !== null || item.statut_cuisine !== 'A_PREPARER') {
        throw new ErreurMetier('Cet article est déjà en cuisine — passez par une annulation manager', 409);
      }
      const [maj] = await tx
        .update(commandeItems)
        .set({ quantite: corps.quantite })
        .where(eq(commandeItems.id, itemId))
        .returning();
      await ecrireOutbox(tx, 'commande_items', 'UPDATE', itemId, maj as unknown as Record<string, unknown>);
      await recalculerTotaux(tx, id);
      return chargerCommandeVue(tx, id);
    });

    app.diffuser('commande', id);
    return vue;
  });

  /**
   * Annulation d'article TRACÉE (motif obligatoire).
   * Article déjà envoyé en cuisine (statut_cuisine ≠ A_PREPARER) :
   * PIN manager obligatoire (§ actions protégées).
   */
  app.post('/api/commandes/:id/items/:itemId/annuler', { preHandler: app.exigePermission('salle.commande') }, async (req) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const corps = valider(AnnulerItemSchema, req.body);

    const [itemAvant] = await db
      .select()
      .from(commandeItems)
      .where(and(eq(commandeItems.id, itemId), eq(commandeItems.commande_id, id)));
    if (!itemAvant) throw introuvable('Article de la commande');
    if (itemAvant.statut_cuisine === 'ANNULE') throw new ErreurMetier('Cet article est déjà annulé', 409);

    // Action protégée si l'article est déjà parti en cuisine (§ CLAUDE.md)
    const dejaEnvoye = itemAvant.envoye_le !== null || itemAvant.statut_cuisine !== 'A_PREPARER';
    let annulePar = req.session!.utilisateur_id;
    if (dejaEnvoye) {
      if (!corps.pin_manager) {
        throw new ErreurMetier('Cet article est déjà en cuisine : PIN manager obligatoire', 403);
      }
      const manager = await verifierPinManager(corps.pin_manager, 'ANNULATION_ITEM');
      annulePar = manager.id;
    }

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      exigerModifiable(c);
      const [maj] = await tx
        .update(commandeItems)
        .set({ statut_cuisine: 'ANNULE', annule_par: annulePar, annule_motif: corps.motif })
        .where(eq(commandeItems.id, itemId))
        .returning();
      await ecrireOutbox(tx, 'commande_items', 'UPDATE', itemId, maj as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: annulePar,
        action: 'ANNULATION_ITEM',
        entite: 'commande_items',
        entite_id: itemId,
        montant: itemAvant.prix_unitaire * itemAvant.quantite,
        motif: corps.motif,
        meta: { commande_id: id, nom: itemAvant.nom_snapshot, statut_cuisine_avant: itemAvant.statut_cuisine },
      });
      await recalculerTotaux(tx, id);
      return chargerCommandeVue(tx, id);
    });

    // Le KDS affiche l'article barré « ANNULÉ » s'il était déjà parti en cuisine
    if (dejaEnvoye) app.diffuser('commande_item:annule', id);
    app.diffuser('commande', id);
    return vue;
  });

  /**
   * Envoi en cuisine : marque envoye_le sur les articles pas encore partis
   * (ils restent A_PREPARER — c'est le KDS qui les passera EN_COURS avec
   * « Commencer ») et passe la commande à ENVOYEE_CUISINE.
   * Ajout en plusieurs fois : seuls les NOUVEAUX articles partent (§B2).
   */
  app.post('/api/commandes/:id/envoyer', { preHandler: app.exigePermission('salle.envoyer_cuisine') }, async (req) => {
    const { id } = req.params as { id: string };
    const { vue, envoyes } = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      exigerModifiable(c);
      const ids = await marquerEnvoiCuisine(tx, id);
      return { vue: await chargerCommandeVue(tx, id), envoyes: ids };
    });
    await imprimerBonsEnvoi(app, id, envoyes);
    app.diffuser('commande:envoyee', id);
    app.diffuser('commande', id);
    return vue;
  });

  // Remise : PIN manager + motif OBLIGATOIRES (§ actions protégées), audit
  app.post('/api/commandes/:id/remise', { preHandler: app.exigePermission('caisse.remise') }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(RemiseSchema, req.body);
    const manager = await verifierPinManager(corps.pin_manager, 'REMISE');

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      exigerModifiable(c);
      if (corps.montant > c.sous_total) {
        throw new ErreurMetier('La remise ne peut pas dépasser le montant de la commande', 400);
      }
      const [maj] = await tx
        .update(commandes)
        .set({
          remise_montant: corps.montant,
          remise_par: manager.id,
          remise_motif: corps.motif,
          updated_at: new Date(),
        })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: manager.id,
        action: 'REMISE',
        entite: 'commandes',
        entite_id: id,
        montant: corps.montant,
        motif: corps.motif,
        meta: { demande_par: req.session!.utilisateur_id },
      });
      await recalculerTotaux(tx, id);
      return chargerCommandeVue(tx, id);
    });

    app.diffuser('commande', id);
    return vue;
  });

  // Annulation de toute la commande (le n° de ticket est conservé, statut ANNULEE)
  app.post('/api/commandes/:id/annuler', { preHandler: app.exigePermission('caisse.annuler_envoye') }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(AnnulerCommandeSchema, req.body);
    const manager = await verifierPinManager(corps.pin_manager, 'ANNULATION_COMMANDE');

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      exigerModifiable(c);
      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'ANNULEE', updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await majStatutTable(tx, c.table_id, 'LIBRE');
      await journaliser(tx, {
        user_id: manager.id,
        action: 'ANNULATION_COMMANDE',
        entite: 'commandes',
        entite_id: id,
        montant: c.total,
        motif: corps.motif,
        meta: { numero_ticket: Number(c.numero_ticket), demande_par: req.session!.utilisateur_id },
      });
      return chargerCommandeVue(tx, id);
    });

    app.diffuser('commande', id);
    return vue;
  });

  // Réouverture d'une commande PAYEE : PIN manager + motif (§ actions protégées)
  app.post('/api/commandes/:id/reouvrir', { preHandler: app.exigePermission('caisse.rouvrir') }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ReouvrirSchema, req.body);
    const manager = await verifierPinManager(corps.pin_manager, 'REOUVERTURE_NOTE');

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut !== 'PAYEE') throw new ErreurMetier('Seule une commande encaissée peut être rouverte', 409);
      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'OUVERTE', updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      if (c.type === 'SUR_PLACE') await majStatutTable(tx, c.table_id, 'OCCUPEE');
      await journaliser(tx, {
        user_id: manager.id,
        action: 'REOUVERTURE_NOTE',
        entite: 'commandes',
        entite_id: id,
        montant: c.total,
        motif: corps.motif,
        meta: { numero_ticket: Number(c.numero_ticket), demande_par: req.session!.utilisateur_id },
      });
      return chargerCommandeVue(tx, id);
    });

    app.diffuser('commande', id);
    return vue;
  });
}
