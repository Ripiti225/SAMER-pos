import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lireBattement } from './sante-sites.ts';

describe('battement de cœur d’un site', () => {
  test('absent ou mal formé : null, la descente continue', () => {
    assert.equal(lireBattement(undefined), null);
    assert.equal(lireBattement(null), null);
    assert.equal(lireBattement('ok'), null);
    assert.equal(lireBattement([1, 2]), null);
  });

  test('normalise un battement complet', () => {
    const b = lireBattement({
      version_code: ' 3ff10db ',
      commit_git: '3FF10DB0123456789ABCDEF0123456789ABCDEF0',
      lignes_en_attente: 12.7,
      plus_ancienne_en_attente: '2026-10-21T08:00:00Z',
      dernier_acquittement: '2026-10-21T09:00:00.000Z',
      derniere_descente: '2026-10-21T09:05:00Z',
      derniere_erreur: 'Cloud injoignable (sync-push)',
      heure_site: '2026-10-21T09:06:00Z',
    });
    assert.ok(b);
    assert.equal(b.version_code, '3ff10db');
    assert.equal(b.commit_git, '3ff10db0123456789abcdef0123456789abcdef0');
    assert.equal(b.lignes_en_attente, 12);
    assert.equal(b.plus_ancienne_en_attente, '2026-10-21T08:00:00.000Z');
    assert.equal(b.derniere_descente, '2026-10-21T09:05:00.000Z');
    assert.equal(b.derniere_erreur, 'Cloud injoignable (sync-push)');
  });

  test('écarte les valeurs absurdes au lieu de les écrire', () => {
    const b = lireBattement({
      commit_git: 'pas-un-commit; DROP TABLE',
      lignes_en_attente: -3,
      derniere_descente: 'hier',
      derniere_erreur: 'x'.repeat(2000),
    });
    assert.ok(b);
    assert.equal(b.commit_git, null);
    assert.equal(b.lignes_en_attente, null);
    assert.equal(b.derniere_descente, null);
    assert.equal(b.derniere_erreur?.length, 500);
    assert.equal(b.version_code, null);
  });
});
