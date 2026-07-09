import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { CloturerServiceSchema, OuvrirServiceSchema, TransfererServiceSchema } from '@pos/shared';
import type { RapportZ } from '@pos/shared';
import { db } from '../../db/client.js';
import { commandes, equipeService, parametresLocaux, roles, servicesCaisse, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinUtilisateur } from '../auth/pin.js';
import { calculerStatsService } from './rapport.js';
import { aPermission } from '../../plugins/sessions.js';
import { permissionsDuRole } from '../roles/service.js';

/** Vue publique d'un service : ne contient JAMAIS especes_theorique tant que non clôturé. */
function vueService(s: typeof servicesCaisse.$inferSelect) {
  return {
    id: s.id,
    fond_de_caisse: s.fond_de_caisse,
    ouvert_le: s.ouvert_le.toISOString(),
    statut: s.statut as 'OUVERT' | 'CLOTURE',
  };
}

export function routesServices(app: FastifyInstance): void {
  const gardeCaisse = app.exigePermission('caisse.service.ouvrir');

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

    const [dejaOuvert] = await db
      .select()
      .from(servicesCaisse)
      .where(and(eq(servicesCaisse.caissier_id, caissierId), eq(servicesCaisse.statut, 'OUVERT')));
    if (dejaOuvert) {
      throw new ErreurMetier('Vous avez déjà un service ouvert — terminez-le avant d’en ouvrir un autre', 409);
    }

    const service = await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(servicesCaisse)
        .values({ caissier_id: caissierId, fond_de_caisse: corps.fond_de_caisse })
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
      for (const m of corps.equipe ?? []) {
        const [membre] = await tx
          .insert(equipeService)
          .values({ service_id: s!.id, utilisateur_id: m.utilisateur_id, poste_jour: m.poste_jour })
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
   * Relève de caisse : transfère TOUTES les commandes en cours du service
   * du caissier connecté vers le caissier suivant. Le receveur accepte le
   * transfert en saisissant SON PIN (verrouillage anti-force brute appliqué).
   * Si le receveur n'a pas encore de service ouvert, les commandes restent
   * à lui sans service et seront rattachées à l'ouverture de son service.
   */
  app.post('/api/services/transferer', { preHandler: gardeCaisse }, async (req) => {
    const corps = valider(TransfererServiceSchema, req.body);
    const donneurId = req.session!.utilisateur_id;

    if (corps.receveur_id === donneurId) {
      throw new ErreurMetier('Choisissez un autre caissier que vous-même', 400);
    }
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

      const [serviceReceveur] = await tx
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
          tickets: enCours.map((c) => Number(c.numero_ticket)),
        },
      });

      return {
        nb_transferees: enCours.length,
        receveur: receveur.nom_complet,
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

      const stats = await calculerStatsService(tx, service.id);
      const especesTheorique = service.fond_de_caisse + stats.par_mode.ESPECES;
      const ecart = corps.especes_comptees - especesTheorique;
      const clotureLe = new Date();

      const rapportZ: RapportZ = {
        service_id: service.id,
        caissier: req.session!.nom_complet,
        ouvert_le: service.ouvert_le.toISOString(),
        cloture_le: clotureLe.toISOString(),
        fond_de_caisse: service.fond_de_caisse,
        especes_comptees: corps.especes_comptees,
        especes_theorique: especesTheorique,
        ecart,
        ...stats,
      };

      const [maj] = await tx
        .update(servicesCaisse)
        .set({
          statut: 'CLOTURE',
          cloture_le: clotureLe,
          especes_comptees: corps.especes_comptees,
          especes_theorique: especesTheorique,
          ecart,
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
