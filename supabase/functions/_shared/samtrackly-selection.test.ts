import assert from 'node:assert/strict';
import test from 'node:test';

import { chargerToutesLesPages, chargerServicesEnAttente } from './samtrackly-selection.ts';

type Service = {
  id: string;
  restaurant_id: string;
  ouvert_le: string;
  cloture_le: string;
};

const config = new Map([
  ['resto-7e', { actif: true, transferer_depuis: '2026-08-17' }],
]);

function service(id: string, jour = '2026-08-28'): Service {
  return {
    id,
    restaurant_id: 'resto-7e',
    ouvert_le: `${jour}T16:00:00.000Z`,
    cloture_le: `${jour}T23:59:00.000Z`,
  };
}

test('cherche après les 100 anciens services déjà transférés', async () => {
  const anciens = Array.from({ length: 100 }, (_, i) => service(`ancien-${i}`));
  const venteDeCetteNuit = service('vente-cette-nuit', '2026-08-29');
  const tous = [...anciens, venteDeCetteNuit];
  const faits = new Set(anciens.map((s) => s.id));
  const pagesLues: number[] = [];

  const resultat = await chargerServicesEnAttente(
    async (debut, fin) => {
      pagesLues.push(debut);
      return tous.slice(debut, fin + 1);
    },
    faits,
    config,
    25,
    100,
  );

  assert.deepEqual(resultat.map((s) => s.id), ['vente-cette-nuit']);
  assert.deepEqual(pagesLues, [0, 100]);
});

test('s’arrête dès que le lot de 25 services en attente est rempli', async () => {
  const tous = Array.from({ length: 150 }, (_, i) => service(`service-${i}`));
  let lectures = 0;

  const resultat = await chargerServicesEnAttente(
    async (debut, fin) => {
      lectures++;
      return tous.slice(debut, fin + 1);
    },
    new Set(),
    config,
    25,
    100,
  );

  assert.equal(resultat.length, 25);
  assert.equal(lectures, 1);
});

test('ne sélectionne pas deux fois un service répété à une frontière de page', async () => {
  const anciens = Array.from({ length: 99 }, (_, i) => service(`ancien-${i}`));
  const frontiere = service('meme-cloture');
  const suivant = service('suivant');
  const faits = new Set(anciens.map((s) => s.id));

  const resultat = await chargerServicesEnAttente(
    async (debut) => debut === 0
      ? [...anciens, frontiere]
      : [frontiere, suivant],
    faits,
    config,
    25,
    100,
  );

  assert.deepEqual(resultat.map((s) => s.id), ['meme-cloture', 'suivant']);
});

test('charge tous les transferts réussis au-delà de la limite API de 1000 lignes', async () => {
  const transferts = Array.from({ length: 1001 }, (_, i) => ({ service_id: `fait-${i}` }));
  const pagesLues: number[] = [];

  const resultat = await chargerToutesLesPages(async (debut, fin) => {
    pagesLues.push(debut);
    return transferts.slice(debut, fin + 1);
  });

  assert.equal(resultat.length, 1001);
  assert.equal(resultat[1000]?.service_id, 'fait-1000');
  assert.deepEqual(pagesLues, [0, 1000]);
});
