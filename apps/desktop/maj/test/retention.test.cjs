'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { choisirSauvegardesASupprimer, nomSauvegarde, lireNomSauvegarde } = require('../retention.cjs');

const MAINTENANT = new Date('2026-10-24T06:00:00Z');
const ilYa = (jours, heures = 0) => new Date(MAINTENANT.getTime() - (jours * 24 + heures) * 3600 * 1000);
const s = (nom, le) => ({ nom, le });

test('nom de sauvegarde : aller-retour', () => {
  const nom = nomSauvegarde(42, new Date('2026-10-24T06:01:02Z'));
  assert.equal(nom, 'pgdata-42-20261024-060102');
  assert.deepEqual(lireNomSauvegarde(nom), { nom, numero: 42, le: new Date('2026-10-24T06:01:02Z') });
  assert.equal(lireNomSauvegarde('pgdata'), null);
  assert.equal(lireNomSauvegarde('autre-dossier'), null);
});

test('garde tout ce qui a moins de 7 jours', () => {
  const liste = [s('a', ilYa(0)), s('b', ilYa(3)), s('c', ilYa(6, 23)), s('d', ilYa(7))];
  assert.deepEqual(choisirSauvegardesASupprimer(liste, MAINTENANT), []);
});

test('supprime au-delà de 7 jours, en gardant les 2 dernières', () => {
  const liste = [s('a', ilYa(1)), s('b', ilYa(2)), s('c', ilYa(8)), s('d', ilYa(30))];
  assert.deepEqual(choisirSauvegardesASupprimer(liste, MAINTENANT).sort(), ['c', 'd']);
});

test('toujours au moins les 2 dernières, même très anciennes', () => {
  const liste = [s('vieille', ilYa(40)), s('tres-vieille', ilYa(90)), s('antique', ilYa(200))];
  assert.deepEqual(choisirSauvegardesASupprimer(liste, MAINTENANT), ['antique']);
  assert.deepEqual(choisirSauvegardesASupprimer(liste.slice(0, 2), MAINTENANT), []);
  assert.deepEqual(choisirSauvegardesASupprimer([], MAINTENANT), []);
});

test('ordre de la liste sans importance', () => {
  const liste = [s('d', ilYa(30)), s('a', ilYa(10)), s('c', ilYa(20)), s('b', ilYa(9))];
  assert.deepEqual(choisirSauvegardesASupprimer(liste, MAINTENANT).sort(), ['c', 'd']);
});

test('dans le doute on garde : date future, date illisible, sauvegarde protégée', () => {
  const liste = [
    s('futur', new Date('2027-01-01T00:00:00Z')),
    s('recente', ilYa(1)),
    s('illisible', new Date('x')),
    s('protegee', ilYa(20)),
    s('vieille', ilYa(21)),
  ];
  assert.deepEqual(choisirSauvegardesASupprimer(liste, MAINTENANT, { proteger: ['protegee'] }), ['vieille']);
});
