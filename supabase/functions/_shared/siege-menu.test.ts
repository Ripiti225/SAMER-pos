import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lireModificationArticle } from './siege-menu.ts';

const restaurant = '11111111-1111-4111-8111-111111111111';
const article = '22222222-2222-4222-8222-222222222222';
const categorie = '33333333-3333-4333-8333-333333333333';

const corps = () => ({
  restaurant_id: restaurant,
  article_id: article,
  version_attendue: 42,
  categorie_id: categorie,
  nom: '  Poulet braisé  ',
  description: '  Avec frites  ',
  prix_base: 3500,
  image_url: null,
  disponible: false,
  actif: false,
});

describe('modification du menu depuis le siège', () => {
  test('conserve les deux désactivations et normalise les textes', () => {
    const resultat = lireModificationArticle(corps());
    assert.ok(resultat.valeur);
    assert.equal(resultat.valeur.nom, 'Poulet braisé');
    assert.equal(resultat.valeur.description, 'Avec frites');
    assert.equal(resultat.valeur.disponible, false);
    assert.equal(resultat.valeur.actif, false);
  });

  test('exige le restaurant et la version, sans conversion implicite du prix', () => {
    assert.ok(lireModificationArticle({ ...corps(), restaurant_id: 'autre' }).erreur);
    assert.ok(lireModificationArticle({ ...corps(), version_attendue: undefined }).erreur);
    assert.ok(lireModificationArticle({ ...corps(), prix_base: '3500' }).erreur);
    assert.ok(lireModificationArticle({ ...corps(), prix_base: 2_147_483_648 }).erreur);
  });

  test('accepte la version initiale zéro mais pas un nombre négatif', () => {
    assert.ok(lireModificationArticle({ ...corps(), version_attendue: 0 }).valeur);
    assert.ok(lireModificationArticle({ ...corps(), version_attendue: -1 }).erreur);
  });
});
