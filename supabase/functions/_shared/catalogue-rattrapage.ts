export interface CategorieHistorique {
  id: string;
  parent_id: string | null;
  nom: string;
  ordre: number;
  actif: boolean;
}

export interface ArticleHistorique {
  id: string;
  categorie_id: string;
  nom: string;
  description: string | null;
  prix_base: number;
  image_url: string | null;
  disponible: boolean;
  actif: boolean;
  updated_at: string;
}

export interface CatalogueHistorique {
  categories: CategorieHistorique[];
  articles: ArticleHistorique[];
}

export interface CategorieCloudExistante {
  id: string;
  nom: string;
  actif: boolean;
}

export interface ArticleCloudExistant {
  id: string;
  categorie_id: string;
  nom: string;
}

function cleNom(nom: string): string {
  return nom.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('fr');
}

export function planifierRattrapageCatalogue(args: {
  restaurantId: string;
  catalogue: CatalogueHistorique;
  categoriesCloud: CategorieCloudExistante[];
  articlesCloud: ArticleCloudExistant[];
}): {
  categoriesAInserer: (CategorieHistorique & { restaurant_id: string })[];
  articlesAInserer: (ArticleHistorique & { restaurant_id: string })[];
} {
  const { restaurantId, catalogue, categoriesCloud, articlesCloud } = args;
  if (!restaurantId || !Array.isArray(catalogue.categories) || !Array.isArray(catalogue.articles)) {
    throw new Error('Catalogue historique invalide');
  }

  const categoriesParId = new Map(categoriesCloud.map((categorie) => [categorie.id, categorie]));
  const categoriesParNom = new Map<string, CategorieCloudExistante>();
  // Une catégorie active est préférable si le cloud contient déjà deux anciens
  // doublons du même nom : c'est celle que la console rend réellement visible.
  for (const categorie of [...categoriesCloud].sort((a, b) => Number(b.actif) - Number(a.actif))) {
    if (!categoriesParNom.has(cleNom(categorie.nom))) {
      categoriesParNom.set(cleNom(categorie.nom), categorie);
    }
  }

  const idCloudParIdLocal = new Map<string, string>();
  const cleCategorieParIdLocal = new Map<string, string>();
  const categoriesNouvelles = new Set<string>();
  for (const categorie of catalogue.categories) {
    const existante = categoriesParId.get(categorie.id) ?? categoriesParNom.get(cleNom(categorie.nom));
    if (existante) {
      idCloudParIdLocal.set(categorie.id, existante.id);
      cleCategorieParIdLocal.set(categorie.id, cleNom(existante.nom));
      continue;
    }

    idCloudParIdLocal.set(categorie.id, categorie.id);
    cleCategorieParIdLocal.set(categorie.id, cleNom(categorie.nom));
    categoriesNouvelles.add(categorie.id);
    const ajoutee: CategorieCloudExistante = {
      id: categorie.id,
      nom: categorie.nom,
      actif: categorie.actif,
    };
    categoriesParId.set(categorie.id, ajoutee);
    categoriesParNom.set(cleNom(categorie.nom), ajoutee);
  }

  const categoriesAInserer = catalogue.categories
    .filter((categorie) => categoriesNouvelles.has(categorie.id))
    .map((categorie) => ({
      restaurant_id: restaurantId,
      ...categorie,
      parent_id: categorie.parent_id
        ? idCloudParIdLocal.get(categorie.parent_id) ?? categorie.parent_id
        : null,
    }));

  const articlesParId = new Set(articlesCloud.map((article) => article.id));
  const articlesParCategorieEtNom = new Set(
    articlesCloud.map((article) => {
      const categorie = categoriesParId.get(article.categorie_id);
      const cleCategorie = categorie ? cleNom(categorie.nom) : article.categorie_id;
      return `${cleCategorie}:${cleNom(article.nom)}`;
    }),
  );
  const articlesAInserer: (ArticleHistorique & { restaurant_id: string })[] = [];

  for (const article of catalogue.articles) {
    const categorieId = idCloudParIdLocal.get(article.categorie_id);
    if (!categorieId) {
      throw new Error(`Article « ${article.nom} » : catégorie locale inconnue (${article.categorie_id})`);
    }
    const cleCategorie = cleCategorieParIdLocal.get(article.categorie_id) ?? categorieId;
    const cleArticle = `${cleCategorie}:${cleNom(article.nom)}`;
    if (articlesParId.has(article.id) || articlesParCategorieEtNom.has(cleArticle)) continue;

    articlesAInserer.push({
      restaurant_id: restaurantId,
      ...article,
      categorie_id: categorieId,
    });
    articlesParId.add(article.id);
    articlesParCategorieEtNom.add(cleArticle);
  }

  return { categoriesAInserer, articlesAInserer };
}
