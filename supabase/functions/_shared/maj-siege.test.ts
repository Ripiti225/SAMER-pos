import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  ErreurPaquet,
  lireManifestePublie,
  lireModificationReglages,
  nomFichierValide,
  numeroCorrespond,
  piloteRestantMs,
  problemesObjets,
  transitionPermise,
  versionsAPurger,
  DUREE_PILOTE_MS,
} from './maj-siege.ts';

// Les manifestes sont produits par `serialiserManifeste` du lot L0 : ce que le
// poste de publication envoie réellement.
const require = createRequire(import.meta.url);
const l0 = require('../../../apps/desktop/maj/index.cjs');

const sha = (c: string) => c.repeat(64);
function manifesteApp(extra: Record<string, unknown> = {}) {
  return {
    format: 1,
    type: 'APP',
    numero: 2026102401,
    version: '2026.10.24-1',
    commit: 'abcdef1',
    publie_le: '2026-10-24T10:00:00.000Z',
    node_min: '22.0.0',
    lanceur_min: 1,
    dependances: { empreinte: sha('d') },
    migrations: { derniere: '0043_stock_plats_reference', nouvelles: [], retrocompatibles: true },
    notes: 'Correctifs',
    archive: { sha256: sha('a'), taille: 30 },
    morceaux: [
      { nom: 'paquet.tar.gz.000', sha256: sha('b'), taille: 20 },
      { nom: 'paquet.tar.gz.001', sha256: sha('c'), taille: 10 },
    ],
    fichiers: [{ chemin: 'VERSION.json', sha256: sha('e'), taille: 5 }],
    ...extra,
  };
}
const octetsDe = (m: unknown) => new Uint8Array(l0.serialiserManifeste(m));

describe('manifeste reçu à l’enregistrement', () => {
  test('APP du lot L0 : lu, morceaux et dépendances retenus', () => {
    const m = lireManifestePublie(octetsDe(manifesteApp()), { type: 'APP', numero: 2026102401 });
    assert.equal(m.version, '2026.10.24-1');
    assert.equal(m.dependances_empreinte, sha('d'));
    assert.equal(m.taille_octets, 30);
    assert.deepEqual(m.morceaux.map((x) => x.nom), ['paquet.tar.gz.000', 'paquet.tar.gz.001']);
    assert.equal(m.notes, 'Correctifs');
  });

  test('DEPENDANCES : l’empreinte doit être celle annoncée', () => {
    const { numero, version, commit, lanceur_min, dependances, migrations, ...commun } = manifesteApp();
    void numero; void version; void commit; void lanceur_min; void dependances; void migrations;
    const deps = { ...commun, type: 'DEPENDANCES', empreinte: sha('d') };
    assert.equal(lireManifestePublie(octetsDe(deps), { type: 'DEPENDANCES', empreinte: sha('d') }).empreinte, sha('d'));
    assert.throws(() => lireManifestePublie(octetsDe(deps), { type: 'DEPENDANCES', empreinte: sha('f') }), ErreurPaquet);
  });

  test('incohérences refusées', () => {
    const octets = octetsDe(manifesteApp());
    assert.throws(() => lireManifestePublie(octets, { type: 'APP', numero: 2026102402 }), /numéro/);
    assert.throws(() => lireManifestePublie(octets, { type: 'DEPENDANCES', empreinte: sha('d') }), /type/);
    assert.throws(() => lireManifestePublie(new TextEncoder().encode('{'), { type: 'APP', numero: 1 }), /JSON/);
    // Un manifeste écrit à la main, hors L0 : morceaux qui ne font pas l'archive.
    const faux = { ...manifesteApp(), archive: { sha256: sha('a'), taille: 31 } };
    assert.throws(() => lireManifestePublie(new TextEncoder().encode(JSON.stringify(faux)), { type: 'APP', numero: 2026102401 }), /somme/);
    const chemin = { ...manifesteApp(), morceaux: [{ nom: '../x', sha256: sha('b'), taille: 30 }] };
    assert.throws(() => lireManifestePublie(new TextEncoder().encode(JSON.stringify(chemin)), { type: 'APP', numero: 2026102401 }), /nom de morceau/);
  });

  test('objets du bucket comparés aux morceaux', () => {
    const m = lireManifestePublie(octetsDe(manifesteApp()), { type: 'APP', numero: 2026102401 });
    assert.deepEqual(problemesObjets(m.morceaux, [{ name: 'paquet.tar.gz.000', taille: 20 }, { name: 'paquet.tar.gz.001', taille: 10 }]), []);
    const p = problemesObjets(m.morceaux, [{ name: 'paquet.tar.gz.000', taille: 19 }]);
    assert.equal(p.length, 2);
    assert.match(p[0], /19 octets/);
    assert.match(p[1], /absent/);
  });

  test('noms de fichiers acceptés dans le bucket', () => {
    assert.equal(nomFichierValide('manifeste.json'), true);
    assert.equal(nomFichierValide('manifeste.json.sig'), true);
    assert.equal(nomFichierValide('deps.tar.gz.012'), true);
    assert.equal(nomFichierValide('../manifeste.json'), false);
    assert.equal(nomFichierValide('a/b'), false);
    assert.equal(nomFichierValide(''), false);
  });

  test('numéro AAAAMMJJnn cohérent avec la version', () => {
    assert.equal(numeroCorrespond(2026102401, '2026.10.24-1'), true);
    assert.equal(numeroCorrespond(2026102412, '2026.10.24-12'), true);
    assert.equal(numeroCorrespond(2026102401, '2026.10.24-2'), false);
    assert.equal(numeroCorrespond(2026102401, '2026.10.24-100'), false);
  });
});

