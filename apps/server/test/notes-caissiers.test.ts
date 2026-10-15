/**
 * Note des caissiers sur la caisse (2026-10-15) : calculée par SamerTrackly,
 * descendue par le flux NOTES, lue par chacun pour lui-même et par la
 * Supervision pour l'équipe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { NoteCaissierVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { tirerCatalogue } from '../src/modules/sync/descente.js';
import type { ClientCloud, ReponsePull } from '../src/modules/sync/cloud-client.js';
import { PIN_CAISSIER, PIN_CAISSIER2, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;

/** Ligne telle que le cloud l'envoie : avec restaurant_id/version et critères en TABLEAU. */
const ligneCloud = (id: string, note: number | null) => ({
  table_name: 'notes_caissiers',
  row: {
    id,
    restaurant_id: '00000000-0000-0000-0000-0000000000aa',
    version: 42,
    note,
    note_precedente: 14,
    appreciation: note === null ? 'Pas encore noté' : 'Très bien',
    nb_shifts: note === null ? 3 : 12,
    min_shifts: 8,
    criteres: [
      { cle: 'caisse', points: 6, max: 7, applicable: true, resume: '11 shifts justes sur 12', conseil: 'Recomptez la caisse.' },
      { cle: 'contacts', points: 0, max: 4, applicable: false, resume: 'Pas de livraison', conseil: null },
    ],
    bonus: { cle: 'bonus', points: 0.5, max: 1, applicable: true, resume: '+6 %', conseil: null },
    periode_debut: '2026-09-16',
    periode_fin: '2026-10-15',
    calcule_le: '2026-10-15T10:07:00.000Z',
  },
});

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  const reponse: ReponsePull = {
    notes: { lignes: [ligneCloud(donnees.caissier_id, 15.5), ligneCloud(donnees.caissier2_id, null)], version: 42 },
  };
  const client = { pull: async () => reponse } as unknown as ClientCloud;
  expect(await tirerCatalogue(client)).toBe(2);
});
afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('note du caissier', () => {
  it('descend du cloud (critères en tableau compris) et le caissier lit la sienne', async () => {
    const cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    const r = await app.inject({ method: 'GET', url: '/api/moi/note', cookies });
    expect(r.statusCode).toBe(200);
    const note = r.json().note as NoteCaissierVue;
    expect(note.note).toBe(15.5);
    expect(note.note_precedente).toBe(14);
    expect(note.criteres).toHaveLength(2);
    expect(note.criteres[0]!.conseil).toBe('Recomptez la caisse.');
    expect(note.bonus?.points).toBe(0.5);
    expect(note.periode_fin).toBe('2026-10-15');
  });

  it('pas encore assez de shifts : la note est vide mais la fiche existe', async () => {
    const cookies = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);
    const note = (await app.inject({ method: 'GET', url: '/api/moi/note', cookies })).json().note as NoteCaissierVue;
    expect(note.note).toBeNull();
    expect(note.nb_shifts).toBe(3);
  });

  it('sans note descendue : réponse vide, pas d’erreur', async () => {
    const cookies = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    const r = await app.inject({ method: 'GET', url: '/api/moi/note', cookies });
    expect(r.statusCode).toBe(200);
    expect(r.json().note).toBeNull();
  });

  it('les notes de l’équipe : la Supervision oui, un caissier non', async () => {
    const gerant = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    const equipe = (await app.inject({ method: 'GET', url: '/api/equipe/notes', cookies: gerant })).json() as NoteCaissierVue[];
    expect(equipe.map((n) => n.note)).toEqual([15.5, null]);
    expect(equipe[0]!.nom).toBeTruthy();

    const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    const refus = await app.inject({ method: 'GET', url: '/api/equipe/notes', cookies: caissier });
    expect(refus.statusCode).toBe(403);
  });

  it('une nouvelle descente met la note à jour', async () => {
    const maj = ligneCloud(donnees.caissier_id, 17);
    await tirerCatalogue({ pull: async () => ({ notes: { lignes: [maj], version: 43 } }) } as unknown as ClientCloud);
    const cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    expect((await app.inject({ method: 'GET', url: '/api/moi/note', cookies })).json().note.note).toBe(17);
  });
});
