import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, isNull, notInArray } from 'drizzle-orm';
import type { CommandeEnCoursVue } from '@pos/shared';
import {
  AjouterItemSchema,
  AnnulerCommandeSchema,
  AnnulerItemSchema,
  CreerCommandeSchema,
  InfosLivraisonSchema,
  ModifierItemSchema,
  RemiseSchema,
  ReouvrirSchema,
  estTableKdo,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { commandeItems, commandes, servicesCaisse, tablesSalle } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager } from '../auth/pin.js';
import { exigerAccesTable } from '../tables/propriete.js';
import { imprimerBonsEnvoi } from '../../printer/bons.js';
import {
  paiementExistePourCommande,
  quantiteAlloueePourItem,
  sousNoteArticlesActiveExiste,
} from '../paiements/sous-notes.js';
import {
  chargerCommandeVue,
  construireFactureDisponible,
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
      // Table déjà ouverte par erreur (commande sans aucun article) : on la
      // REPREND au lieu d'en ouvrir une seconde. Un numéro de ticket ne se
      // gaspille pas, et deux commandes vides sur la même table n'apportent
      // rien — elles ne feraient qu'encombrer la clôture.
      if (corps.type === 'SUR_PLACE' && corps.table_id) {
        const ouvertes = await tx
          .select({ id: commandes.id })
          .from(commandes)
          .where(
            and(
              eq(commandes.table_id, corps.table_id),
              eq(commandes.type, 'SUR_PLACE'),
              eq(commandes.statut, 'OUVERTE'),
              eq(commandes.origine, 'CAISSE'),
            ),
          )
          .for('update');
        for (const o of ouvertes) {
          const [compte] = await tx
            .select({ nb: count() })
            .from(commandeItems)
            .where(eq(commandeItems.commande_id, o.id));
          if (Number(compte?.nb ?? 0) === 0) {
            // Elle est vide : elle appartient désormais à celui qui la remplit.
            const [repris] = await tx
              .update(commandes)
              .set({ caissier_id: req.session!.utilisateur_id, service_id: service.id, updated_at: new Date() })
              .where(eq(commandes.id, o.id))
              .returning();
            await ecrireOutbox(tx, 'commandes', 'UPDATE', o.id, repris as unknown as Record<string, unknown>);
            return o.id;
          }
        }
      }

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

  /**
   * Commandes en cours (reprise depuis Tables ou Accueil).
   *
   * `nb_items` accompagne chaque ligne : une commande sans aucun article est une
   * commande ouverte par erreur, écartée partout ailleurs (§ `deriverEtat`).
   * C'est cette liste qui donne enfin un TOIT aux commandes à emporter : elles
   * n'occupent aucune table et n'apparaissaient donc sur aucun écran une fois
   * l'écran de saisie quitté — le caissier les retapait.
   */
  app.get('/api/commandes/ouvertes', { preHandler: app.exigerAuth }, async (): Promise<CommandeEnCoursVue[]> => {
    const lignes = await db
      .select({
        id: commandes.id,
        code_commande: commandes.code_commande,
        numero_ticket: commandes.numero_ticket,
        type: commandes.type,
        statut: commandes.statut,
        total: commandes.total,
        table_id: commandes.table_id,
        table_numero: tablesSalle.numero,
        partenaire: commandes.partenaire,
        created_at: commandes.created_at,
      })
      .from(commandes)
      .leftJoin(tablesSalle, eq(tablesSalle.id, commandes.table_id))
      .where(notInArray(commandes.statut, ['PAYEE', 'ANNULEE']))
      .orderBy(desc(commandes.created_at));

    const comptes = await db
      .select({ commande_id: commandeItems.commande_id, nb: count() })
      .from(commandeItems)
      .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
      .where(notInArray(commandes.statut, ['PAYEE', 'ANNULEE']))
      .groupBy(commandeItems.commande_id);
    const nbParCommande = new Map(comptes.map((c) => [c.commande_id, Number(c.nb)]));

    return lignes.map((l) => ({
      ...l,
      type: l.type as CommandeEnCoursVue['type'],
      statut: l.statut as CommandeEnCoursVue['statut'],
      table_numero: l.table_numero ?? null,
      numero_ticket: Number(l.numero_ticket),
      nb_items: nbParCommande.get(l.id) ?? 0,
      created_at: l.created_at.toISOString(),
    }));
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
    const facture = construireFactureDisponible(vue);
    if (facture.items.length === 0) {
      throw new ErreurMetier('Aucun article à facturer', 400);
    }
    await app.imprimante.imprimerFacture(facture);
    await db.transaction(async (tx) => {
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'FACTURE_IMPRIMEE',
        entite: 'commandes',
        entite_id: id,
        montant: facture.total,
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
      const quantiteAllouee = await quantiteAlloueePourItem(tx, id, itemId);
      if (corps.quantite < quantiteAllouee) {
        throw new ErreurMetier('La quantité déjà réservée ou payée ne peut pas être diminuée', 409);
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
      if ((await quantiteAlloueePourItem(tx, id, itemId)) > 0) {
        throw new ErreurMetier('Cet article est déjà réservé ou payé et ne peut plus être annulé', 409);
      }
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
      if (await sousNoteArticlesActiveExiste(tx, id)) {
        throw new ErreurMetier('La remise ne peut plus changer après la création d’un paiement par articles', 409);
      }
      const ids = await marquerEnvoiCuisine(tx, id);
      return { vue: await chargerCommandeVue(tx, id), envoyes: ids };
    });
    await imprimerBonsEnvoi(app, id, envoyes);
    app.diffuser('commande:envoyee', id);
    app.diffuser('commande', id);
    return vue;
  });

  /**
   * Infos d'une commande partenaire : n° de commande chez Yango/Glovo et
   * téléphone du client. Saisies dans la modale qui s'ouvre APRÈS le lancement
   * en cuisine — la cuisine ne doit jamais attendre après un formulaire.
   *
   * Facultatives : le caissier peut fermer sans rien mettre, et le ticket Z
   * compte alors une commande sans contact (« Yango 5 cmd · 4 contacts »). Le
   * trou est visible, il n'est pas caché.
   *
   * Modifiables tant que le shift est ouvert — un caissier qui a fermé la
   * modale doit pouvoir revenir la remplir, sinon l'information est perdue pour
   * de bon. Chaque saisie passe au journal d'audit avec son auteur : c'est la
   * pièce qu'on ressort quand un partenaire conteste une course.
   */
  app.post('/api/commandes/:id/infos-livraison', { preHandler: app.exigePermission('salle.envoyer_cuisine') }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(InfosLivraisonSchema, req.body);

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.type !== 'LIVRAISON' || !c.partenaire) {
        throw new ErreurMetier('Ces informations ne concernent que les commandes en livraison', 400);
      }
      if (c.statut === 'ANNULEE') {
        throw new ErreurMetier('Cette commande est annulée : elle n’est plus modifiable', 409);
      }
      // Le shift clôturé a déjà figé son ticket Z : y ajouter un contact ferait
      // diverger le papier du gérant de ce que lit le siège.
      if (c.service_id) {
        const [service] = await tx
          .select({ statut: servicesCaisse.statut })
          .from(servicesCaisse)
          .where(eq(servicesCaisse.id, c.service_id));
        if (service && service.statut !== 'OUVERT') {
          throw new ErreurMetier('Ce service est clôturé : ses commandes ne se modifient plus', 409);
        }
      }

      // `undefined` = champ absent du formulaire, on garde l'existant. Une
      // chaîne vide = le caissier a effacé volontairement.
      const ref = corps.ref_partenaire === undefined ? c.ref_partenaire : (corps.ref_partenaire || null);
      const contact = corps.contact_client === undefined ? c.contact_client : (corps.contact_client || null);

      const [maj] = await tx
        .update(commandes)
        .set({ ref_partenaire: ref, contact_client: contact, updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);

      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'INFOS_LIVRAISON',
        entite: 'commandes',
        entite_id: id,
        meta: {
          partenaire: c.partenaire,
          numero_ticket: Number(c.numero_ticket),
          ref_partenaire: ref,
          contact_client: contact,
        },
      });
      return chargerCommandeVue(tx, id);
    });

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
      if (await paiementExistePourCommande(tx, id)) {
        throw new ErreurMetier('La remise ne peut plus changer après un paiement', 409);
      }
      if (await sousNoteArticlesActiveExiste(tx, id)) {
        throw new ErreurMetier('Annulez d’abord les paiements par articles en attente', 409);
      }
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
      if (await paiementExistePourCommande(tx, id)) {
        throw new ErreurMetier('Une commande ayant reçu un paiement ne peut plus être annulée', 409);
      }
      if (await sousNoteArticlesActiveExiste(tx, id)) {
        throw new ErreurMetier('Annulez d’abord les paiements par articles en attente', 409);
      }
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

  /**
   * Abandon d'une commande VIDE — table ouverte par erreur.
   *
   * Le caissier ouvre une table, ne tape aucun produit et ressort : la table
   * doit redevenir LIBRE et la commande ne doit rien retenir (ni le plan de
   * salle, ni la clôture). Aucun PIN manager : il n'y a rien à cacher, aucun
   * article n'a été tapé, aucun franc n'a bougé — l'exiger apprendrait au
   * personnel à laisser traîner les fausses tables.
   *
   * Le numéro de ticket est CONSERVÉ (statut ANNULEE, jamais de suppression) :
   * la séquence ne fait jamais de trou (§ schéma).
   *
   * Idempotent et sans effet si la commande contient ne serait-ce qu'une
   * ligne : le serveur revérifie, ce n'est jamais le client qui décide.
   */
  app.post('/api/commandes/:id/abandonner', { preHandler: app.exigePermission('salle.commande') }, async (req) => {
    const { id } = req.params as { id: string };

    const resultat = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      await exigerAccesTable(tx, req.session!, c.table_id);
      if (c.statut !== 'OUVERTE') return { abandonnee: false };
      const [compte] = await tx
        .select({ nb: count() })
        .from(commandeItems)
        .where(eq(commandeItems.commande_id, id));
      if (Number(compte?.nb ?? 0) > 0) return { abandonnee: false };

      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'ANNULEE', updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await majStatutTable(tx, c.table_id, 'LIBRE');
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'ABANDON_COMMANDE_VIDE',
        entite: 'commandes',
        entite_id: id,
        montant: 0,
        motif: 'Table ouverte par erreur — aucun article tapé',
        meta: { numero_ticket: Number(c.numero_ticket), table_id: c.table_id },
      });
      return { abandonnee: true };
    });

    if (resultat.abandonnee) app.diffuser('commande', id);
    return resultat;
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
