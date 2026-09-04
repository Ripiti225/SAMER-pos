import { describe, expect, it } from 'vitest';
import { CLASSES_CATEGORIES } from './mise-en-page-categories';

describe('lisibilité des catégories de la caisse', () => {
  it('réserve une colonne large et autorise deux lignes pour les noms', () => {
    expect(CLASSES_CATEGORIES.grille).toContain('245px');
    expect(CLASSES_CATEGORIES.nom).toContain('line-clamp-2');
    expect(CLASSES_CATEGORIES.nom).not.toContain('truncate');
  });
});
