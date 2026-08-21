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
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { depenses, equipeService, utilisateurs } from '../../db/schema/index.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { serviceOuvertCourant } from '../depenses/service.js';

/** Durée d'un service (§ 6.7). Sert à la fin prévue et à la jauge. */
export const DUREE_SERVICE_HEURES = 8;

const PointerSchema = z.object({
  utilisateur_id: z.string().uuid('Employé invalide'),
  poste_jour: z.string().trim().min(1).optional(),
});

const DepartSchema = z.object({
  reste: z.boolean({ invalid_type_error: 'Indiquez si la personne reste ou part' }),
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
        reste: equipeService.reste,
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
      const minutesFaites = arrivee === null ? 0 : Math.max(0, Math.floor((maintenant - arrivee) / 60000));
      return {
        id: m.id,
        utilisateur_id: m.utilisateur_id,
        nom_complet: m.nom_complet,
        photo_url: m.photo_url,
        poste_jour: m.poste_jour,
        pointe_le: m.pointe_le?.toISOString() ?? null,
        // Attendu = inscrit à l'équipe du jour mais pas encore pointé.
        attendu: arrivee === null,
        fin_prevue: arrivee === null ? null : new Date(arrivee + dureeMs).toISOString(),
        minutes_faites: minutesFaites,
        // Vert dès les 8 h faites, rouge avant. Par construction, chacun est
        // rouge la majeure partie de son service — la couleur devient
        // informative en fin de service (§ 6.7).
        heures_faites: minutesFaites >= DUREE_SERVICE_HEURES * 60,
        reste: m.reste,
        salaire_paye: estPaye.has(m.utilisateur_id),
      };
    });

    return {
      service_id: service.id,
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
    if (existant?.pointe_le) {
      throw new ErreurMetier(`${agent.nom_complet} est déjà pointé sur ce service`, 409);
    }

    const arrivee = new Date();
    const posteJour = corps.poste_jour ?? existant?.poste_jour ?? agent.poste ?? agent.poste_cuisine ?? 'EQUIPIER';

    const membre = await db.transaction(async (tx) => {
      const [ligne] = existant
        ? await tx
            .update(equipeService)
            .set({ pointe_le: arrivee, poste_jour: posteJour })
            .where(eq(equipeService.id, existant.id))
            .returning()
        : await tx
            .insert(equipeService)
            .values({
              service_id: service.id,
              utilisateur_id: corps.utilisateur_id,
              poste_jour: posteJour,
              pointe_le: arrivee,
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
        },
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
}
