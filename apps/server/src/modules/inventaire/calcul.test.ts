import { describe, test, expect } from 'vitest';
import { calculerLignes, expliqueeInvalide, type Produit } from './calcul.js';

describe('expliqueeInvalide — on ne justifie pas plus que ce qui manque', () => {
  test('expliquer exactement le manquant est valide', () => {
    expect(expliqueeInvalide(-4, 4)).toBe(false);
  });

  test('expliquer moins que le manquant est valide', () => {
    expect(expliqueeInvalide(-4, 1)).toBe(false);
  });

  test('expliquer plus que le manquant est refusé', () => {
    expect(expliqueeInvalide(-1, 2)).toBe(true);
  });

  test('le montant saisi à la place de la quantité est refusé (cas réel du 23/08)', () => {
    // Total poulet : manquant 3, prix 8000 — le caissier a saisi 24 000.
    expect(expliqueeInvalide(-3, 24_000)).toBe(true);
  });

  test('les quantités fractionnaires passent malgré la virgule flottante', () => {
    expect(expliqueeInvalide(-0.65, 0.65)).toBe(false);
    expect(expliqueeInvalide(-0.17, 0.17)).toBe(false);
  });

  test('sachet de frites : manquant 0,65 expliqué 67 — refusé (cas réel du 23/08)', () => {
    expect(expliqueeInvalide(-0.65, 67)).toBe(true);
  });

  test('un surplus est borné comme un manquant : Samtrackly retient sur |écart|', () => {
    expect(expliqueeInvalide(2, 16_000)).toBe(true);
    expect(expliqueeInvalide(2, 2)).toBe(false);
    expect(expliqueeInvalide(3, 1)).toBe(false);
  });

  test('un écart nul ou non compté ne bloque rien', () => {
    expect(expliqueeInvalide(0, 5)).toBe(false);
    expect(expliqueeInvalide(null, 5)).toBe(false);
  });
});

/**
 * Pâte de poulet (`po7`, rôle AUTO_ENT) : ses ENTRÉES se déduisent du poulet
 * frais reçu, ses SORTIES viennent de la recette, comme tout produit vendu.
 *
 * Le sachet se vend à part (1 000 FCFA, 1 sachet = 10 poulets). Tant qu'aucun
 * article ne lui était rattaché, ses sorties restaient à 0 et son théorique ne
 * faisait que monter — le cas signalé sur le terrain le 26/09.
 */
describe('AUTO_ENT — entrées dérivées, sorties par la recette', () => {
  const produit = (p: Partial<Produit> & Pick<Produit, 'id' | 'code' | 'role'>): Produit => ({
    categorie: 'POUL',
    nom: p.code,
    prix: 0,
    unite: 'u',
    ratio: null,
    ordre: 0,
    actif: true,
    ...p,
  } as Produit);

  const poulet = produit({ id: 'p1', code: 'po1', role: 'ENTREE', nom: 'Poulet frais', ordre: 1 });
  const pate = produit({ id: 'p7', code: 'po7', role: 'AUTO_ENT', nom: 'Pâte de poulet', ratio: '10', ordre: 7 });

  test('50 poulets reçus font 5 sachets ; 3 sachets vendus en sortent 3', () => {
    const lignes = calculerLignes(
      [poulet, pate],
      [],
      new Map([['p1', 50]]),
      new Map([['p7', 3]]),
    );
    const l = lignes.find((x) => x.code === 'po7')!;
    expect(l.entrees).toBe(5);
    expect(l.sorties).toBe(3);
    expect(l.theorique).toBe(2);
  });

  test('sans recette, les sorties restent à 0 et le stock ne fait que monter', () => {
    const lignes = calculerLignes([poulet, pate], [], new Map([['p1', 50]]), new Map());
    const l = lignes.find((x) => x.code === 'po7')!;
    expect(l.sorties).toBe(0);
    expect(l.theorique).toBe(5);
  });
});

/**
 * Darina (`b7`, rôle DARINA) : elle rentre en SACHETS et part avec les Pots
 * Fresco vendus — 1 sachet pour 9 pots. Le calcul retirait un sachet par pot,
 * donc neuf fois trop : signalé sur le terrain le 26/09.
 */
describe('DARINA — un sachet couvre plusieurs Pots Fresco', () => {
  const produit = (p: Partial<Produit> & Pick<Produit, 'id' | 'code' | 'role'>): Produit => ({
    categorie: 'BOIS',
    nom: p.code,
    prix: 0,
    unite: 'u',
    ratio: null,
    ordre: 0,
    actif: true,
    ...p,
  } as Produit);

  const fresco = produit({ id: 'b6', code: 'b6', role: 'COMPTE', nom: 'Pot Fresco', ordre: 6 });
  const darina = produit({ id: 'b7', code: 'b7', role: 'DARINA', nom: 'Darina', unite: 'sachet', ratio: '9', ordre: 7 });

  test('90 Pots Fresco vendus retirent 10 sachets, pas 90', () => {
    const lignes = calculerLignes([fresco, darina], [], new Map(), new Map([['b6', 90]]));
    expect(lignes.find((x) => x.code === 'b7')!.sorties).toBe(10);
  });

  test('un compte partiel se dit en fraction de sachet', () => {
    const lignes = calculerLignes([fresco, darina], [], new Map(), new Map([['b6', 5]]));
    expect(lignes.find((x) => x.code === 'b7')!.sorties).toBe(0.56);
  });

  test('ratio absent : on retombe sur l’ancien 1 pot = 1 sachet, jamais sur 0', () => {
    const sansRatio = produit({ id: 'b7', code: 'b7', role: 'DARINA', nom: 'Darina', ratio: null, ordre: 7 });
    const lignes = calculerLignes([fresco, sansRatio], [], new Map(), new Map([['b6', 7]]));
    expect(lignes.find((x) => x.code === 'b7')!.sorties).toBe(7);
  });
});
