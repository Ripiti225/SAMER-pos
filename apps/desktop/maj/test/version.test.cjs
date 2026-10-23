'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { lireVersion, contenuVersion, formaterVersion, deciderMontee, versionTexteValide, validerVersion } = require('../index.cjs');
const { dossierTemp } = require('./aide.cjs');

test('VERSION.json absent : repli « dev », numéro 0', (t) => {
  const d = dossierTemp(t);
  assert.deepEqual(lireVersion(d), { numero: 0, version: 'dev', commit: null, dev: true });
});

test('VERSION.json illisible ou invalide : repli « dev » signalé', (t) => {
  const d = dossierTemp(t);
  fs.writeFileSync(path.join(d, 'VERSION.json'), '{ cassé');
  assert.equal(lireVersion(d).dev, true);
  assert.equal(lireVersion(d).illisible, true);
  fs.writeFileSync(path.join(d, 'VERSION.json'), JSON.stringify({ numero: -1, version: 'x', commit: 'abc1234' }));
  assert.equal(lireVersion(d).illisible, true);
});

test('VERSION.json valide (BOM toléré)', (t) => {
  const d = dossierTemp(t);
  const v = contenuVersion({ numero: 7, version: '2026.10.23-2', commit: 'abcdef1', publie_le: '2026-10-23T05:00:00Z' });
  fs.writeFileSync(path.join(d, 'VERSION.json'), `﻿${JSON.stringify(v)}`);
  assert.deepEqual(lireVersion(d), { ...v, dev: false });
});

test('format AAAA.MM.JJ-n', () => {
  assert.equal(formaterVersion(new Date('2026-10-03T23:59:00Z'), 1), '2026.10.03-1');
  assert.equal(formaterVersion(new Date('2026-01-09T00:00:00Z'), 12), '2026.01.09-12');
  assert.throws(() => formaterVersion(new Date(), 0), { code: 'VERSION_INVALIDE' });
  assert.equal(versionTexteValide('2026.10.23-1'), true);
  assert.equal(versionTexteValide('2026.02.30-1'), false);
  assert.equal(versionTexteValide('2026.10.23-0'), false);
  assert.equal(versionTexteValide('2026.10.23-01'), false);
  assert.throws(() => validerVersion({ numero: 1, version: '2026.10.23-1', commit: 'abc1234', autre: 1 }), { code: 'VERSION_INVALIDE' });
});

test('comparaison par numéro entier : jamais de retour à un numéro inférieur', () => {
  assert.equal(deciderMontee({ numero: 41 }, { numero: 42 }), 'INSTALLER');
  assert.equal(deciderMontee({ numero: 42 }, { numero: 42 }), 'DEJA_INSTALLEE');
  assert.equal(deciderMontee({ numero: 42 }, { numero: 41 }), 'REFUSEE_INFERIEURE');
  // la chaîne de version ne compte pas : seul le numéro fait foi
  assert.equal(deciderMontee({ numero: 9, version: '2026.12.31-9' }, { numero: 10, version: '2026.01.01-1' }), 'INSTALLER');
  // poste de dev (numéro 0) : accepte la première version signée
  assert.equal(deciderMontee({ numero: 0 }, { numero: 1 }), 'INSTALLER');
  assert.throws(() => deciderMontee({ numero: 1 }, { numero: 0 }), { code: 'VERSION_INVALIDE' });
  assert.throws(() => deciderMontee({ numero: 1 }, {}), { code: 'VERSION_INVALIDE' });
});
