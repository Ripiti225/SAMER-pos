/**
 * Écran Dépenses (DESIGN_V2 § 6.8) — deux onglets : Registre, Paie & départs.
 *
 * Gardes (depuis le 2026-08-17) : `depenses.saisir` pour le registre,
 * `depenses.supprimer` pour retirer une ligne, `depenses.paie` pour les
 * salaires et encouragements.
 *
 * Auparavant tout passait par `caisse.service.ouvrir`, au motif qu'une
 * permission neuve resterait décochée sur les rôles déjà en base. L'objection
 * était juste, mais elle se règle par une migration de données (0025), pas en
 * renonçant à la permission : accrocher la sortie d'argent du tiroir au droit
 * d'ouvrir un service rendait la chose impossible à retirer à qui que ce soit,
 * et invisible dans « Rôles & accès ».
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { depenses, equipeService, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import {
  CATEGORIES_LIBRES,
  repartitionDepenses,
  serviceOuvertCourant,
  totalDepenses,
} from './service.js';

const Montant = z
  .number({ invalid_type_error: 'Le montant doit être un nombre' })
  .int('Le montant doit être un montant entier en FCFA')
  .positive('Le montant doit être supérieur à zéro');

const DepenseSchema = z.object({
  categorie: z.enum(CATEGORIES_LIBRES, {
    errorMap: () => ({ message: 'Choisissez une catégorie de dépense' }),
  }),
  libelle: z.string().trim().min(1, 'Indiquez ce qui a été acheté'),
  montant: Montant,
});

const PayerSchema = z.object({
  agent_id: z.string().uuid('Employé invalide'),
  montant: Montant,
  motif: z.string().trim().min(1).optional(),
});

const EncouragementSchema = z.object({
  agent_id: z.string().uuid('Employé invalide'),
  montant: Montant,
  motif: z.string().trim().min(1, 'Un encouragement demande toujours un motif'),
});

export function routesDepenses(app: FastifyInstance): void {
  // Jusqu'au 2026-08-17, tout ce module était gardé par `caisse.service.ouvrir` :
  // ouvrir un service donnait le droit de sortir de l'argent du tiroir, et
  // aucune de ces capacités n'apparaissait dans « Rôles & accès ».
  const garde = app.exigePermission('depenses.saisir');
  const gardeSuppression = app.exigePermission('depenses.supprimer');
  // Salaires et encouragements : de l'argent réel quitte la caisse.
  const gardePaie = app.exigePermission('depenses.paie');

  /** Registre du service en cours + total et répartition (panneau droit). */
  app.get('/api/depenses', { preHandler: garde }, async () => {
    const service = await serviceOuvertCourant(db);
    const lignes = await db
      .select({
        id: depenses.id,
        categorie: depenses.categorie,
        libelle: depenses.libelle,
        montant: depenses.montant,
        agent_id: depenses.agent_id,
        agent_nom: utilisateurs.nom_complet,
        auto: depenses.auto,
        motif: depenses.motif,
        created_at: depenses.created_at,
      })
      .from(depenses)
      .leftJoin(utilisateurs, eq(utilisateurs.id, depenses.agent_id))
      .where(eq(depenses.service_id, service.id))
      .orderBy(asc(depenses.created_at));

    return {
      service_id: service.id,
      total: await totalDepenses(db, service.id),
      par_categorie: await repartitionDepenses(db, service.id),
      lignes: lignes.map((l) => ({ ...l, created_at: l.created_at.toISOString() })),
    };
  });

  /** Sortie de caisse ordinaire (marché, légumes, fruits, dépenses annexes). */
  app.post('/api/depenses', { preHandler: garde }, async (req) => {
    const corps = valider(DepenseSchema, req.body);
    const service = await serviceOuvertCourant(db);

    return db.transaction(async (tx) => {
      const [ligne] = await tx
        .insert(depenses)
        .values({
          service_id: service.id,
          categorie: corps.categorie,
          libelle: corps.libelle,
          montant: corps.montant,
          saisi_par: req.session!.utilisateur_id,
        })
        .returning();
      await ecrireOutbox(tx, 'depenses', 'INSERT', ligne!.id, ligne as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'DEPENSE',
        entite: 'depenses',
        entite_id: ligne!.id,
        montant: corps.montant,
        meta: { categorie: corps.categorie, libelle: corps.libelle },
      });
      return ligne!;
    });
  });

  /**
   * Suppression d'une ligne — jamais pour une ligne `auto` : elle est née d'un
   * paiement réel, et l'effacer ferait disparaître de l'argent réellement sorti
   * du tiroir. Une erreur de paie se corrige au journal, pas à la gomme.
   */
  app.delete('/api/depenses/:id', { preHandler: gardeSuppression }, async (req) => {
    const { id } = req.params as { id: string };
    const service = await serviceOuvertCourant(db);
    const [ligne] = await db
      .select()
      .from(depenses)
      .where(and(eq(depenses.id, id), eq(depenses.service_id, service.id)));
    if (!ligne) throw introuvable('Dépense');
    if (ligne.auto) {
      throw new ErreurMetier(
        'Cette ligne vient d’un paiement réel : elle ne peut pas être supprimée',
        409,
      );
    }

    await db.transaction(async (tx) => {
      await tx.delete(depenses).where(eq(depenses.id, id));
      // L'outbox ne connaît que INSERT/UPDATE : sans ce marqueur, une dépense
      // supprimée ici resterait pour toujours dans SamerTrackly et gonflerait
      // les charges du site. On publie donc la ligne une dernière fois, marquée
      // supprimée — le siège la retire de ses totaux.
      await ecrireOutbox(tx, 'depenses', 'UPDATE', id, {
        ...(ligne as unknown as Record<string, unknown>),
        supprime: true,
      });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'DEPENSE_SUPPRIMEE',
        entite: 'depenses',
        entite_id: id,
        montant: ligne.montant,
        meta: { categorie: ligne.categorie, libelle: ligne.libelle },
      });
    });
    return { ok: true };
  });

  /**
   * Onglet « Paie & départs » : TOUTE l'équipe du jour, pas seulement les payés
   * à la journée — un employé au mois peut recevoir un encouragement, et
   * surtout son départ doit être marqué.
   */
  app.get('/api/depenses/paie', { preHandler: gardePaie }, async () => {
    const service = await serviceOuvertCourant(db);
    const membres = await db
      .select({
        utilisateur_id: equipeService.utilisateur_id,
        nom_complet: utilisateurs.nom_complet,
        poste_jour: equipeService.poste_jour,
        photo_url: utilisateurs.photo_url,
        taux_journalier: utilisateurs.taux_journalier,
        pointe_le: equipeService.pointe_le,
        reste: equipeService.reste,
      })
      .from(equipeService)
      .innerJoin(utilisateurs, eq(utilisateurs.id, equipeService.utilisateur_id))
      .where(eq(equipeService.service_id, service.id))
      .orderBy(asc(utilisateurs.nom_complet));

    const lignes = await db
      .select({
        agent_id: depenses.agent_id,
        categorie: depenses.categorie,
        montant: depenses.montant,
        motif: depenses.motif,
      })
      .from(depenses)
      .where(eq(depenses.service_id, service.id));

    return membres.map((m) => {
      const siennes = lignes.filter((l) => l.agent_id === m.utilisateur_id);
      const salaire = siennes.find((l) => l.categorie === 'SALAIRES');
      const encouragements = siennes.filter((l) => l.categorie === 'ENCOURAGEMENTS');
      return {
        ...m,
        pointe_le: m.pointe_le?.toISOString() ?? null,
        salaire_paye: salaire ? { montant: salaire.montant, motif: salaire.motif } : null,
        encouragements: encouragements.reduce((s, e) => s + e.montant, 0),
      };
    });
  });

  /**
   * « Payer » : crée la ligne de dépense SALAIRES, non supprimable. Le taux de
   * la fiche est modifiable, mais tout écart exige un motif — sinon le manager
   * découvre un montant inexpliqué sans pouvoir remonter à la raison.
   */
  app.post('/api/depenses/payer', { preHandler: gardePaie }, async (req) => {
    const corps = valider(PayerSchema, req.body);
    const service = await serviceOuvertCourant(db);

    const [agent] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, corps.agent_id));
    if (!agent) throw introuvable('Employé');
    if (corps.montant !== agent.taux_journalier && !corps.motif) {
      throw new ErreurMetier(
        agent.taux_journalier === null
          ? 'Aucun taux journalier sur la fiche : indiquez un motif pour ce montant'
          : `Le montant diffère du taux de la fiche (${agent.taux_journalier} FCFA) : indiquez un motif`,
        400,
      );
    }

    const [deja] = await db
      .select({ id: depenses.id })
      .from(depenses)
      .where(
        and(
          eq(depenses.service_id, service.id),
          eq(depenses.agent_id, corps.agent_id),
          eq(depenses.categorie, 'SALAIRES'),
        ),
      );
    if (deja) throw new ErreurMetier(`${agent.nom_complet} a déjà été payé sur ce service`, 409);

    return db.transaction(async (tx) => {
      const [ligne] = await tx
        .insert(depenses)
        .values({
          service_id: service.id,
          categorie: 'SALAIRES',
          libelle: `Salaire — ${agent.nom_complet}`,
          montant: corps.montant,
          agent_id: agent.id,
          saisi_par: req.session!.utilisateur_id,
          auto: true,
          motif: corps.motif ?? null,
        })
        .returning();
      await ecrireOutbox(tx, 'depenses', 'INSERT', ligne!.id, ligne as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'PAIEMENT_SALAIRE',
        entite: 'depenses',
        entite_id: ligne!.id,
        montant: corps.montant,
        motif: corps.motif ?? null,
        meta: { agent_id: agent.id, agent: agent.nom_complet, taux_fiche: agent.taux_journalier },
      });
      return ligne!;
    });
  });

  /** Prime exceptionnelle : ouverte à toute l'équipe, motif obligatoire. */
  app.post('/api/depenses/encouragement', { preHandler: gardePaie }, async (req) => {
    const corps = valider(EncouragementSchema, req.body);
    const service = await serviceOuvertCourant(db);
    const [agent] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, corps.agent_id));
    if (!agent) throw introuvable('Employé');

    return db.transaction(async (tx) => {
      const [ligne] = await tx
        .insert(depenses)
        .values({
          service_id: service.id,
          categorie: 'ENCOURAGEMENTS',
          libelle: `Encouragement — ${agent.nom_complet}`,
          montant: corps.montant,
          agent_id: agent.id,
          saisi_par: req.session!.utilisateur_id,
          auto: true,
          motif: corps.motif,
        })
        .returning();
      await ecrireOutbox(tx, 'depenses', 'INSERT', ligne!.id, ligne as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'ENCOURAGEMENT',
        entite: 'depenses',
        entite_id: ligne!.id,
        montant: corps.montant,
        motif: corps.motif,
        meta: { agent_id: agent.id, agent: agent.nom_complet },
      });
      return ligne!;
    });
  });

  /** Total du service — lu par l'étape « Dépenses » de la clôture (lecture seule). */
  app.get('/api/depenses/total', { preHandler: garde }, async () => {
    const service = await serviceOuvertCourant(db);
    const [compte] = await db
      .select({ n: sql<string>`COUNT(*)` })
      .from(depenses)
      .where(eq(depenses.service_id, service.id));
    return { total: await totalDepenses(db, service.id), nb_lignes: Number(compte?.n ?? 0) };
  });
}
