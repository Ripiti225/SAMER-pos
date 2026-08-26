import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { CloturerServiceSchema, OuvrirServiceSchema, TransfererServiceSchema } from '@pos/shared';
import type { RapportZ } from '@pos/shared';
import { db } from '../../db/client.js';
import { commandes, depenses, equipeService, parametresLocaux, roles, servicesCaisse, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinUtilisateur } from '../auth/pin.js';
import { abandonnerCommandesVidesDuService } from '../commandes/service.js';
import { calculerStatsService, reconciliationAuto, retoursDuService } from './rapport.js';
import { sequenceOuverte } from './sequences.js';
import { totalDepenses } from '../depenses/service.js';
import { etatInventaire } from '../inventaire/service.js';
import { aPermission } from '../../plugins/sessions.js';
import { permissionsDuRole } from '../roles/service.js';
import type { OccupationCaisse, ReconciliationPreview } from '@pos/shared';

/** Vue publique d'un service : ne contient JAMAIS especes_theorique tant que non clôturé. */
function vueService(s: typeof servicesCaisse.$inferSelect) {
  return {
    id: s.id,
    fond_de_caisse: s.fond_de_caisse,
    ouvert_le: s.ouvert_le.toISOString(),
    statut: s.statut as 'OUVERT' | 'CLOTURE',
  };
}

/** Shifts actuellement OUVERTS, avec le nom du caissier (un seul attendu). */
async function servicesOuverts(): Promise<{ id: string; caissier_id: string; caissier: string; ouvert_le: Date }[]> {
  const lignes = await db
    .select({
      id: servicesCaisse.id,
      caissier_id: servicesCaisse.caissier_id,
      caissier: utilisateurs.nom_complet,
      ouvert_le: servicesCaisse.ouvert_le,
    })
    .from(servicesCaisse)
    .leftJoin(utilisateurs, eq(utilisateurs.id, servicesCaisse.caissier_id))
    .where(eq(servicesCaisse.statut, 'OUVERT'));
  return lignes.map((l) => ({ ...l, caissier: l.caissier ?? 'Un collègue' }));
}

