/**
 * Pointage — bandeau d'équipe de l'accueil (DESIGN_V2 § 6.7) et marquage des
 * départs (§ 6.8).
 *
 * L'heure du CLIC fait foi comme heure d'arrivée : c'est elle qui sert à la
 * paie, donc elle est datée par le serveur et jamais saisie à la main. Un
 * service dure 8 h — la fin prévue et la durée faite en découlent.
 *
 * Départ : NULL = pas encore tranché, true = reste, false = parti. À la
 * clôture, tout ce qui n'est pas « reste » est enregistré comme PARTI ; le
 * caissier ne marque donc que les exceptions.
 *
 * Depuis la pointeuse (2026-10-26), arrivées et sorties viennent de
 * l'appareil (modules/pointeuse). Le bouton « Pointer » de la caisse reste un
 * SECOURS (panne, visage non reconnu) : PIN manager et motif obligatoires.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { POSTES_JOUR } from '@pos/shared';
import { db } from '../../db/client.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { depenses, equipeService, utilisateurs } from '../../db/schema/index.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager } from '../auth/pin.js';
import { serviceOuvertCourant } from '../depenses/service.js';
import { pointeuseActive, posteParDefaut } from '../pointeuse/presence.js';

/** Durée d'un service (§ 6.7). Sert à la fin prévue et à la jauge. */
export const DUREE_SERVICE_HEURES = 8;

const PointerSchema = z.object({
  utilisateur_id: z.string().uuid('Employé invalide'),
  poste_jour: z.string().trim().min(1).optional(),
  // Exigés quand la pointeuse est en service (pointage de secours).
  pin_manager: z.string().optional(),
  motif: z.string().trim().optional(),
});

const DepartSchema = z.object({
  reste: z.boolean({ invalid_type_error: 'Indiquez si la personne reste ou part' }),
});

const PosteSchema = z.object({
  poste_jour: z.enum(POSTES_JOUR, { errorMap: () => ({ message: 'Poste du jour inconnu' }) }),
});

