import { describe, expect, it } from 'vitest';
import type { CatalogueVue } from '@pos/shared';
import { urlsImagesCatalogue } from './catalogue-cache';

function article(id: string, image_url: string | null): CatalogueVue['articles'][number] {
  return {
    id,
    categorie_id: 'cat',
    nom: id,
    description: null,
    prix_base: 1_000,
    image_url,
    disponible: true,
    prix_canaux: {},
    options_extras: [],
  };
}

describe('cache local du catalogue', () => {
  it('prépare chaque photo une seule fois et ignore les articles sans photo', () => {
    const catalogue = {
      categories: [],
      combos: [],
      promotions: [],
      articles: [
        article('1', 'https://photos.test/chawarma.png'),
        article('2', null),
        article('3', 'https://photos.test/chawarma.png'),
        article('4', 'https://photos.test/pizza.png'),
      ],
    } satisfies CatalogueVue;

    expect(urlsImagesCatalogue(catalogue)).toEqual([
      'https://photos.test/chawarma.png',
      'https://photos.test/pizza.png',
    ]);
  });
});
