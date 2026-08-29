import { describe, test, expect } from 'vitest';
import { expliqueeInvalide } from './calcul.js';

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
