import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chargerToutesLesPages,
  chargerServicesEnAttente,
  servicesAvecExplicationARejouer,
} from './samtrackly-selection.ts';

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

test('rejoue une seule fois une explication ajoutée après le premier transfert', () => {
  const transferts = [
    { service_id: 'sans-changement', explication_ecart_transferee: null },
    { service_id: 'explication-tardive', explication_ecart_transferee: null },
    { service_id: 'deja-a-jour', explication_ecart_transferee: 'Erreur de monnaie' },
  ];
  const services = [
    { id: 'sans-changement', explication_ecart: null },
    { id: 'explication-tardive', explication_ecart: '  Billet remis en trop  ' },
    { id: 'deja-a-jour', explication_ecart: 'Erreur de monnaie' },
  ];

  assert.deepEqual(
    servicesAvecExplicationARejouer(transferts, services),
    ['explication-tardive'],
  );
});

test('rattrape les anciens marqueurs vides et les modifications, sans dupliquer les caissiers', () => {
  const transferts = [
    { service_id: 'ancien-flora' },
    { service_id: 'modifie-hilary', explication_ecart_transferee: 'Ancien texte' },
    { service_id: 'inchangé', explication_ecart_transferee: 'Déjà envoyé' },
  ];
  const services = [
    { id: 'ancien-flora', explication_ecart: 'Fond de caisse incomplet' },
    { id: 'modifie-hilary', explication_ecart: 'Nouveau texte' },
    { id: 'inchangé', explication_ecart: ' Déjà envoyé ' },
    { id: 'jamais-transfere', explication_ecart: 'Nouveau shift' },
  ];

  assert.deepEqual(
    servicesAvecExplicationARejouer(transferts, services),
    ['ancien-flora', 'modifie-hilary'],
  );
});
