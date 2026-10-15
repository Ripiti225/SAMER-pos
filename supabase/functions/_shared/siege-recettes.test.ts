import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lireLiaisonRecette, lireProduitInventaire } from './siege-recettes.ts';

const restaurant_id = '11111111-1111-4111-8111-111111111111';
const produit_id = '22222222-2222-4222-8222-222222222222';
const article_id = '33333333-3333-4333-8333-333333333333';

test('un produit de comptage valide est normalisé, les données incomplètes sont refusées', () => {
  const corps = { restaurant_id, nom: '  Pain burger  ', categorie: 'PAIN', unite: ' u ', prix: 500 };
  assert.deepEqual(lireProduitInventaire(corps).valeur, { ...corps, nom: 'Pain burger', unite: 'u' });
  assert.ok(lireProduitInventaire({ ...corps, restaurant_id: 'invalide' }).erreur);
  assert.ok(lireProduitInventaire({ ...corps, categorie: 'AUTRE' }).erreur);
  assert.ok(lireProduitInventaire({ ...corps, prix: -1 }).erreur);
  assert.ok(lireProduitInventaire({ ...corps, prix: '500' }).erreur);
});

test('une recette accepte les fractions mais refuse les quantités imprécises', () => {
  const corps = { restaurant_id, produit_id, article_id, quantite: 0.5 };
  assert.deepEqual(lireLiaisonRecette(corps).valeur, corps);
  assert.ok(lireLiaisonRecette({ ...corps, quantite: 0 }).erreur);
  assert.ok(lireLiaisonRecette({ ...corps, quantite: 0.0001 }).erreur);
  assert.ok(lireLiaisonRecette({ ...corps, article_id: 'autre' }).erreur);
});
