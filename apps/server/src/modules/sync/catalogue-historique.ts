import { db } from '../../db/client.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { articles, categories, restaurant, syncEtat } from '../../db/schema/index.js';

export interface ResultatPreparationCatalogueHistorique {
  prepare: boolean;
  categories: number;
  articles: number;
}

export async function preparerRattrapageCatalogueHistorique(): Promise<ResultatPreparationCatalogueHistorique> {
  return db.transaction(async (tx) => {
    const [site] = await tx.select().from(restaurant).limit(1);
    const lignesCategories = await tx.select().from(categories);
    if (!site || lignesCategories.length === 0) {
      // Un poste peut démarrer avant son seed/import initial. Aucun marqueur :
      // le prochain démarrage devra retenter.
      return { prepare: false, categories: 0, articles: 0 };
    }

    // Le marqueur est pris AVANT la lecture : deux démarrages concurrents ne
    // peuvent donc jamais créer deux paquets. Toute erreur annule également le
    // marqueur, puisque l'outbox et lui vivent dans la même transaction.
    // Il contient l'identité du site : un ré-enrôlement avec un nouvel UUID
    // republie le même catalogue sous le bon restaurant cloud.
    const flux = `CATALOGUE_HISTORIQUE_PREPARE:${site.id}`;
    const marqueur = await tx
      .insert(syncEtat)
      .values({ flux, version: 1, synced_at: null })
      .onConflictDoNothing()
      .returning({ flux: syncEtat.flux });
    if (marqueur.length === 0) return { prepare: false, categories: 0, articles: 0 };

    const lignesArticles = await tx.select().from(articles);

    await ecrireOutbox(tx, 'catalogue_historique', 'INSERT', site.id, {
      categories: lignesCategories.map((categorie) => ({
        id: categorie.id,
        parent_id: categorie.parent_id,
        nom: categorie.nom,
        ordre: categorie.ordre,
        actif: categorie.actif,
      })),
      articles: lignesArticles.map((article) => ({
        id: article.id,
        categorie_id: article.categorie_id,
        nom: article.nom,
        description: article.description,
        prix_base: article.prix_base,
        image_url: article.image_url,
        disponible: article.disponible,
        actif: article.actif,
        updated_at: article.updated_at.toISOString(),
      })),
    });

    return {
      prepare: true,
      categories: lignesCategories.length,
      articles: lignesArticles.length,
    };
  });
}