describe('cycle de vie', () => {
  test('BROUILLON → PILOTE → GENERALE, rien d’autre', () => {
    assert.equal(transitionPermise('BROUILLON', 'PILOTE'), true);
    assert.equal(transitionPermise('PILOTE', 'GENERALE'), true);
    assert.equal(transitionPermise('BROUILLON', 'GENERALE'), false);
    assert.equal(transitionPermise('GENERALE', 'PILOTE'), false);
    assert.equal(transitionPermise('RETIREE', 'PILOTE'), false);
  });

  test('48 h de pilote', () => {
    const t0 = new Date('2026-10-24T10:00:00Z');
    assert.equal(piloteRestantMs('2026-10-24T10:00:00Z', t0), DUREE_PILOTE_MS);
    assert.equal(piloteRestantMs('2026-10-24T10:00:00Z', new Date('2026-10-25T10:00:00Z')), 24 * 3_600_000);
    assert.equal(piloteRestantMs('2026-10-24T10:00:00Z', new Date('2026-10-27T10:00:00Z')), 0);
  });
});

describe('réglages par site', () => {
  test('modifications valides', () => {
    assert.deepEqual(
      lireModificationReglages({ type_site: 'FERME_LA_NUIT', heure_filet: '05:00', anneau: 'PILOTE', pause: true, version_epinglee: null }),
      { type_site: 'FERME_LA_NUIT', heure_filet: '05:00', anneau: 'PILOTE', pause: true, version_epinglee: null },
    );
    assert.deepEqual(lireModificationReglages(undefined), {});
  });

  test('un réglage abîmé ou inconnu est refusé, pas ignoré', () => {
    assert.ok('erreur' in lireModificationReglages({ heure_installation: '6h' }));
    assert.ok('erreur' in lireModificationReglages({ type_site: 'NUIT' }));
    assert.ok('erreur' in lireModificationReglages({ pause: 'oui' }));
    assert.ok('erreur' in lireModificationReglages({ version_epinglee: -1 }));
    assert.ok('erreur' in lireModificationReglages({ installer_maintenant: 'x' }));
    assert.ok('erreur' in lireModificationReglages([1]));
  });
});

describe('rétention du bucket', () => {
  test('garde les 3 plus récentes, les cibles et les épinglées', () => {
    const vs = [1, 2, 3, 4, 5, 6].map((numero) => ({ numero }));
    assert.deepEqual(versionsAPurger(vs, []), [3, 2, 1]);
    assert.deepEqual(versionsAPurger(vs, [2]), [3, 1]);
  });

  test('déjà purgée : ignorée', () => {
    const vs = [{ numero: 1, fichiers_purges_le: '2026-10-01T00:00:00Z' }, { numero: 2 }, { numero: 3 }, { numero: 4 }, { numero: 5 }];
    assert.deepEqual(versionsAPurger(vs, []), [2]);
  });
});
