'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validerManifeste,
  lireManifeste,
  serialiserManifeste,
  problemeChemin,
  problemesCompatibilite,
  CHEMIN_LANCEUR,
} = require('../index.cjs');
const { manifesteApp, sha } = require('./aide.cjs');

const invalide = { code: 'MANIFESTE_INVALIDE' };

test('manifeste APP valide : accepté et relu à l’identique', () => {
  const m = manifesteApp();
  assert.deepEqual(validerManifeste(structuredClone(m)), m);
  assert.deepEqual(lireManifeste(serialiserManifeste(m)), m);
});

test('manifeste DEPENDANCES valide', () => {
  const m = manifesteApp();
  const dep = {
    format: 1,
    type: 'DEPENDANCES',
    empreinte: sha('pnpm-lock'),
    publie_le: m.publie_le,
    node_min: '22.0.0',
    archive: m.archive,
    morceaux: m.morceaux,
    fichiers: [{ chemin: 'node_modules/fastify/package.json', sha256: sha('x'), taille: 1 }],
  };
  assert.ok(validerManifeste(dep));
  assert.throws(() => validerManifeste({ ...dep, numero: 3 }), invalide);
});

test('champ inconnu, manquant ou mal typé : refusé', () => {
  assert.throws(() => validerManifeste(manifesteApp({ en_trop: 1 })), invalide);
  const sansNotes = manifesteApp();
  delete sansNotes.notes;
  assert.throws(() => validerManifeste(sansNotes), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ numero: 0 })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ numero: '42' })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ numero: 4.5 })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ version: '2026.13.01-1' })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ version: '2026.10.23' })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ commit: 'HEAD' })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ format: 2 })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ type: 'AUTRE' })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ node_min: '22' })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ publie_le: 'hier' })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ dependances: { empreinte: 'abc' } })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ notes: 'x'.repeat(5000) })), invalide);
  assert.throws(() => validerManifeste([]), invalide);
  assert.throws(() => lireManifeste(Buffer.from('{pas du json')), invalide);
  assert.throws(() => lireManifeste(Buffer.from([0xff, 0xfe, 0x7b, 0x7d])), invalide);
});

test('morceaux : somme des tailles, doublons, noms', () => {
  const m = manifesteApp();
  assert.throws(() => validerManifeste({ ...m, archive: { ...m.archive, taille: 301 } }), invalide);
  assert.throws(() => validerManifeste({ ...m, morceaux: [] }), invalide);
  assert.throws(() => validerManifeste({ ...m, morceaux: [m.morceaux[0], { ...m.morceaux[0] }], archive: { ...m.archive, taille: 400 } }), invalide);
  for (const nom of ['../m0', 'a/b', '', '.cache', 'C:x']) {
    assert.throws(() => validerManifeste({ ...m, morceaux: [{ ...m.morceaux[0], nom }, m.morceaux[1]] }), invalide, nom);
  }
  assert.throws(() => validerManifeste({ ...m, morceaux: [{ ...m.morceaux[0], sha256: 'ABC' }, m.morceaux[1]] }), invalide);
});

test('chemins de fichiers dangereux : refusés', () => {
  const dangereux = [
    '../app.precedente/x.js',
    'apps/../../etc/passwd',
    '..',
    '/etc/passwd',
    'C:/Windows/system32/x.dll',
    'c:relatif.txt',
    'apps\\server\\x.ts',
    'apps//x.ts',
    'apps/./x.ts',
    'apps/x.ts/',
    'fichier.',
    'dossier /x',
    'apps/CON',
    'aux.txt',
    'x.js:flux',
    'a\u0000b',
    '',
    'é'.repeat(200),
  ];
  for (const chemin of dangereux) {
    assert.ok(problemeChemin(chemin), `devrait être refusé : ${JSON.stringify(chemin)}`);
    assert.throws(
      () => validerManifeste(manifesteApp({ fichiers: [{ chemin, sha256: sha('x'), taille: 1 }] })),
      invalide,
      JSON.stringify(chemin),
    );
  }
  for (const chemin of ['apps/server/src/index.ts', '.env.example', 'a/b/c/d.e.f', 'consoles/x.js', 'apps/caisse/dist/assets/index-AbC_9.js']) {
    assert.equal(problemeChemin(chemin), null, chemin);
  }
});

test('fichiers : doublon (casse comprise) et fichier-dossier refusés', () => {
  const f = (chemin) => ({ chemin, sha256: sha(chemin), taille: 1 });
  assert.throws(() => validerManifeste(manifesteApp({ fichiers: [f('a.js'), f('A.js')] })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ fichiers: [f('apps'), f('apps/x.js')] })), invalide);
  assert.throws(() => validerManifeste(manifesteApp({ fichiers: [] })), invalide);
});

test('migrations : triées, dernière cohérente', () => {
  const avec = (migrations) => manifesteApp({ migrations });
  assert.ok(validerManifeste(avec({ derniere: '0043_b', nouvelles: [], retrocompatibles: true })));
  assert.ok(validerManifeste(avec({ derniere: null, nouvelles: [], retrocompatibles: true })));
  assert.ok(validerManifeste(avec({ derniere: '0043_b', nouvelles: ['0042_a', '0043_b'], retrocompatibles: false })));
  assert.throws(() => validerManifeste(avec({ derniere: '0043_b', nouvelles: ['0043_b', '0042_a'], retrocompatibles: true })), invalide);
  assert.throws(() => validerManifeste(avec({ derniere: '0044_c', nouvelles: ['0043_b'], retrocompatibles: true })), invalide);
  assert.throws(() => validerManifeste(avec({ derniere: '43', nouvelles: [], retrocompatibles: true })), invalide);
  assert.throws(() => validerManifeste(avec({ derniere: '0043_b', nouvelles: [], retrocompatibles: 'oui' })), invalide);
});

test('section lanceur facultative, liée au fichier de l’archive', () => {
  const exe = { chemin: CHEMIN_LANCEUR, sha256: sha('exe'), taille: 1000 };
  const base = manifesteApp();
  const avecExe = { ...base, fichiers: [...base.fichiers, exe] };
  assert.ok(validerManifeste({ ...avecExe, lanceur: { numero: 2, sha256: exe.sha256, taille: 1000 } }));
  assert.throws(() => validerManifeste({ ...avecExe, lanceur: { numero: 2, sha256: sha('autre'), taille: 1000 } }), invalide);
  assert.throws(() => validerManifeste({ ...base, lanceur: { numero: 2, sha256: exe.sha256, taille: 1000 } }), invalide);
  assert.throws(() => validerManifeste({ ...avecExe, lanceur: { numero: 2, sha256: exe.sha256, taille: 1000, url: 'x' } }), invalide);
});

test('compatibilité : lanceur et node minimum', () => {
  const m = manifesteApp({ lanceur_min: 2, node_min: '22.12.0' });
  assert.deepEqual(problemesCompatibilite(m, { lanceur: 2, node: 'v22.23.1' }), []);
  assert.equal(problemesCompatibilite(m, { lanceur: 1, node: 'v22.23.1' }).length, 1);
  assert.equal(problemesCompatibilite(m, { lanceur: 2, node: '22.11.9' }).length, 1);
  assert.equal(problemesCompatibilite(m, { lanceur: 2, node: '' }).length, 1);
  assert.equal(problemesCompatibilite(m, { lanceur: undefined, node: '22.12.0' }).length, 1);
});
