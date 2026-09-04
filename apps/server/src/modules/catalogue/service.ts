import { asc, eq } from 'drizzle-orm';
import { categorieVisiblePour, type ArticleVue, type CatalogueVue } from '@pos/shared';
import { db } from '../../db/client.js';
import {
  articles,
  categories,
  comboArticles,
  combos,
  optionsCatalogue,
  optionsLiaisons,
  prixCanaux,
  promotions,
} from '../../db/schema/index.js';
import { promotionActive } from './promos.js';
import { lireDisponibilites } from './disponibilite.js';
import { resoudreOptionsParArticle } from './options.js';
import { categorieDisponibleMaintenant, jourAbidjan } from './horaires.js';

/**
 * Charge le catalogue complet (caisse et tablette serveur).
 *
 * Il contient TOUTES les catégories, y compris celles réservées à un partenaire
 * (migration 0023) : la caisse prend aussi bien une commande en salle qu'une
 * commande Glovo, elle a donc besoin des deux et filtre selon la commande en
 * cours, via `categorieVisiblePour()`. Pour la page client (QR de table), voir
 * `chargerCatalogueClient()`, qui les retire.
 */
export async function chargerCatalogue(): Promise<CatalogueVue> {
  const dispo = await lireDisponibilites(db);
  const [cats, arts, canaux, optsCat, liaisons, cbs, cbArts, promos] = await Promise.all([
    db.select().from(categories).where(eq(categories.actif, true)).orderBy(asc(categories.ordre)),
    db.select().from(articles).where(eq(articles.actif, true)).orderBy(asc(articles.nom)),
    db.select().from(prixCanaux),
    db.select().from(optionsCatalogue).where(eq(optionsCatalogue.actif, true)),
    db.select().from(optionsLiaisons),
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
  const disponibiliteCategories = new Map(
    cats.map((c) => [c.id, categorieDisponibleMaintenant(c, maintenant)]),
  );
  const jourActuel = jourAbidjan(maintenant);
  const categoriesOrdonnees = [...cats].sort((a, b) => {
    const prioriteA = a.jour_semaine === jourActuel ? -1 : 0;
    const prioriteB = b.jour_semaine === jourActuel ? -1 : 0;
    return prioriteA - prioriteB || a.ordre - b.ordre;
  });
  // Options d'un article = celles liées à sa CATÉGORIE + celles liées à lui.
  const extrasParArticle = resoudreOptionsParArticle(arts, optsCat, liaisons);
  const vueArticles: ArticleVue[] = arts.map((a) => ({
    id: a.id,
    categorie_id: a.categorie_id,
    nom: a.nom,
    description: a.description,
    prix_base: a.prix_base,
    image_url: a.image_url,
    // Source de vérité : disponibilite_locale (TRUE par défaut, 2.3).
    disponible: (dispo.get(a.id) ?? true) && (disponibiliteCategories.get(a.categorie_id) ?? true),
    prix_canaux: Object.fromEntries(
      canaux.filter((c) => c.article_id === a.id).map((c) => [c.canal, c.prix]),
    ),
    options_extras: extrasParArticle.get(a.id) ?? [],
  }));

  return {
    categories: categoriesOrdonnees.map((c) => ({
      id: c.id,
      nom: c.nom,
      ordre: c.ordre,
      partenaires: c.partenaires,
      heure_debut: c.heure_debut,
      heure_fin: c.heure_fin,
      disponibilite_forcee: c.disponibilite_forcee,
      disponible_maintenant: disponibiliteCategories.get(c.id) ?? true,
      jour_semaine: c.jour_semaine,
    })),
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

/**
 * Catalogue pour la page CLIENT (QR de table). Un client au QR est par
 * définition sur place : les catégories réservées à un partenaire de livraison
 * n'existent pas pour lui.
 *
 * Le filtrage est fait ICI, côté serveur, et pas seulement à l'affichage : les
 * articles concernés sont retirés de la réponse, sinon la recherche de la page
 * client les retrouverait, et le simple fait de les envoyer laisserait fuiter
 * une carte qui n'est pas la sienne.
 */
export async function chargerCatalogueClient(): Promise<CatalogueVue> {
  const catalogue = await chargerCatalogue();
  const visibles = catalogue.categories.filter((c) => categorieVisiblePour(c.partenaires, null));
  const idsVisibles = new Set(visibles.map((c) => c.id));
  return {
    ...catalogue,
    categories: visibles,
    articles: catalogue.articles.filter((a) => idsVisibles.has(a.categorie_id)),
  };
}
