/**
 * Intitulé RH libre et poste du jour (2026-10-27). La pointeuse inscrivait
 * l'intitulé SamerTrackly (« Sous-gérant », « Caissier/re ») comme poste du
 * jour ; la caisse le renvoyait tel quel à l'ouverture suivante, et l'enum
 * POSTES_JOUR refusait TOUTE l'ouverture : la caissière ne pouvait plus
 * commencer son shift.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { POSTES_JOUR, versPosteJour } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { equipeService, parametresLocaux, utilisateurs } from '../src/db/schema/index.js';
import { appliquerEvenement } from '../src/modules/pointeuse/presence.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, validerInventaire, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let numero = 5000;

const pointer = (employe_no: string, minutes: number) =>
  db.transaction((tx) => appliquerEvenement(tx, 'TEST-POSTE-RH', {
    numero: numero++, employe_no, nom: null, sens: 'ENTREE', pointe_le: new Date(Date.now() - minutes * 60_000),
  }));
const membre = async (serviceId: string, utilisateurId: string) =>
  (await db.select().from(equipeService)
    .where(and(eq(equipeService.service_id, serviceId), eq(equipeService.utilisateur_id, utilisateurId))))[0];

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  await db.insert(parametresLocaux).values({ cle: 'pointeuse_url', valeur: 'http://192.0.2.10' });
  await db.update(utilisateurs).set({ pointeuse_no: '1', poste: 'Sous-gérant', poste_cuisine: null })
    .where(eq(utilisateurs.id, donnees.serveur_id));
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

it('ramène un intitulé RH à un poste du jour connu', () => {
  expect(versPosteJour('Sous-gérant')).toBe('MANAGER');
  expect(versPosteJour('Gérante caisse')).toBe('MANAGER');
  expect(versPosteJour('Caissier/re')).toBe('CAISSIER');
  expect(versPosteJour('Serveur/se')).toBe('SERVEUR');
  expect(versPosteJour('Comptoiriste')).toBe('COMPTOIRISTE');
  expect(versPosteJour('Plongeuse')).toBe('PLONGE');
  expect(versPosteJour('Aide cuisinier')).toBe('CUISINIER');
  expect(versPosteJour('Pizzaïolo')).toBe('PIZZAIOLO');
  expect(versPosteJour('Grilladin')).toBe('GRILLADE');
  expect(versPosteJour('Barman')).toBe('BARMAN');
  expect(versPosteJour('PIZZAIOLO')).toBe('PIZZAIOLO');
  expect(versPosteJour('Astronaute')).toBeNull();
  expect(versPosteJour(null)).toBeNull();
});

it('un « Sous-gérant » pointé ne bloque pas l’ouverture du shift', async () => {
  expect(await pointer('1', 20)).toBe('EN_ATTENTE');

  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const apercu = await app.inject({ method: 'GET', url: '/api/services/equipe-pointeuse', cookies: caissier });
  const proposes = apercu.json().membres as { utilisateur_id: string; poste_defaut: string }[];
  expect(proposes).toHaveLength(1);
  expect(POSTES_JOUR).toContain(proposes[0]!.poste_defaut);

  // Ce que la caisse renvoie : le poste proposé, tel quel.
  const ouverture = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: caissier,
    payload: { fond_de_caisse: 0, equipe: proposes.map((m) => ({ utilisateur_id: m.utilisateur_id, poste_jour: m.poste_defaut })) },
  });
  expect(ouverture.statusCode).toBe(200);
  expect((await membre(ouverture.json().id, donnees.serveur_id))?.poste_jour).toBe('MANAGER');
});

it('une relève déjà inscrite avec l’intitulé RH ne bloque pas le shift suivant', async () => {
  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const [ouvert] = await db.select().from(equipeService).where(eq(equipeService.utilisateur_id, donnees.serveur_id));
  // Ligne écrite par l'ancienne pointeuse, marquée « Reste » à la clôture.
  await db.update(equipeService).set({ poste_jour: 'Sous-gérant', reste: true }).where(eq(equipeService.id, ouvert!.id));

  await validerInventaire(app, caissier);
  const fin = await app.inject({ method: 'POST', url: '/api/services/cloturer', cookies: caissier, payload: { especes_comptees: 0 } });
  expect(fin.statusCode).toBe(200);

  for (const url of ['/api/services/equipe-pointeuse', '/api/services/equipe-proposee']) {
    const rep = await app.inject({ method: 'GET', url, cookies: caissier });
    const liste = (url.endsWith('pointeuse') ? rep.json().membres : rep.json()) as { utilisateur_id: string; poste_defaut: string }[];
    expect(liste.find((m) => m.utilisateur_id === donnees.serveur_id)?.poste_defaut).toBe('MANAGER');
  }

  const ouverture = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: caissier,
    payload: { fond_de_caisse: 0, equipe: [{ utilisateur_id: donnees.serveur_id, poste_jour: 'MANAGER' }] },
  });
  expect(ouverture.statusCode).toBe(200);
  expect((await membre(ouverture.json().id, donnees.serveur_id))?.poste_jour).toBe('MANAGER');
});
