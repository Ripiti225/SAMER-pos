/**
 * Routage des bons de préparation : à l'envoi en cuisine, chaque article part
 * sur l'imprimante de SON poste (Caisse/Cuisine/Bar). Résolution locale :
 *   routage_article[article] ?? routage_categorie[catégorie] ?? défaut (CUISINE).
 * Les combos n'ont pas de catégorie → poste par défaut.
 *
 * À appeler APRÈS le commit de l'envoi (jamais dans la transaction : on n'imprime
 * pas un bon pour une commande qui pourrait être annulée par un rollback).
 */
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import type { PosteImpression } from '@pos/shared';
import { POSTE_IMPRESSION_DEFAUT } from '@pos/shared';
import { db } from '../db/client.js';
import { articles, routageArticle, routageCategorie } from '../db/schema/index.js';
import { chargerCommandeVue } from '../modules/commandes/service.js';

/**
 * Imprime les bons de préparation pour les articles qui viennent d'être envoyés.
 * Groupe par poste et imprime un bon par poste concerné.
 */
export async function imprimerBonsEnvoi(
  app: FastifyInstance,
  commandeId: string,
  itemIdsEnvoyes: string[],
): Promise<void> {
  if (itemIdsEnvoyes.length === 0) return;
  const vue = await chargerCommandeVue(db, commandeId);
  const items = vue.items.filter((i) => itemIdsEnvoyes.includes(i.id) && i.statut_cuisine !== 'ANNULE');
  if (items.length === 0) return;

  // Résolution du poste de chaque article (routage article > catégorie > défaut).
  const articleIds = items.map((i) => i.article_id).filter((x): x is string => !!x);
  const [ovr, cats] = await Promise.all([
    articleIds.length
      ? db.select({ article_id: routageArticle.article_id, poste: routageArticle.poste }).from(routageArticle).where(inArray(routageArticle.article_id, articleIds))
      : Promise.resolve([] as { article_id: string; poste: PosteImpression }[]),
    articleIds.length
      ? db
          .select({ article_id: articles.id, categorie_id: articles.categorie_id })
          .from(articles)
          .where(inArray(articles.id, articleIds))
      : Promise.resolve([] as { article_id: string; categorie_id: string }[]),
  ]);
  const categorieIds = [...new Set(cats.map((c) => c.categorie_id))];
  const catPostes = categorieIds.length
    ? await db.select({ categorie_id: routageCategorie.categorie_id, poste: routageCategorie.poste }).from(routageCategorie).where(inArray(routageCategorie.categorie_id, categorieIds))
    : [];

  const posteArticle = new Map(ovr.map((o) => [o.article_id, o.poste]));
  const categorieDeArticle = new Map(cats.map((c) => [c.article_id, c.categorie_id]));
  const posteCategorie = new Map(catPostes.map((c) => [c.categorie_id, c.poste]));

  const resoudre = (articleId: string | null): PosteImpression => {
    if (!articleId) return POSTE_IMPRESSION_DEFAUT; // combo : pas de catégorie
    const parArticle = posteArticle.get(articleId);
    if (parArticle) return parArticle;
    const catId = categorieDeArticle.get(articleId);
    const parCat = catId ? posteCategorie.get(catId) : undefined;
    return parCat ?? POSTE_IMPRESSION_DEFAUT;
  };

  // Groupe les articles par poste, puis un bon par poste.
  const parPoste = new Map<PosteImpression, typeof items>();
  for (const item of items) {
    const poste = resoudre(item.article_id);
    const liste = parPoste.get(poste) ?? [];
    liste.push(item);
    parPoste.set(poste, liste);
  }
  for (const [poste, liste] of parPoste) {
    try {
      await app.imprimante.imprimerBon(vue, poste, liste);
    } catch (e) {
      app.log.error({ err: e, commandeId, poste }, 'Impression du bon échouée');
    }
  }
}
