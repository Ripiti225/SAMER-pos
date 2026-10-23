import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lireBattement, lireBlocMaj } from './sante-sites.ts';

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

describe('bloc « maj » du battement (contrat MAJ § 3)', () => {
  test('absent : null, ancien POS', () => {
    assert.equal(lireBlocMaj({ version_code: 'x' }), null);
    assert.equal(lireBlocMaj(undefined), null);
    assert.equal(lireBlocMaj({ maj: 'oui' }), null);
  });

  test('bloc complet', () => {
    const b = lireBlocMaj({
      maj: {
        etat: 'PRETE',
        numero_installe: 2026102301,
        numero_prete: 2026102401,
        installation_prevue: '2026-10-25T06:00:00Z',
        report_jusqua: null,
        derniere_erreur: null,
        espace_libre_mo: 51234,
        taille_pgdata_mo: 70,
        integrite: { suspects_grenam: 0 },
      },
    });
    assert.deepEqual(b, {
      maj_etat: 'PRETE',
      maj_numero_installe: 2026102301,
      maj_numero_prete: 2026102401,
      maj_installation_prevue: '2026-10-25T06:00:00.000Z',
      maj_report_jusqua: null,
      maj_derniere_erreur: null,
      maj_espace_libre_mo: 51234,
      maj_taille_pgdata_mo: 70,
      maj_suspects_grenam: 0,
    });
  });

  test('champs abîmés : NULL un par un, le reste passe', () => {
    const b = lireBlocMaj({ maj: { etat: 'FINI', numero_installe: '12', espace_libre_mo: -5, integrite: { suspects_grenam: 2 }, derniere_erreur: 'y'.repeat(900) } });
    assert.ok(b);
    assert.equal(b.maj_etat, null);
    assert.equal(b.maj_numero_installe, null);
    assert.equal(b.maj_espace_libre_mo, null);
    assert.equal(b.maj_suspects_grenam, 2);
    assert.equal(b.maj_derniere_erreur?.length, 500);
  });
});
