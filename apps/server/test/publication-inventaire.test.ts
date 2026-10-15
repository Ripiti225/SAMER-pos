import { expect, it } from 'vitest';
import type { LigneDescente } from '../src/modules/sync/cloud-client.js';
import { preparerPublicationInventaire } from '../src/modules/inventaire/publication-cloud.js';
import type { inventaireConsommations, produitsInventaire } from '../src/db/schema/index.js';

const produit = {
  id: '11111111-1111-4111-8111-111111111111', code: 'PAIN_BURGER', categorie: 'PAIN', nom: 'Pain burger',
} as typeof produitsInventaire.$inferSelect;
const recette = {
  id: '22222222-2222-4222-8222-222222222222', produit_id: produit.id,
  article_id: '33333333-3333-4333-8333-333333333333', quantite: '1',
} as typeof inventaireConsommations.$inferSelect;
const ligne = (table_name: string, row: Record<string, unknown>): LigneDescente => ({ table_name, row });
const articleSiege = ligne('articles', { id: recette.article_id });

it('prépare un transfert rejouable sans écraser les recettes du siège', () => {
  expect(preparerPublicationInventaire([produit], [recette], [articleSiege])).toEqual({ produits: [produit], recettes: [recette] });
  const dejaAuSiege = [
    articleSiege,
    ligne('produits_inventaire', { id: produit.id, code: produit.code, categorie: produit.categorie, nom: produit.nom }),
    ligne('inventaire_consommations', { id: recette.id, produit_id: recette.produit_id, article_id: recette.article_id, quantite: 2 }),
  ];
  expect(preparerPublicationInventaire([produit], [recette], dejaAuSiege)).toEqual({ produits: [], recettes: [] });
});

it('arrête le transfert si un code, un nom ou une liaison désigne un autre identifiant', () => {
  const autreId = '44444444-4444-4444-8444-444444444444';
  expect(() => preparerPublicationInventaire([produit], [recette], [
    articleSiege,
    ligne('produits_inventaire', { id: autreId, code: produit.code, categorie: produit.categorie, nom: produit.nom }),
  ])).toThrow('autre identifiant');
  expect(() => preparerPublicationInventaire([produit], [recette], [
    articleSiege,
    ligne('produits_inventaire', { id: autreId, code: 'AUTRE', categorie: produit.categorie, nom: produit.nom }),
  ])).toThrow('doublon');
  expect(() => preparerPublicationInventaire([produit], [recette], [
    articleSiege,
    ligne('inventaire_consommations', { id: autreId, produit_id: recette.produit_id, article_id: recette.article_id }),
  ])).toThrow('autre identifiant');
});

it('attend les articles de vente avant de publier une recette', () => {
  expect(() => preparerPublicationInventaire([produit], [recette], [])).toThrow('pas encore au cloud');
});
