import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ecrirePresences, type ApiPresences } from './samtrackly-presences.ts';

test('un rejeu met à jour une présence sans caissier au lieu de créer un doublon', async () => {
  const lignes = [{
    point_id: 'point-1',
    restaurant_id: 'resto-1',
    caissier_id: null,
    travailleur_id: 'travailleur-1',
    travailleur_nom: 'Flora',
    statut: 'Présent',
    paye: 6_000,
    shift_nom: 'Caisse',
    heure_debut: '08:00',
    heure_fin: '16:00',
    date: '2026-09-19',
  }];
  const presentes = [{ id: 'presence-1', ...lignes[0], paye: 0 }];

  const api: ApiPresences = {
    async lire() {
      return presentes.map(({ id }) => ({ id }));
    },
    async inserer(_table, nouvelles) {
      presentes.push(...nouvelles.map((ligne, i) => ({ id: `nouvelle-${i}`, ...ligne })) as typeof presentes);
      return [];
    },
    async upsert() {
      throw new Error('duplicate key value violates unique constraint "presences_legacy_unique"');
    },
    async patch(_table, id, champs) {
      const index = presentes.findIndex((presence) => presence.id === id);
      presentes[index] = { ...presentes[index], ...champs };
    },
  };

  await ecrirePresences(lignes, api);

  assert.equal(presentes.length, 1);
  assert.equal(presentes[0].paye, 6_000);
});
