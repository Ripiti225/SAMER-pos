import { asc, eq } from 'drizzle-orm';
import type { ArticleVue, CatalogueVue } from '@pos/shared';
import { db } from '../../db/client.js';
import {
  articles,
  categories,
  comboArticles,
  combos,
  groupesOptions,
  options,
  prixCanaux,
  promotions,
  supplements,
} from '../../db/schema/index.js';
import { promotionActive } from './promos.js';

/** Charge le catalogue complet (partagé caisse / tablette / client). */
export async function chargerCatalogue(): Promise<CatalogueVue> {
  const [cats, arts, canaux, groupes, opts, suppls, cbs, cbArts, promos] = await Promise.all([
    db.select().from(categories).where(eq(categories.actif, true)).orderBy(asc(categories.ordre)),
    db.select().from(articles).where(eq(articles.actif, true)).orderBy(asc(articles.nom)),
    db.select().from(prixCanaux),
    db.select().from(groupesOptions),
    db.select().from(options),
    db.select().from(supplements),
    db.select().from(combos).where(eq(combos.actif, true)),
    db
      .select({
        combo_id: comboArticles.combo_id,
        article_id: comboArticles.article_id,
        quantite: comboArticles.quantite,
        nom: articles.nom,
      })
      .from(comboArticles)
      .innerJoin(articles, eq(articles.id, comboArticles.article_id)),
    db.select().from(promotions).where(eq(promotions.actif, true)),
  ]);

  const maintenant = new Date();
  const vueArticles: ArticleVue[] = arts.map((a) => ({
    id: a.id,
    categorie_id: a.categorie_id,
    nom: a.nom,
    description: a.description,
    prix_base: a.prix_base,
    image_url: a.image_url,
    disponible: a.disponible,
    prix_canaux: Object.fromEntries(
      canaux.filter((c) => c.article_id === a.id).map((c) => [c.canal, c.prix]),
    ),
    groupes_options: groupes
      .filter((g) => g.article_id === a.id)
      .map((g) => ({
        id: g.id,
        nom: g.nom,
        choix_min: g.choix_min,
        choix_max: g.choix_max,
        options: opts.filter((o) => o.groupe_id === g.id).map((o) => ({ id: o.id, nom: o.nom })),
      })),
    supplements: suppls
      .filter((s) => s.article_id === a.id)
      .map((s) => ({ id: s.id, nom: s.nom, prix: s.prix })),
  }));

  return {
    categories: cats.map((c) => ({ id: c.id, nom: c.nom, ordre: c.ordre })),
    articles: vueArticles,
    combos: cbs.map((c) => ({
      id: c.id,
      nom: c.nom,
      prix: c.prix,
      disponible: c.disponible,
      articles: cbArts
        .filter((ca) => ca.combo_id === c.id)
        .map((ca) => ({ article_id: ca.article_id, nom: ca.nom, quantite: ca.quantite })),
    })),
    promotions: promos.map((p) => ({
      id: p.id,
      nom: p.nom,
      type: p.type as 'POURCENTAGE' | 'MONTANT',
      valeur: p.valeur,
      heure_debut: p.heure_debut,
      heure_fin: p.heure_fin,
      jours: p.jours,
      article_id: p.article_id,
      active_maintenant: promotionActive(p, maintenant),
    })),
  };
}
