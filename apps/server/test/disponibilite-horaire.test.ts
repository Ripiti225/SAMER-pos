import { describe, expect, it } from 'vitest';
import { dansPlageHoraire, jourAbidjan } from '../src/modules/catalogue/horaires.js';

describe('disponibilité horaire', () => {
  it.each([
    ['03:59', '04:00', '10:00', false],
    ['04:00', '04:00', '10:00', true],
    ['09:59', '04:00', '10:00', true],
    ['10:00', '04:00', '10:00', false],
    ['15:59', '10:00', '16:00', true],
    ['16:00', '10:00', '16:00', false],
    ['16:00', '16:00', '00:00', true],
    ['23:59', '16:00', '00:00', true],
    ['00:00', '16:00', '00:00', false],
  ])('%s dans %s–%s vaut %s', (heure, debut, fin, attendu) => {
    expect(dansPlageHoraire(heure as string, debut as string, fin as string)).toBe(attendu);
  });

  it('une catégorie sans horaire reste disponible', () => {
    expect(dansPlageHoraire('02:00', null, null)).toBe(true);
  });

  it('calcule le jour dans le fuseau d’Abidjan', () => {
    expect(jourAbidjan(new Date('2026-09-07T12:00:00Z'))).toBe(1);
    expect(jourAbidjan(new Date('2026-09-13T12:00:00Z'))).toBe(7);
  });
});
