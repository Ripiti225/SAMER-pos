/**
 * Stock sous la photo des plats — déduction du produit de référence, calcul des
 * plats possibles et texte affiché. Le catalogue de comptage reprend celui des
 * sites (codes, rôles et ratios de `pos_samer`).
 */
import { describe, expect, test } from 'vitest';
import type { Produit } from './calcul.js';
import {
  consommationParPlat,
  deduireReference,
  formaterQuantite,
  referenceDuPlat,
  stockDuPlat,
  type LigneRecette,
} from './stock-plats.js';

const produit = (code: string, categorie: string, nom: string, role: string, ratio: string | null = null, unite = 'u', ordre = 1): Produit => ({
  id: `id-${code}`,
  code,
  categorie,
  nom,
  prix: 0,
  unite,
  role,
  ratio,
  ordre,
  actif: true,
});

const PRODUITS: Produit[] = [
  produit('p1', 'PAIN', 'Pain chawarma', 'COMPTE'),
  produit('p2', 'PAIN', 'Pain burger', 'COMPTE', null, 'u', 2),
  produit('a1', 'APER', 'Nems', 'COMPTE'),
  produit('a7', 'APER', 'Fatayer JFromage', 'COMPTE', null, 'u', 7),
  produit('b1', 'BOIS', 'Nespresso', 'COMPTE'),
  produit('pl1', 'PLAT', 'Steak', 'COMPTE'),
  produit('pl4', 'PLAT', 'Viande burger', 'COMPTE', null, 'u', 4),
  produit('po1', 'POUL', 'Poulet frais', 'ENTREE'),
  produit('po2', 'POUL', 'Pané', 'CONSO_POULET', '1', 'u', 2),
  produit('po8', 'POUL', 'Total poulet', 'TOTAL_POULET', null, 'u', 8),
  produit('f4', 'FROM', 'Pizza moyenne (160g)', 'CONSO_FROMAGE', '160', 'g', 3),
  produit('f7', 'FROM', 'Fatayer JF 30g', 'CONSO_FROMAGE', '30', 'g', 6),
  produit('f8', 'FROM', 'Sandwich/Tacos (50g)', 'CONSO_FROMAGE', '50', 'g', 7),
  produit('f10', 'FROM', 'Total Fromage', 'TOTAL_FROMAGE', null, 'g', 9),
  produit('fr1', 'FRIT', 'Portions de frites', 'CONSO_FRITES', '8', 'u', 1),
  produit('fr3', 'FRIT', 'Sachet de frites', 'TOTAL_FRITES', null, 'sachet', 3),
];
const id = (code: string) => `id-${code}`;
const recette = (...lignes: [string, number][]): LigneRecette[] =>
  lignes.map(([code, quantite]) => ({ article_id: 'art', produit_id: id(code), quantite }));

describe('déduction automatique du produit de référence', () => {
  test('produit fini : la boisson est elle-même comptée — son propre stock', () => {
    const ref = deduireReference('Nespresso', recette(['b1', 1]), PRODUITS);
    expect(ref).toMatchObject({ raison: 'PRODUIT_FINI', produit: { code: 'b1' } });
  });

  test('produit fini prioritaire sur le fromage (Fatayer Jambon Fromage → ses fatayers)', () => {
    const ref = deduireReference('Fatayer Jambon Fromage', recette(['a7', 1], ['f7', 1]), PRODUITS);
    expect(ref).toMatchObject({ raison: 'PRODUIT_FINI', produit: { code: 'a7' } });
  });

  test('fromage : une pizza se lit sur « Total Fromage »', () => {
    const ref = deduireReference('Pizza Reine (M)', recette(['f4', 1]), PRODUITS);
    expect(ref).toMatchObject({ raison: 'FROMAGE', produit: { code: 'f10' } });
  });

  test('fromage prioritaire sur le pain et la viande (Burger)', () => {
    const ref = deduireReference('Burger', recette(['f8', 1], ['p2', 1], ['pl4', 1]), PRODUITS);
    expect(ref).toMatchObject({ raison: 'FROMAGE', produit: { code: 'f10' } });
  });

  test('poulet : le poulet pané se lit sur « Total poulet », pas sur les frites', () => {
    const ref = deduireReference('Poulet Pané + Frites', recette(['fr1', 1], ['po2', 1]), PRODUITS);
    expect(ref).toMatchObject({ raison: 'POULET', produit: { code: 'po8' } });
  });

  test('premier ingrédient : le steak d’un Steak Frites passe avant les frites', () => {
    const ref = deduireReference('Steak Frites', recette(['fr1', 1], ['pl1', 1]), PRODUITS);
    expect(ref).toMatchObject({ raison: 'INGREDIENT', produit: { code: 'pl1' } });
  });

  test('ingrédient seul : des frites se lisent sur le stock de frites (sachets)', () => {
    const ref = deduireReference('Frites', recette(['fr1', 1]), PRODUITS);
    expect(ref).toMatchObject({ raison: 'INGREDIENT', produit: { code: 'fr3' } });
  });

  test('un pain n’est pas un produit fini : Chawarma → ingrédient « Pain chawarma »', () => {
    const ref = deduireReference('Chawarma Poulet', recette(['p1', 1]), PRODUITS);
    expect(ref).toMatchObject({ raison: 'INGREDIENT', produit: { code: 'p1' } });
  });

  test('même nom en tête = produit fini (Nems (10 pièces) → Nems)', () => {
    const ref = deduireReference('Nems (10 pièces)', recette(['a1', 1]), PRODUITS);
    expect(ref?.raison).toBe('PRODUIT_FINI');
  });

  test('sans recette : rien', () => {
    expect(deduireReference('Attiéké', [], PRODUITS)).toBeNull();
  });
});