export function routesPointage(app: FastifyInstance): void {
  // Avant le 2026-08-17 : caisse.service.ouvrir, donc invisible dans Roles & acces.
  const garde = app.exigePermission('pointage.gerer');

  /** L'équipe présente sur le service en cours, avec l'avancement de chacun. */
  app.get('/api/pointage', { preHandler: garde }, async () => {
    const service = await serviceOuvertCourant(db);
    const membres = await db
      .select({
        id: equipeService.id,
        utilisateur_id: equipeService.utilisateur_id,
        nom_complet: utilisateurs.nom_complet,
        photo_url: utilisateurs.photo_url,
        poste_jour: equipeService.poste_jour,
        pointe_le: equipeService.pointe_le,
        secondes_reportees: equipeService.secondes_reportees,
        reste: equipeService.reste,
        depart_le: equipeService.depart_le,
        secondes_absence: equipeService.secondes_absence,
        source: equipeService.source,
      })
      .from(equipeService)
      .innerJoin(utilisateurs, eq(utilisateurs.id, equipeService.utilisateur_id))
      .where(eq(equipeService.service_id, service.id))
      .orderBy(asc(equipeService.created_at));

    const payes = await db
      .select({ agent_id: depenses.agent_id })
      .from(depenses)
      .where(and(eq(depenses.service_id, service.id), eq(depenses.categorie, 'SALAIRES')));
    const estPaye = new Set(payes.map((p) => p.agent_id));

    const maintenant = Date.now();
    const dureeMs = DUREE_SERVICE_HEURES * 3600 * 1000;
    const lignes = membres.map((m) => {
      const arrivee = m.pointe_le?.getTime() ?? null;
      // Sortie pointée : le compteur s'arrête. Les absences du shift sont déduites.
      const fin = m.depart_le?.getTime() ?? maintenant;
      const absence = m.secondes_absence * 1000;
      const minutesFaites = arrivee === null ? 0 : Math.max(0, Math.floor((fin - arrivee - absence) / 60000));
      const minutesCumulees = arrivee === null ? 0 : Math.max(0,
        Math.floor((m.secondes_reportees * 1000 + fin - arrivee - absence) / 60000));
      return {
        id: m.id,
        utilisateur_id: m.utilisateur_id,
        nom_complet: m.nom_complet,
        photo_url: m.photo_url,
        poste_jour: m.poste_jour,
        pointe_le: m.pointe_le?.toISOString() ?? null,
        // Attendu = inscrit à l'équipe du jour mais pas encore pointé.
        attendu: arrivee === null,
        fin_prevue: arrivee === null ? null : new Date(arrivee + absence + Math.max(0, dureeMs - m.secondes_reportees * 1000)).toISOString(),
        // Sortie pointée à la pointeuse (NULL = encore là ou pas encore tranché).
        depart_le: m.depart_le?.toISOString() ?? null,
        source: m.source,
        minutes_faites: minutesFaites,
        minutes_reportees: Math.floor(m.secondes_reportees / 60),
        minutes_cumulees: minutesCumulees,
        // Le seuil de 8 h suit une présence continue, même entre deux shifts.
        heures_faites: minutesCumulees >= DUREE_SERVICE_HEURES * 60,
        reste: m.reste,
        salaire_paye: estPaye.has(m.utilisateur_id),
      };
    });

    return {
      service_id: service.id,
      pointeuse: await pointeuseActive(),
      duree_service_heures: DUREE_SERVICE_HEURES,
      presents: lignes.filter((l) => !l.attendu).length,
      attendus: lignes.filter((l) => l.attendu).length,
      ont_fait_leurs_heures: lignes.filter((l) => l.heures_faites).length,
      membres: lignes,
    };
  });

  /**
   * Pointer une arrivée en cours de service (les retards existent). Si la
   * personne figure déjà dans l'équipe du jour sans être pointée, on ne crée
   * pas de doublon : on date son arrivée.
   */
  app.post('/api/pointage', { preHandler: garde }, async (req) => {
    const corps = valider(PointerSchema, req.body);
    const service = await serviceOuvertCourant(db);

    // Pointeuse en service : la caisse n'est plus qu'un secours, sous PIN manager.
    let manager: { id: string; nom_complet: string } | null = null;
    if (await pointeuseActive()) {
      if (!corps.pin_manager) throw new ErreurMetier('PIN manager requis : les arrivées se pointent à la pointeuse', 403);
      if (!corps.motif || corps.motif.length < 3) throw new ErreurMetier('Motif obligatoire (ex. : visage non reconnu)', 400);
      manager = await verifierPinManager(corps.pin_manager, 'POINTAGE_ARRIVEE');
    }

    const [agent] = await db
      .select()
      .from(utilisateurs)
      .where(and(eq(utilisateurs.id, corps.utilisateur_id), eq(utilisateurs.actif, true)));
    if (!agent) throw introuvable('Employé');

    const [existant] = await db
      .select()
      .from(equipeService)
      .where(
        and(
          eq(equipeService.service_id, service.id),
          eq(equipeService.utilisateur_id, corps.utilisateur_id),
        ),
      );
    // Sorti à la pointeuse puis revenu sans y être reconnu : c'est un retour,
    // l'absence est déduite comme si la pointeuse l'avait vu.
    const retour = !!existant?.pointe_le && !!existant.depart_le;
    if (existant?.pointe_le && !retour) {
      throw new ErreurMetier(`${agent.nom_complet} est déjà pointé sur ce service`, 409);
    }

    const arrivee = new Date();
    const posteJour = corps.poste_jour ?? existant?.poste_jour ?? posteParDefaut(agent);
    const source = manager ? 'CAISSE' : 'OUVERTURE';

    const membre = await db.transaction(async (tx) => {
      const [ligne] = existant
        ? await tx
            .update(equipeService)
            .set(retour
              ? {
                  secondes_absence: existant.secondes_absence
                    + Math.max(0, Math.floor((arrivee.getTime() - existant.depart_le!.getTime()) / 1000)),
                  depart_le: null,
                  reste: null,
                }
              : { pointe_le: arrivee, poste_jour: posteJour, source })
            .where(eq(equipeService.id, existant.id))
            .returning()
        : await tx
            .insert(equipeService)
            .values({
              service_id: service.id,
              utilisateur_id: corps.utilisateur_id,
              poste_jour: posteJour,
              pointe_le: arrivee,
              source,
            })
            .returning();
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'POINTAGE_ARRIVEE',
        entite: 'equipe_service',
        entite_id: ligne!.id,
        meta: {
          agent_id: agent.id,
          agent: agent.nom_complet,
          poste_jour: posteJour,
          arrivee: arrivee.toISOString(),
          retard: !existant,
          retour,
          ...(manager ? { secours_pointeuse: true, manager_id: manager.id, manager: manager.nom_complet } : {}),
        },
        motif: manager ? corps.motif : null,
      });
      return ligne!;
    });

    app.diffuser('pointage', service.id);
    return { ...membre, pointe_le: membre.pointe_le?.toISOString() ?? null };
  });

  /** Sélecteur « Parti / Reste » de l'onglet Paie & départs. */
  app.patch('/api/pointage/:utilisateurId/depart', { preHandler: garde }, async (req) => {
    const { utilisateurId } = req.params as { utilisateurId: string };
    const corps = valider(DepartSchema, req.body);
    const service = await serviceOuvertCourant(db);

    const [membre] = await db
      .select()
      .from(equipeService)
      .where(
        and(eq(equipeService.service_id, service.id), eq(equipeService.utilisateur_id, utilisateurId)),
      );
    if (!membre) throw introuvable('Membre de l’équipe du jour');

    await db.transaction(async (tx) => {
      await tx
        .update(equipeService)
        .set({ reste: corps.reste })
        .where(eq(equipeService.id, membre.id));
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MARQUAGE_DEPART',
        entite: 'equipe_service',
        entite_id: membre.id,
        meta: { agent_id: utilisateurId, reste: corps.reste },
      });
    });

    app.diffuser('pointage', service.id);
    return { utilisateur_id: utilisateurId, reste: corps.reste };
  });

  /**
   * Poste du jour changé en cours de shift (appui sur la fiche du bandeau).
   * Pour ce shift seulement : la fiche de l'employé et ses droits dans la
   * caisse ne changent pas. Remonte au cloud (SamerTrackly lit poste_jour).
   */
  app.patch('/api/pointage/:utilisateurId/poste', { preHandler: garde }, async (req) => {
    const { utilisateurId } = req.params as { utilisateurId: string };
    const corps = valider(PosteSchema, req.body);
    const service = await serviceOuvertCourant(db);

    const [membre] = await db
      .select()
      .from(equipeService)
      .where(
        and(eq(equipeService.service_id, service.id), eq(equipeService.utilisateur_id, utilisateurId)),
      );
    if (!membre) throw introuvable('Membre de l’équipe du jour');
    if (membre.poste_jour === corps.poste_jour) return { utilisateur_id: utilisateurId, poste_jour: corps.poste_jour };

    await db.transaction(async (tx) => {
      const [ligne] = await tx
        .update(equipeService)
        .set({ poste_jour: corps.poste_jour })
        .where(eq(equipeService.id, membre.id))
        .returning();
      await ecrireOutbox(tx, 'equipe_service', 'UPDATE', ligne!.id, ligne as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'CHANGEMENT_POSTE_JOUR',
        entite: 'equipe_service',
        entite_id: membre.id,
        meta: { agent_id: utilisateurId, avant: membre.poste_jour, apres: corps.poste_jour },
      });
    });

    app.diffuser('pointage', service.id);
    return { utilisateur_id: utilisateurId, poste_jour: corps.poste_jour };
  });
}
