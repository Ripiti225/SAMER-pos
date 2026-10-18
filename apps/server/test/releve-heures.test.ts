import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { equipeService, servicesCaisse } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_CAISSIER2, resetDonnees, seConnecter, validerInventaire, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

it('additionne les heures de la personne restée sans compter la pause entre shifts', async () => {
  const premier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const ouverture1 = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: premier,
    payload: { fond_de_caisse: 0, equipe: [
      { utilisateur_id: donnees.serveur_id, poste_jour: 'SERVEUR' },
      { utilisateur_id: donnees.cuisine_id, poste_jour: 'CUISINIER' },
    ] },
  });
  expect(ouverture1.statusCode).toBe(200);
  const service1 = ouverture1.json().id as string;
  for (const [id, reste] of [[donnees.serveur_id, true], [donnees.cuisine_id, false]] as const) {
    const rep = await app.inject({
      method: 'PATCH', url: `/api/pointage/${id}/depart`, cookies: premier, payload: { reste },
    });
    expect(rep.statusCode).toBe(200);
  }
  await validerInventaire(app, premier);
  const fermeture = await app.inject({
    method: 'POST', url: '/api/services/cloturer', cookies: premier,
    payload: { especes_comptees: 0 },
  });
  expect(fermeture.statusCode).toBe(200);

  // Quatre heures travaillées, puis trente minutes entre les deux shifts.
  const maintenant = Date.now();
  const debut1 = new Date(maintenant - 4.5 * 3600_000);
  const fin1 = new Date(maintenant - 0.5 * 3600_000);
  await db.update(equipeService).set({ pointe_le: debut1 }).where(eq(equipeService.service_id, service1));
  await db.update(servicesCaisse).set({ ouvert_le: debut1, cloture_le: fin1 }).where(eq(servicesCaisse.id, service1));

  const suivant = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);
  const ouverture2 = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: suivant,
    payload: { fond_de_caisse: 0, equipe: [{ utilisateur_id: donnees.serveur_id, poste_jour: 'SERVEUR' }] },
  });
  expect(ouverture2.statusCode).toBe(200);
  const service2 = ouverture2.json().id as string;

  const pointage = await app.inject({ method: 'GET', url: '/api/pointage', cookies: suivant });
  expect(pointage.statusCode).toBe(200);
  const serveur = (pointage.json().membres as Array<{
    utilisateur_id: string; minutes_faites: number; minutes_reportees: number;
    minutes_cumulees: number; heures_faites: boolean; fin_prevue: string;
  }>).find((m) => m.utilisateur_id === donnees.serveur_id)!;
  expect(serveur.minutes_faites).toBeLessThan(2);
  expect(serveur.minutes_reportees).toBeGreaterThanOrEqual(239);
  expect(serveur.minutes_reportees).toBeLessThanOrEqual(240);
  expect(serveur.minutes_cumulees).toBeGreaterThanOrEqual(239);
  expect(serveur.minutes_cumulees).toBeLessThanOrEqual(240);
  expect(serveur.heures_faites).toBe(false);
  expect(new Date(serveur.fin_prevue).getTime() - Date.now()).toBeGreaterThan(3.9 * 3600_000);

  // Un salarié marqué « Parti » puis absent à l'ouverture ne reprend rien,
  // même s'il est pointé plus tard dans le deuxième shift.
  const retour = await app.inject({
    method: 'POST', url: '/api/pointage', cookies: suivant,
    payload: { utilisateur_id: donnees.cuisine_id, poste_jour: 'CUISINIER' },
  });
  expect(retour.statusCode).toBe(200);
  const [cuisinier] = await db.select().from(equipeService).where(and(
    eq(equipeService.service_id, service2), eq(equipeService.utilisateur_id, donnees.cuisine_id),
  ));
  expect(cuisinier!.secondes_reportees).toBe(0);

  // Après quatre heures supplémentaires, le seuil des huit heures est atteint.
  await db.update(equipeService).set({ pointe_le: new Date(Date.now() - 4 * 3600_000) }).where(and(
    eq(equipeService.service_id, service2), eq(equipeService.utilisateur_id, donnees.serveur_id),
  ));
  const suite = await app.inject({ method: 'GET', url: '/api/pointage', cookies: suivant });
  const cumul = (suite.json().membres as Array<{
    utilisateur_id: string; minutes_faites: number; minutes_cumulees: number; heures_faites: boolean;
  }>).find((m) => m.utilisateur_id === donnees.serveur_id)!;
  expect(cumul.minutes_faites).toBeGreaterThanOrEqual(239);
  expect(cumul.minutes_cumulees).toBeGreaterThanOrEqual(479);
  expect(cumul.heures_faites).toBe(true);

  // Le cumul traverse aussi une deuxième relève sans reprendre la pause initiale.
  const resteEncore = await app.inject({
    method: 'PATCH', url: `/api/pointage/${donnees.serveur_id}/depart`, cookies: suivant,
    payload: { reste: true },
  });
  expect(resteEncore.statusCode).toBe(200);
  await validerInventaire(app, suivant);
  const fermeture2 = await app.inject({
    method: 'POST', url: '/api/services/cloturer', cookies: suivant,
    payload: { especes_comptees: 0 },
  });
  expect(fermeture2.statusCode).toBe(200);

  const ouverture3 = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: premier,
    payload: { fond_de_caisse: 0, equipe: [{ utilisateur_id: donnees.serveur_id, poste_jour: 'SERVEUR' }] },
  });
  expect(ouverture3.statusCode).toBe(200);
  const troisieme = await app.inject({ method: 'GET', url: '/api/pointage', cookies: premier });
  const membre3 = (troisieme.json().membres as Array<{
    utilisateur_id: string; minutes_faites: number; minutes_reportees: number;
    minutes_cumulees: number; heures_faites: boolean;
  }>).find((m) => m.utilisateur_id === donnees.serveur_id)!;
  expect(membre3.minutes_faites).toBeLessThan(2);
  expect(membre3.minutes_reportees).toBeGreaterThanOrEqual(479);
  expect(membre3.minutes_cumulees).toBeGreaterThanOrEqual(479);
  expect(membre3.heures_faites).toBe(true);
});
