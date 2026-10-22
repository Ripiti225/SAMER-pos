import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_LOT_MS, doitRendreLaMain } from './budget-lot.ts';

describe('budget de temps d’un lot sync-push', () => {
  test('continue tant que le budget n’est pas épuisé', () => {
    assert.equal(doitRendreLaMain(0, BUDGET_LOT_MS - 1, 150), false);
  });

  test('rend la main une fois le budget épuisé, pour répondre avant le délai du POS', () => {
    assert.equal(doitRendreLaMain(0, BUDGET_LOT_MS, 120), true);
  });

  test('traite toujours au moins une ligne, sinon la file ne pourrait jamais avancer', () => {
    assert.equal(doitRendreLaMain(0, BUDGET_LOT_MS * 10, 0), false);
  });

  test('le budget laisse une marge nette sous le délai de 15 s du POS', () => {
    assert.ok(BUDGET_LOT_MS <= 10_000);
  });
});