describe('correction manuelle', () => {
  test('un produit précis l’emporte sur la déduction', () => {
    const ref = referenceDuPlat('Burger', recette(['f8', 1], ['p2', 1]), PRODUITS, { mode: 'PRODUIT', produit_id: id('p2') });
    expect(ref).toMatchObject({ raison: 'MANUEL', produit: { code: 'p2' } });
  });

  test('« ne rien afficher » éteint le plat', () => {
    expect(referenceDuPlat('Burger', recette(['f8', 1]), PRODUITS, { mode: 'AUCUN' })).toBeNull();
  });

  test('un produit disparu ramène à l’automatique', () => {
    const ref = referenceDuPlat('Pizza Reine (M)', recette(['f4', 1]), PRODUITS, { mode: 'PRODUIT', produit_id: 'inconnu' });
    expect(ref?.raison).toBe('FROMAGE');
  });
});

describe('consommation d’un plat = recette × ratio, par les formules de l’inventaire', () => {
  test('pizza moyenne : 160 g de fromage', () => {
    expect(consommationParPlat(recette(['f4', 1]), PRODUITS, PRODUITS.find((p) => p.code === 'f10')!)).toBe(160);
  });

  test('demi-poulet : 0,5 poulet', () => {
    expect(consommationParPlat(recette(['po2', 0.5]), PRODUITS, PRODUITS.find((p) => p.code === 'po8')!)).toBe(0.5);
  });

  test('frites : 1 portion sur 8 par sachet, sans l’arrondi au centième', () => {
    expect(consommationParPlat(recette(['fr1', 1]), PRODUITS, PRODUITS.find((p) => p.code === 'fr3')!)).toBe(0.125);
  });

  test('produit que la recette ne consomme pas : 0', () => {
    expect(consommationParPlat(recette(['f4', 1]), PRODUITS, PRODUITS.find((p) => p.code === 'p1')!)).toBe(0);
  });
});

describe('plats possibles, unités et seuil', () => {
  const ref = (code: string, raison: 'FROMAGE' | 'POULET' | 'PRODUIT_FINI' | 'INGREDIENT' | 'MANUEL') => ({
    produit: PRODUITS.find((p) => p.code === code)!,
    raison,
  });

  test('fromage : grammes en kg, plats arrondis vers le bas', () => {
    const s = stockDuPlat(ref('f10', 'FROMAGE'), 2400, 160, 5);
    expect(s.plats_possibles).toBe(15);
    expect(s.texte).toBe('Fromage 2,4 kg · ≈ 15');
    expect(s.etat).toBe('OK');
  });

  test('poulet : poulets entiers, un demi-poulet par plat', () => {
    const s = stockDuPlat(ref('po8', 'POULET'), 18, 2, 5);
    expect(s.texte).toBe('Poulet 18 · ≈ 9');
  });

  test('produit fini : juste « Reste 18 »', () => {
    expect(stockDuPlat(ref('b1', 'PRODUIT_FINI'), 18, 1, 5).texte).toBe('Reste 18');
  });

  test('frites : sachets, au pluriel', () => {
    const s = stockDuPlat(ref('fr3', 'INGREDIENT'), 3.5, 0.125, 5);
    expect(s.texte).toBe('Frites 3,5 sachets · ≈ 28');
  });

  test('seuil : au plus 5 plats → bientôt épuisé ; 6 → normal', () => {
    expect(stockDuPlat(ref('f10', 'FROMAGE'), 800, 160, 5).etat).toBe('BIENTOT');
    expect(stockDuPlat(ref('f10', 'FROMAGE'), 960, 160, 5).etat).toBe('OK');
    // Seuil réglé à 10 par le site
    expect(stockDuPlat(ref('f10', 'FROMAGE'), 960, 160, 10).etat).toBe('BIENTOT');
  });

  test('épuisé : moins d’un plat, ou stock théorique négatif', () => {
    const presque = stockDuPlat(ref('f10', 'FROMAGE'), 150, 160, 5);
    expect(presque.plats_possibles).toBe(0);
    expect(presque.etat).toBe('EPUISE');
    const negatif = stockDuPlat(ref('po8', 'POULET'), -2, 1, 5);
    expect(negatif.plats_possibles).toBe(0);
    expect(negatif.etat).toBe('EPUISE');
  });

  test('sans consommation connue : le stock seul, jamais d’orange sur des grammes', () => {
    const s = stockDuPlat(ref('p1', 'MANUEL'), 3, 0, 5);
    expect(s.plats_possibles).toBeNull();
    expect(s.texte).toBe('Pain chawarma 3');
    expect(s.etat).toBe('OK');
    expect(stockDuPlat(ref('p1', 'MANUEL'), 0, 0, 5).etat).toBe('EPUISE');
  });

  test('unités lisibles', () => {
    expect(formaterQuantite(850, 'g')).toBe('850 g');
    expect(formaterQuantite(12_500, 'g')).toBe('12,5 kg');
    expect(formaterQuantite(1, 'sachet')).toBe('1 sachet');
    expect(formaterQuantite(4.5, 'pot')).toBe('4,5 pots');
    expect(formaterQuantite(18, 'u')).toBe('18');
  });
});