export function routesServices(app: FastifyInstance): void {
  const gardeCaisse = app.exigePermission('caisse.service.ouvrir');

  /**
   * Caisse occupée ? Renvoie le shift ouvert par QUELQU'UN D'AUTRE, pour que
   * l'écran d'ouverture explique le blocage au lieu d'attendre l'erreur 409.
   * N'expose aucun montant (comptage à l'aveugle intact).
   */
  app.get('/api/services/occupation', { preHandler: app.exigerAuth }, async (req): Promise<OccupationCaisse> => {
    const autre = (await servicesOuverts()).find((s) => s.caissier_id !== req.session!.utilisateur_id);
    return autre
      ? { occupee: true, caissier: autre.caissier, ouvert_le: autre.ouvert_le.toISOString() }
      : { occupee: false, caissier: null, ouvert_le: null };
  });

  // Employés actifs proposés pour l'équipe du jour, avec un poste par défaut.
  app.get('/api/services/equipe-proposee', { preHandler: gardeCaisse }, async () => {
    const lignes = await db
      .select({
        utilisateur_id: utilisateurs.id,
        nom_complet: utilisateurs.nom_complet,
        poste_cuisine: utilisateurs.poste_cuisine,
        role_nom: roles.nom,
      })
      .from(utilisateurs)
      .leftJoin(roles, eq(roles.id, utilisateurs.role_id))
      .where(eq(utilisateurs.actif, true))
      .orderBy(utilisateurs.nom_complet);
    const parRole: Record<string, string> = { CAISSIER: 'CAISSIER', SERVEUR: 'SERVEUR', MANAGER: 'MANAGER' };
    return lignes.map((l) => ({
      utilisateur_id: l.utilisateur_id,
      nom_complet: l.nom_complet,
      poste_defaut: l.poste_cuisine ?? parRole[l.role_nom ?? ''] ?? 'CAISSIER',
    }));
  });

  // Ouverture de service : saisie du fond de caisse
  app.post('/api/services/ouvrir', { preHandler: gardeCaisse }, async (req) => {
    const corps = valider(OuvrirServiceSchema, req.body);
    const caissierId = req.session!.utilisateur_id;

    const ouverts = await servicesOuverts();
    if (ouverts.some((s) => s.caissier_id === caissierId)) {
      throw new ErreurMetier('Vous avez déjà un service ouvert — terminez-le avant d’en ouvrir un autre', 409);
    }
    // Un seul shift à la fois sur la caisse : tant que la collègue en poste n'a
    // pas fait « J'ai fini », personne d'autre ne peut ouvrir le sien (un seul
    // tiroir, un seul comptage). La relève passe par « Transférer ».
    const autre = ouverts[0];
    if (autre) {
      throw new ErreurMetier(
        `${autre.caissier} a encore un shift en cours — il doit d’abord le clôturer (« J’ai fini »)`,
        409,
      );
    }

    const service = await db.transaction(async (tx) => {
      // Rattache le shift à la séquence ouverte (créée à la volée si aucune).
      const sequenceId = await sequenceOuverte(tx);
      const [s] = await tx
        .insert(servicesCaisse)
        .values({ caissier_id: caissierId, fond_de_caisse: corps.fond_de_caisse, sequence_id: sequenceId })
        .returning();
      await ecrireOutbox(tx, 'services_caisse', 'INSERT', s!.id, s as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: caissierId,
        action: 'OUVERTURE_SERVICE',
        entite: 'services_caisse',
        entite_id: s!.id,
        montant: corps.fond_de_caisse,
      });

      // Équipe du jour : présents + poste du jour (remonte au back-office).
      // Cocher quelqu'un ici, c'est déclarer qu'il EST là : son arrivée est
      // datée de l'ouverture (§ 6.7). Les retardataires sont pointés ensuite
      // depuis le bandeau de l'accueil, à l'heure de leur propre clic.
      const ouvertureLe = new Date();
      for (const m of corps.equipe ?? []) {
        const [membre] = await tx
          .insert(equipeService)
          .values({
            service_id: s!.id,
            utilisateur_id: m.utilisateur_id,
            poste_jour: m.poste_jour,
            pointe_le: ouvertureLe,
          })
          .onConflictDoNothing()
          .returning();
        if (membre) await ecrireOutbox(tx, 'equipe_service', 'INSERT', membre.id, membre as unknown as Record<string, unknown>);
      }

      // Rattache au nouveau service les commandes reçues par transfert
      // pendant que ce caissier n'avait pas encore de service ouvert.
      const transferees = await tx
        .select()
        .from(commandes)
        .where(
          and(
            eq(commandes.caissier_id, caissierId),
            isNull(commandes.service_id),
            notInArray(commandes.statut, ['PAYEE', 'ANNULEE']),
          ),
        );
      for (const c of transferees) {
        const [maj] = await tx
          .update(commandes)
          .set({ service_id: s!.id, updated_at: new Date() })
          .where(eq(commandes.id, c.id))
          .returning();
        await ecrireOutbox(tx, 'commandes', 'UPDATE', c.id, maj as unknown as Record<string, unknown>);
      }
      return s!;
    });

    return vueService(service);
  });

  // Service en cours du caissier connecté (jamais le théorique — §14.3)
  app.get('/api/services/courant', { preHandler: app.exigerAuth }, async (req) => {
    const [service] = await db
      .select()
      .from(servicesCaisse)
      .where(
        and(eq(servicesCaisse.caissier_id, req.session!.utilisateur_id), eq(servicesCaisse.statut, 'OUVERT')),
      );
    return service ? vueService(service) : null;
  });

  /**
   * Valeurs auto du formulaire de fermeture : fond, livraisons et modes
   * ÉLECTRONIQUES (Wave/OM/MTN/Moov/Carte/Djamo). N'expose NI les espèces
   * système NI le total (comptage à l'aveugle préservé — §14.3).
   */
  app.get('/api/services/reconciliation-preview', { preHandler: gardeCaisse }, async (req): Promise<ReconciliationPreview> => {
    const [service] = await db
      .select()
      .from(servicesCaisse)
      .where(and(eq(servicesCaisse.caissier_id, req.session!.utilisateur_id), eq(servicesCaisse.statut, 'OUVERT')));
    if (!service) throw new ErreurMetier('Aucun service ouvert', 409);
    const auto = await reconciliationAuto(db, service.id);
    const modes = { ...auto.modes };
    delete (modes as Record<string, number>).ESPECES; // jamais révélé avant comptage
    const inventaire = await db.transaction(async (tx) => etatInventaire(tx, service.id));
    const [compteDepenses] = await db
      .select({ n: sql<string>`COUNT(*)` })
      .from(depenses)
      .where(eq(depenses.service_id, service.id));
    // Les offerts sont affichés pour information : le caissier ne peut rien y
    // saisir (aucun encaissement), mais il doit les voir pour comprendre l'écart
    // entre ce qu'il a vendu et ce qu'il a dans le tiroir.
    return {
      fond_de_caisse: service.fond_de_caisse,
      livraisons: auto.livraisons,
      offerts: auto.offerts,
      modes,
      depenses: {
        total: await totalDepenses(db, service.id),
        nb_lignes: Number(compteDepenses?.n ?? 0),
      },
      inventaire: {
        valide: inventaire.inventaire.valide,
        debloque: inventaire.inventaire.debloque_par !== null,
        restants_a_compter: inventaire.bilan.a_compter,
      },
      // Retours : information, en lecture seule comme les dépenses. Le caissier
      // n'a rien à saisir — la liste vient des annulations d'articles déjà
      // partis en cuisine, chacune faite au PIN manager.
      retours: await retoursDuService(db, service.id),
    };
  });

  // Accusé de fin : le caissier valide son ticket (bouton « Terminer »). Le shift
  // clôturé n'est plus un « point à valider » et ne le renvoie plus au ticket.
  app.post('/api/services/remettre-cloture', { preHandler: app.exigerAuth }, async (req) => {
    await db
      .update(servicesCaisse)
      .set({ remis_le: new Date() })
      .where(
        and(
          eq(servicesCaisse.caissier_id, req.session!.utilisateur_id),
          eq(servicesCaisse.statut, 'CLOTURE'),
          isNull(servicesCaisse.remis_le),
        ),
      );
    return { ok: true };
  });

  /**
   * Relève de caisse : transfère TOUTES les commandes en cours du service
   * du caissier connecté vers le caissier suivant. Le receveur accepte le
   * transfert en saisissant SON PIN (verrouillage anti-force brute appliqué).
   * Si le receveur n'a pas encore de service ouvert, les commandes restent
   * à lui sans service et seront rattachées à l'ouverture de son service.
   *
   * LE RECEVEUR PEUT ÊTRE LE DONNEUR LUI-MÊME : un caissier enchaîne parfois
   * deux tranches (16h-00h puis 00h-08h) et doit pouvoir clôturer la première
   * sans avoir à liquider ses tables ni à les prêter à un collègue. Ses
   * commandes sont alors simplement DÉTACHÉES du shift qui se ferme ; elles se
   * rattachent toutes seules au shift suivant qu'il ouvre.
   */
  app.post('/api/services/transferer', { preHandler: gardeCaisse }, async (req) => {
    const corps = valider(TransfererServiceSchema, req.body);
    const donneurId = req.session!.utilisateur_id;
    const memeCaissier = corps.receveur_id === donneurId;

    const [receveur] = await db
      .select()
      .from(utilisateurs)
      .where(and(eq(utilisateurs.id, corps.receveur_id), eq(utilisateurs.actif, true)));
    if (!receveur) throw introuvable('Caissier receveur');
    if (!(await permissionsDuRole(receveur.role_id)).has('caisse.service.ouvrir')) {
      throw new ErreurMetier('Ce collègue ne peut pas tenir la caisse', 400);
    }

    // Acceptation par le receveur : c'est SON PIN qui valide le transfert
    await verifierPinUtilisateur(receveur.id, corps.pin_receveur);

    const resultat = await db.transaction(async (tx) => {
      const lignes = await tx
        .select()
        .from(servicesCaisse)
        .where(and(eq(servicesCaisse.caissier_id, donneurId), eq(servicesCaisse.statut, 'OUVERT')))
        .for('update');
      const serviceDonneur = lignes[0];
      if (!serviceDonneur) throw new ErreurMetier('Aucun service ouvert', 409);

      const enCours = await tx
        .select()
        .from(commandes)
        .where(
          and(eq(commandes.service_id, serviceDonneur.id), notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])),
        );
      if (enCours.length === 0) {
        throw new ErreurMetier('Aucune commande en cours à transférer', 409);
      }

      // Relève vers soi-même : le seul service ouvert du receveur EST celui
      // qu'on est en train de vider. On détache (service_id NULL) au lieu d'y
      // remettre les commandes, sinon la clôture resterait bloquée.
      const [serviceReceveur] = memeCaissier
        ? [undefined]
        : await tx
            .select()
            .from(servicesCaisse)
            .where(and(eq(servicesCaisse.caissier_id, receveur.id), eq(servicesCaisse.statut, 'OUVERT')));

      for (const c of enCours) {
        const [maj] = await tx
          .update(commandes)
          .set({
            caissier_id: receveur.id,
            service_id: serviceReceveur?.id ?? null,
            updated_at: new Date(),
          })
          .where(eq(commandes.id, c.id))
          .returning();
        await ecrireOutbox(tx, 'commandes', 'UPDATE', c.id, maj as unknown as Record<string, unknown>);
      }

      await journaliser(tx, {
        user_id: donneurId,
        action: 'TRANSFERT_COMMANDES',
        entite: 'services_caisse',
        entite_id: serviceDonneur.id,
        montant: enCours.reduce((s, c) => s + c.total, 0),
        meta: {
          receveur_id: receveur.id,
          receveur_nom: receveur.nom_complet,
          accepte_par_pin: true,
          // Enchaînement de deux tranches par le même caissier : ce n'est pas
          // une relève, il faut pouvoir le distinguer dans le journal.
          meme_caissier: memeCaissier,
          tickets: enCours.map((c) => Number(c.numero_ticket)),
        },
      });

      return {
        nb_transferees: enCours.length,
        receveur: receveur.nom_complet,
        meme_caissier: memeCaissier,
        tickets: enCours.map((c) => Number(c.numero_ticket)),
      };
    });

    app.diffuser('commande');
    return resultat;
  });

  /**
   * « J'ai fini » — clôture avec COMPTAGE À L'AVEUGLE (§14.3).
   * Le théorique n'est calculé et révélé QU'APRÈS enregistrement du comptage :
   * cette route est le seul endroit où il est calculé, et il n'existe aucune
   * route qui le renvoie pour un service encore OUVERT.
   */
  app.post('/api/services/cloturer', { preHandler: app.exigePermission('caisse.cloturer') }, async (req) => {
    const corps = valider(CloturerServiceSchema, req.body);
    const caissierId = req.session!.utilisateur_id;

    const rapport = await db.transaction(async (tx) => {
      const lignes = await tx
        .select()
        .from(servicesCaisse)
        .where(and(eq(servicesCaisse.caissier_id, caissierId), eq(servicesCaisse.statut, 'OUVERT')))
        .for('update');
      const service = lignes[0];
      if (!service) throw new ErreurMetier('Aucun service ouvert à clôturer', 409);

      // Tables ouvertes par erreur : aucun article tapé, rien à encaisser.
      // Elles sont abandonnées ici plutôt que de bloquer « J'ai fini ».
      const vides = await abandonnerCommandesVidesDuService(tx, service.id);
      if (vides.length > 0) {
        await journaliser(tx, {
          user_id: caissierId,
          action: 'ABANDON_COMMANDE_VIDE',
          entite: 'services_caisse',
          entite_id: service.id,
          montant: 0,
          motif: 'Tables ouvertes par erreur — aucun article tapé',
          meta: { tickets: vides.map((c) => c.numero_ticket) },
        });
      }

      const enCours = await tx
        .select({ id: commandes.id })
        .from(commandes)
        .where(
          and(eq(commandes.service_id, service.id), notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])),
        );
      if (enCours.length > 0) {
        throw new ErreurMetier(
          `Encaissez, annulez ou transférez d’abord les ${enCours.length} commande(s) en cours avant de clôturer`,
          409,
        );
      }

      /**
       * Verrou d'inventaire (§ 6.10) : sans inventaire validé, pas de clôture.
       * Appliqué ICI, côté serveur — l'encart rouge de l'écran ne fait que le
       * refléter, et une caisse qui contournerait l'UI se heurte au même mur.
       * Le déblocage manager (PIN + motif, tracé) est la seule dérogation.
       */
      const inventaire = await etatInventaire(tx, service.id);
      if (!inventaire.cloture_autorisee) {
        throw new ErreurMetier(
          `Inventaire non validé : il reste ${inventaire.bilan.a_compter} produit(s) à compter — ` +
            'comptez-les, ou faites débloquer par un manager',
          409,
        );
      }

      /**
       * Départs (§ 6.8) : à la clôture, toute personne non marquée « Reste »
       * est enregistrée comme PARTIE. Le caissier ne marque que les exceptions,
       * le cas courant ne lui demande aucun geste.
       */
      await tx
        .update(equipeService)
        .set({ reste: false })
        .where(and(eq(equipeService.service_id, service.id), isNull(equipeService.reste)));
      const membres = await tx
        .select({ reste: equipeService.reste, pointe_le: equipeService.pointe_le })
        .from(equipeService)
        .where(eq(equipeService.service_id, service.id));
      const equipe = {
        presents: membres.filter((m) => m.pointe_le !== null).length,
        restent: membres.filter((m) => m.reste === true).length,
        partis: membres.filter((m) => m.reste === false).length,
      };

      const stats = await calculerStatsService(tx, service.id);
      const auto = await reconciliationAuto(tx, service.id);
      /**
       * Dépenses : SOMME du registre (§ 6.8), calculée ici. La valeur envoyée
       * par la caisse n'est plus lue — la ligne est en lecture seule à l'écran,
       * et un total saisi à la main pouvait diverger de ses propres lignes.
       */
      const montantDepenses = await totalDepenses(tx, service.id);
      // Théorique = fond + espèces encaissées (HORS livraisons externes) − les
      // dépenses payées en espèces depuis le tiroir. L'argent du tiroir est
      // fongible : une dépense sort du tiroir (fond ou recette), donc sans la
      // déduire une dépense légitime apparaîtrait comme un manquant. Comptage
      // aveugle préservé (le théorique n'est jamais exposé avant la saisie).
      const especesTheorique = service.fond_de_caisse + auto.modes.ESPECES - montantDepenses;
      const ecart = corps.especes_comptees - especesTheorique;
      const clotureLe = new Date();

      /**
       * Livraisons partenaires : NON MODIFIABLES (décision du 2026-08-15). Le
       * POS est la source officielle des ventes ; un montant retouché à la
       * clôture créerait un écart entre le ticket Z et les commandes réellement
       * enregistrées. On prend donc le calcul serveur et on ignore ce que la
       * caisse envoie — appliquer la règle côté UI seulement laisserait un appel
       * direct à l'API la contourner.
       */
      const livraisons = auto.livraisons;
      const modesDeclares = corps.modes ?? {};
      const somme = (o: Record<string, number>) => Object.values(o).reduce((s, v) => s + (Number(v) || 0), 0);
      // Les Kdo entrent dans la vente du shift au même titre qu'une livraison
      // Yango — vendre 25 000 et offrir 5 000 fait 30 000 de vente — mais ils
      // ne se DÉCLARENT pas : aucun argent n'a été reçu, le caissier n'a rien à
      // saisir. C'est donc le serveur qui les ajoute, depuis les commandes
      // marquées offertes. Sans cette ligne, chaque cadeau creusait un faux
      // écart de réconciliation, le total système les comptant déjà.
      const offerts = auto.offerts;
      const venteTotale =
        montantDepenses +
        somme(livraisons) +
        somme(modesDeclares) +
        offerts.total +
        corps.especes_comptees -
        service.fond_de_caisse;
      // Un acompte est bien dans le tiroir / l'opérateur du shift, même si la
      // vente analytique de sa sous-note ne sera reconnue qu'au solde. Il doit
      // donc entrer dans la réconciliation sans gonfler `total_ventes`.
      const acomptesRecus = stats.sous_notes_incompletes.reduce((s, note) => s + note.montant_recu, 0);
      const totalSysteme = stats.total_ventes + acomptesRecus;
      const diff = venteTotale - totalSysteme;
      const sequenceId = service.sequence_id ?? (await sequenceOuverte(tx));

      const rapportZ: RapportZ = {
        service_id: service.id,
        caissier: req.session!.nom_complet,
        ouvert_le: service.ouvert_le.toISOString(),
        cloture_le: clotureLe.toISOString(),
        fond_de_caisse: service.fond_de_caisse,
        especes_comptees: corps.especes_comptees,
        especes_theorique: especesTheorique,
        ecart,
        depenses: montantDepenses,
        livraisons,
        offerts,
        modes_declares: modesDeclares,
        vente_totale: venteTotale,
        total_systeme: totalSysteme,
        diff,
        // Bloc Inventaire (§ 6.10) : information manager, SANS effet sur la
        // vente ni sur l'écart de caisse.
        inventaire: {
          valide: inventaire.inventaire.valide,
          debloque: inventaire.inventaire.debloque_par !== null,
          manquants: inventaire.bilan.manquants,
          surplus: inventaire.bilan.surplus,
          montant_manquant: inventaire.bilan.montant,
        },
        equipe,
        ...stats,
      };

      const [maj] = await tx
        .update(servicesCaisse)
        .set({
          statut: 'CLOTURE',
          cloture_le: clotureLe,
          sequence_id: sequenceId,
          especes_comptees: corps.especes_comptees,
          especes_theorique: especesTheorique,
          ecart,
          depenses: montantDepenses,
          reconciliation: { livraisons, offerts, modes: modesDeclares },
          vente_totale: venteTotale,
          total_systeme: totalSysteme,
          rapport_z: rapportZ,
        })
        .where(eq(servicesCaisse.id, service.id))
        .returning();
      await ecrireOutbox(tx, 'services_caisse', 'UPDATE', service.id, maj as unknown as Record<string, unknown>);

      await journaliser(tx, {
        user_id: caissierId,
        action: 'CLOTURE_SERVICE',
        entite: 'services_caisse',
        entite_id: service.id,
        montant: stats.total_ventes,
        meta: { ecart, especes_comptees: corps.especes_comptees },
      });

      // Écart au-delà du seuil → audit ECART_CAISSE (notification manager en sprint 1)
      const [param] = await tx
        .select()
        .from(parametresLocaux)
        .where(eq(parametresLocaux.cle, 'seuil_alerte_ecart_caisse'));
      const seuil = typeof param?.valeur === 'number' ? param.valeur : 2000;
      if (Math.abs(ecart) > seuil) {
        await journaliser(tx, {
          user_id: caissierId,
          action: 'ECART_CAISSE',
          entite: 'services_caisse',
          entite_id: service.id,
          montant: ecart,
          meta: { seuil, especes_comptees: corps.especes_comptees, especes_theorique: especesTheorique },
        });
      }

      return rapportZ;
    });

    await app.imprimante.imprimerRapportZ(rapport);
    app.diffuser('service', rapport.service_id);
    return rapport;
  });

  // Rapport Z d'un service clôturé (snapshot figé en base)
  app.get('/api/services/:id/rapport-z', { preHandler: app.exigerAuth }, async (req) => {
    const { id } = req.params as { id: string };
    const [service] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.id, id));
    if (!service) throw introuvable('Service');

    const voitTousRapports = await aPermission(req.session!, 'rapports.z');
    if (!voitTousRapports && service.caissier_id !== req.session!.utilisateur_id) {
      throw new ErreurMetier('Vous n’avez pas le droit de consulter ce rapport', 403);
    }
    // Comptage à l'aveugle : rien n'est révélé tant que le comptage n'est pas enregistré
    if (service.statut !== 'CLOTURE' || service.especes_comptees === null) {
      throw new ErreurMetier('Le rapport Z n’est disponible qu’après le comptage de clôture', 409);
    }
    return service.rapport_z;
  });

  // Rapport X (ventes en cours de service) : MANAGER / PROPRIETAIRE uniquement (§14)
  app.get(
    '/api/services/:id/rapport-x',
    { preHandler: app.exigePermission('rapports.x') },
    async (req) => {
      const { id } = req.params as { id: string };
      const [service] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.id, id));
      if (!service) throw introuvable('Service');
      const stats = await calculerStatsService(db, id);
      return {
        service_id: service.id,
        statut: service.statut,
        fond_de_caisse: service.fond_de_caisse,
        ouvert_le: service.ouvert_le.toISOString(),
        especes_theorique: service.fond_de_caisse + stats.par_mode.ESPECES,
        ...stats,
      };
    },
  );
}
