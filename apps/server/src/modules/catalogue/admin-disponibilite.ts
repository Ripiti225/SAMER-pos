/**
 * SPRINT 4C — Plats du jour / disponibilité (2.3). Guard : permission
 * `reglages.disponibilite`. Toujours modifiable, MÊME hors ligne (contrairement
 * au catalogue). Effet immédiat sur caisse, tablettes et page client (WebSocket).
 */
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { DisponibiliteSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { articles, categories } from '../../db/schema/index.js';
import { introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { articleDisponible, lireDisponibilites, poserDisponibilite } from './disponibilite.js';

export function routesDisponibilite(app: FastifyInstance): void {
  const garde = app.exigePermission('reglages.disponibilite');

  // Grille de tous les articles actifs avec leur disponibilité
  app.get('/api/admin/disponibilite', { preHandler: garde }, async () => {
    const arts = await db
      .select({ id: articles.id, nom: articles.nom, categorie_id: articles.categorie_id, categorie: categories.nom })
      .from(articles)
      .leftJoin(categories, eq(categories.id, articles.categorie_id))
      .where(eq(articles.actif, true))
      .orderBy(asc(categories.ordre), asc(articles.nom));
    const dispo = await lireDisponibilites(db);
    return arts.map((a) => ({ ...a, disponible: dispo.get(a.id) ?? true }));
  });

  // Basculer Disponible/Épuisé pour un article
  app.patch('/api/admin/disponibilite/:articleId', { preHandler: garde }, async (req) => {
    const { articleId } = req.params as { articleId: string };
    const corps = valider(DisponibiliteSchema, req.body);
    const [a] = await db.select({ id: articles.id, nom: articles.nom }).from(articles).where(eq(articles.id, articleId));
    if (!a) throw introuvable('Article');
    const avant = await articleDisponible(db, articleId);

    await db.transaction(async (tx) => {
      await poserDisponibilite(tx, articleId, corps.disponible);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_DISPONIBILITE',
        entite: 'disponibilite_locale',
        entite_id: articleId,
        meta: { article: a.nom, avant, apres: corps.disponible },
      });
    });
    app.diffuser('catalogue');
    return { article_id: articleId, disponible: corps.disponible };
  });
}
