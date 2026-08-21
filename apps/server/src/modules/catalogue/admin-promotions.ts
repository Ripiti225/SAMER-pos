/**
 * Promotions — administration depuis la caisse (brief 4C § 2.4).
 * Guard : permission `reglages.catalogue`, comme le reste du menu.
 *
 * POURQUOI CET ÉCRAN EXISTE. Les promotions s'appliquent AUTOMATIQUEMENT côté
 * serveur dès que le jour et l'heure correspondent (`promos.ts`), et aucun
 * écran ne permettait de les voir ni de les arrêter. L'image de déploiement
 * porte une « Happy Hour −20 % » active tous les jours de 17 h à 19 h — le
 * créneau le plus chargé — héritée du seed de démonstration. Sans cet écran, la
 * seule façon de l'éteindre sur un site était d'ouvrir la base de données.
 *
 * Les commandes déjà passées ne changent JAMAIS : la remise appliquée est figée
 * dans `commandes.promo_montant` au moment de l'encaissement. Éteindre une
 * promotion n'a d'effet que sur les commandes suivantes.
 *
 * ATTENTION — `promotions` est une table de DESCENTE (flux PROMOTIONS) : le
 * cloud en est maître. Aujourd'hui la table cloud est vide, donc rien n'écrase
 * ce qui est réglé ici. Le jour où le siège publiera des promotions, un site
 * qui aura éteint la sienne la verra RALLUMÉE à la descente suivante. Il faudra
 * alors sortir l'interrupteur de la table synchronisée, comme on l'a fait pour
 * la disponibilité des plats (`disponibilite_locale`), afin qu'un réglage posé
 * sur place ne soit jamais effacé par une mise à jour venue du siège.
 */
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { BasculerPromotionSchema, CreerPromotionSchema, ModifierPromotionSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { articles, promotions } from '../../db/schema/index.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';

/** `time` revient en « HH:MM:SS » de Postgres ; l'écran travaille en « HH:MM ». */
function heureCourte(v: string | null): string | null {
  return v ? v.slice(0, 5) : null;
}

/** Trace lisible dans le journal d'audit — sans elle, « avant/après » est illisible. */
function resume(p: typeof promotions.$inferSelect): Record<string, unknown> {
  return {
    nom: p.nom,
    type: p.type,
    valeur: p.valeur,
    heures: p.heure_debut && p.heure_fin ? `${heureCourte(p.heure_debut)}–${heureCourte(p.heure_fin)}` : 'toute la journée',
    jours: p.jours,
    actif: p.actif,
  };
}

export function routesPromotionsAdmin(app: FastifyInstance): void {
  const garde = app.exigePermission('reglages.catalogue');

  app.get('/api/admin/promotions', { preHandler: garde }, async () => {
    const [promos, arts] = await Promise.all([
      db.select().from(promotions).orderBy(asc(promotions.nom)),
      db
        .select({ id: articles.id, nom: articles.nom })
        .from(articles)
        .where(eq(articles.actif, true))
        .orderBy(asc(articles.nom)),
    ]);

    return {
      promotions: promos.map((p) => ({
        id: p.id,
        nom: p.nom,
        type: p.type,
        valeur: p.valeur,
        heure_debut: heureCourte(p.heure_debut),
        heure_fin: heureCourte(p.heure_fin),
        jours: p.jours,
        article_id: p.article_id,
        actif: p.actif,
      })),
      articles: arts,
    };
  });

  app.post('/api/admin/promotions', { preHandler: garde }, async (req) => {
    const corps = valider(CreerPromotionSchema, req.body);
    return db.transaction(async (tx) => {
      const [cree] = await tx
        .insert(promotions)
        .values({
          nom: corps.nom,
          type: corps.type,
          valeur: corps.valeur,
          heure_debut: corps.heure_debut ?? null,
          heure_fin: corps.heure_fin ?? null,
          jours: corps.jours,
          article_id: corps.article_id ?? null,
          actif: corps.actif,
        })
        .returning();
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: 'promotions',
        entite_id: cree!.id,
        meta: { op: 'creation', apres: resume(cree!) },
      });
      app.diffuser('catalogue');
      return cree;
    });
  });

  app.patch('/api/admin/promotions/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ModifierPromotionSchema, req.body);
    return db.transaction(async (tx) => {
      const [avant] = await tx.select().from(promotions).where(eq(promotions.id, id));
      if (!avant) throw introuvable('Promotion');

      const [maj] = await tx
        .update(promotions)
        .set({
          nom: corps.nom,
          type: corps.type,
          valeur: corps.valeur,
          heure_debut: corps.heure_debut ?? null,
          heure_fin: corps.heure_fin ?? null,
          jours: corps.jours,
          article_id: corps.article_id ?? null,
          actif: corps.actif,
        })
        .where(eq(promotions.id, id))
        .returning();
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: 'promotions',
        entite_id: id,
        meta: { op: 'modification', avant: resume(avant), apres: resume(maj!) },
      });
      app.diffuser('catalogue');
      return maj;
    });
  });

  /**
   * Allumer/éteindre — le geste courant, et celui qui sert au déploiement.
   * Séparé de la modification complète pour qu'un interrupteur ne puisse pas
   * réécrire par mégarde la plage horaire ou la valeur de la remise.
   */
  app.post('/api/admin/promotions/:id/actif', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(BasculerPromotionSchema, req.body);
    return db.transaction(async (tx) => {
      const [avant] = await tx.select().from(promotions).where(eq(promotions.id, id));
      if (!avant) throw introuvable('Promotion');

      const [maj] = await tx
        .update(promotions)
        .set({ actif: corps.actif })
        .where(eq(promotions.id, id))
        .returning();
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        // Une promotion allumée ou éteinte change ce que paient les clients :
        // l'action est nommée explicitement pour être retrouvable dans le
        // journal, sans avoir à lire le `meta` de chaque MODIF_CATALOGUE.
        action: corps.actif ? 'PROMO_ACTIVEE' : 'PROMO_DESACTIVEE',
        entite: 'promotions',
        entite_id: id,
        meta: { promotion: resume(maj!) },
      });
      app.diffuser('catalogue');
      return maj;
    });
  });

  app.delete('/api/admin/promotions/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    return db.transaction(async (tx) => {
      const [promo] = await tx.select().from(promotions).where(eq(promotions.id, id));
      if (!promo) throw introuvable('Promotion');
      // `commandes.promo_id` référence cette ligne. Une promotion déjà appliquée
      // à une commande ne peut donc PAS être supprimée — et c'est heureux :
      // l'historique doit rester lisible, un ticket doit pouvoir dire quelle
      // remise il a reçue. On traduit le refus de la base en langage clair
      // plutôt que de laisser remonter une erreur technique.
      try {
        await tx.delete(promotions).where(eq(promotions.id, id));
      } catch (e) {
        if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23503') {
          throw new ErreurMetier(
            'Cette promotion a déjà été appliquée à des commandes : elle ne peut pas être supprimée. Désactivez-la, elle ne s’appliquera plus.',
            409,
          );
        }
        throw e;
      }
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: 'promotions',
        entite_id: id,
        meta: { op: 'suppression', avant: resume(promo) },
      });
      app.diffuser('catalogue');
      return { ok: true };
    });
  });
}
