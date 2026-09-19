import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { planifierRattrapageCatalogue } from './catalogue-rattrapage.ts';
import { ligneAutorisee } from './tables.ts';

const article = (id: string, categorieId: string, nom: string) => ({
  id,
  categorie_id: categorieId,
  nom,
  description: null,
  prix_base: 3000,
  image_url: null,
  disponible: true,
  actif: true,
  updated_at: '2026-09-15T00:00:00Z',
});

describe('rattrapage du catalogue historique', () => {
  test('la montée autorise uniquement les deux listes du rattrapage', () => {
    assert.deepEqual(
      ligneAutorisee(
        'catalogue_historique',
        { categories: [{ id: 'cat-1' }], articles: [{ id: 'article-1' }], intrus: 'ignoré' },
        'restaurant-1',
        'restaurant-1',
      ),
      {
        id: 'restaurant-1',
        restaurant_id: 'restaurant-1',
        categories: [{ id: 'cat-1' }],
        articles: [{ id: 'article-1' }],
      },
    );
  });

  test('réutilise une catégorie cloud du même nom et ne duplique pas son article', () => {
    const plan = planifierRattrapageCatalogue({
      restaurantId: 'restaurant-1',
      catalogue: {
        categories: [
          { id: 'cat-locale-pizzas', parent_id: null, nom: 'Pizzas', ordre: 1, actif: true },
          { id: 'cat-locale-boissons', parent_id: null, nom: 'Boissons', ordre: 2, actif: true },
        ],
        articles: [
          article('article-local-margherita', 'cat-locale-pizzas', 'Margherita'),
          article('article-local-cola', 'cat-locale-boissons', 'Coca-Cola'),
        ],
      },
      categoriesCloud: [
        { id: 'cat-cloud-pizzas', nom: '  PIZZAS  ', actif: true },
      ],
      articlesCloud: [
        { id: 'article-cloud-margherita', categorie_id: 'cat-cloud-pizzas', nom: 'margherita' },
      ],
    });

    assert.deepEqual(plan.categoriesAInserer, [
      {
        restaurant_id: 'restaurant-1',
        id: 'cat-locale-boissons',
        parent_id: null,
        nom: 'Boissons',
        ordre: 2,
        actif: true,
      },
    ]);
    assert.deepEqual(plan.articlesAInserer, [
      {
        restaurant_id: 'restaurant-1',
        ...article('article-local-cola', 'cat-locale-boissons', 'Coca-Cola'),
      },
    ]);
  });

  test('privilégie un identifiant déjà connu sans écraser sa fiche cloud', () => {
    const plan = planifierRattrapageCatalogue({
      restaurantId: 'restaurant-1',
      catalogue: {
        categories: [
          { id: 'cat-commune', parent_id: null, nom: 'Ancien nom local', ordre: 1, actif: true },
        ],
        articles: [article('article-commun', 'cat-commune', 'Ancien nom local')],
      },
      categoriesCloud: [{ id: 'cat-commune', nom: 'Nom corrigé au siège', actif: false }],
      articlesCloud: [{ id: 'article-commun', categorie_id: 'cat-commune', nom: 'Nom corrigé au siège' }],
    });

    assert.deepEqual(plan.categoriesAInserer, []);
    assert.deepEqual(plan.articlesAInserer, []);
  });

  test('ne duplique pas un article rangé dans un ancien doublon de catégorie cloud', () => {
    const plan = planifierRattrapageCatalogue({
      restaurantId: 'restaurant-1',
      catalogue: {
        categories: [
          { id: 'cat-locale', parent_id: null, nom: 'Boissons', ordre: 1, actif: true },
        ],
        articles: [article('article-local', 'cat-locale', 'Coca-Cola')],
      },
      categoriesCloud: [
        { id: 'cat-cloud-active', nom: 'Boissons', actif: true },
        { id: 'cat-cloud-archivee', nom: ' boissons ', actif: false },
      ],
      articlesCloud: [
        { id: 'article-cloud', categorie_id: 'cat-cloud-archivee', nom: 'COCA-COLA' },
      ],
    });

    assert.deepEqual(plan.categoriesAInserer, []);
    assert.deepEqual(plan.articlesAInserer, []);
  });

  test('remappe aussi la catégorie parente quand son nom existe déjà au siège', () => {
    const plan = planifierRattrapageCatalogue({
      restaurantId: 'restaurant-1',
      catalogue: {
        categories: [
          { id: 'parent-local', parent_id: null, nom: 'Cuisine', ordre: 1, actif: true },
          { id: 'enfant-local', parent_id: 'parent-local', nom: 'Grillades', ordre: 2, actif: true },
        ],
        articles: [],
      },
      categoriesCloud: [{ id: 'parent-cloud', nom: 'Cuisine', actif: true }],
      articlesCloud: [],
    });

    assert.equal(plan.categoriesAInserer[0]?.parent_id, 'parent-cloud');
  });

  test('refuse un article dont la catégorie locale manque du lot', () => {
    assert.throws(
      () => planifierRattrapageCatalogue({
        restaurantId: 'restaurant-1',
        catalogue: { categories: [], articles: [article('article-1', 'inconnue', 'Produit')] },
        categoriesCloud: [],
        articlesCloud: [],
      }),
      /catégorie locale inconnue/i,
    );
  });
});
