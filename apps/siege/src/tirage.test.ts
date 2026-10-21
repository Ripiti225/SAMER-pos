import { describe, expect, it } from 'vitest';
import { cleMois, libelleClient, libelleMois, moisDeDate, moisParDefaut, moisRecents } from './tirage';

describe('mois proposés pour le tirage', () => {
  it('liste les mois du plus récent au plus ancien, en passant l’année', () => {
    expect(moisRecents(new Date('2026-02-10T12:00:00Z'), 4)).toEqual(['2026-02', '2026-01', '2025-12', '2025-11']);
  });

  it('choisit par défaut le dernier mois terminé, même le 1er à minuit', () => {
    expect(moisParDefaut(new Date('2026-11-01T00:00:00Z'))).toBe('2026-10');
    expect(moisParDefaut(new Date('2026-01-31T23:59:59Z'))).toBe('2025-12');
  });

  it('lit le mois en UTC (Abidjan), pas dans le fuseau du navigateur', () => {
    expect(cleMois(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10');
  });
});

describe('libellés', () => {
  it('écrit le mois en toutes lettres', () => {
    expect(libelleMois('2026-10')).toBe('octobre 2026');
    expect(moisDeDate('2026-10-01')).toBe('2026-10');
  });

  it('montre le téléphone d’un client resté sans nom', () => {
    expect(libelleClient({ nom: 'Awa', telephone: '0700000001' })).toBe('Awa');
    expect(libelleClient({ nom: null, telephone: '0700000001' })).toBe('0700000001');
    expect(libelleClient({ nom: '  ', telephone: '0700000001' })).toBe('0700000001');
  });
});
