/**
 * Pointeuse Hikvision (2026-10-26) : de l'événement lu sur l'appareil jusqu'à
 * l'équipe du shift. Le réseau n'est pas en jeu ici — on appelle directement
 * la logique qu'emprunte la boucle de lecture.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { equipeService, parametresLocaux, pointeuseEvenements, servicesCaisse, utilisateurs } from '../src/db/schema/index.js';
import { sensDuStatut } from '../src/modules/pointeuse/isapi.js';
import { appliquerEvenement } from '../src/modules/pointeuse/presence.js';
import { PIN_CAISSIER, PIN_MANAGER, PIN_PROPRIO, resetDonnees, seConnecter, validerInventaire, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let numero = 1000;

const APPAREIL = 'TEST-DS-K1T320';
const ilYA = (min: number) => new Date(Date.now() - min * 60_000);
const pointer = (employe_no: string, sens: 'ENTREE' | 'SORTIE' | null, quand: Date) =>
  db.transaction((tx) => appliquerEvenement(tx, APPAREIL, { numero: numero++, employe_no, nom: null, sens, pointe_le: quand }));
const membre = async (serviceId: string, utilisateurId: string) =>
  (await db.select().from(equipeService)
    .where(and(eq(equipeService.service_id, serviceId), eq(equipeService.utilisateur_id, utilisateurId))))[0];

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  await db.insert(parametresLocaux).values({ cle: 'pointeuse_url', valeur: 'http://192.0.2.10' });
  await db.update(utilisateurs).set({ pointeuse_no: '1' }).where(eq(utilisateurs.id, donnees.serveur_id));
  await db.update(utilisateurs).set({ pointeuse_no: '2' }).where(eq(utilisateurs.id, donnees.cuisine_id));
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

it('traduit les touches Entrée / Sortie de la pointeuse', () => {
  expect(sensDuStatut('checkIn')).toBe('ENTREE');
  expect(sensDuStatut('breakIn')).toBe('ENTREE');
  expect(sensDuStatut('checkOut')).toBe('SORTIE');
  expect(sensDuStatut('undefined')).toBeNull();
});

it('reporte arrivées, sorties et absences sur l’équipe du shift', async () => {
  // Avant l'ouverture : l'entrée attend, le numéro inconnu est signalé.
  expect(await pointer('1', 'ENTREE', ilYA(20))).toBe('EN_ATTENTE');
  expect(await pointer('99', 'ENTREE', ilYA(19))).toBe('INCONNU');
  // Relire le même événement ne double rien.
  numero--;
  expect(await pointer('99', 'ENTREE', ilYA(19))).toBeNull();
  numero++;

  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const apercu = await app.inject({ method: 'GET', url: '/api/services/equipe-pointeuse', cookies: caissier });
  expect(apercu.json().active).toBe(true);
  expect(apercu.json().membres.map((m: { utilisateur_id: string }) => m.utilisateur_id)).toEqual([donnees.serveur_id]);

  // La caisse envoie quelqu'un qui n'a pas pointé : ignoré, la pointeuse fait foi.
  const ouverture = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: caissier,
    payload: { fond_de_caisse: 0, equipe: [{ utilisateur_id: donnees.pizzaiolo_id, poste_jour: 'PIZZAIOLO' }] },
  });
  expect(ouverture.statusCode).toBe(200);
  const serviceId = ouverture.json().id as string;

  const serveur = await membre(serviceId, donnees.serveur_id);
  expect(serveur?.source).toBe('POINTEUSE');
  // Heure réelle du pointage, pas l'heure d'ouverture.
  expect(Date.now() - serveur!.pointe_le!.getTime()).toBeGreaterThan(19 * 60_000);
  expect(await membre(serviceId, donnees.pizzaiolo_id)).toBeUndefined();

  // Cuisine : entrée, sortie, retour 10 min plus tard → 10 min d'absence.
  expect(await pointer('2', 'ENTREE', ilYA(15))).toBe('APPLIQUE');
  expect(await pointer('2', 'ENTREE', ilYA(14))).toBe('IGNORE'); // double passage
  expect(await pointer('2', 'SORTIE', ilYA(12))).toBe('APPLIQUE');
  let cuisine = await membre(serviceId, donnees.cuisine_id);
  expect(cuisine?.reste).toBe(false);
  expect(cuisine?.depart_le).not.toBeNull();
  expect(await pointer('2', null, ilYA(2))).toBe('APPLIQUE'); // sans touche : bascule en Entrée
  cuisine = await membre(serviceId, donnees.cuisine_id);
  expect(cuisine?.depart_le).toBeNull();
  expect(cuisine?.reste).toBeNull();
  expect(Math.round(cuisine!.secondes_absence / 60)).toBe(10);

  const vue = await app.inject({ method: 'GET', url: '/api/pointage', cookies: caissier });
  const ligneCuisine = vue.json().membres.find((m: { utilisateur_id: string }) => m.utilisateur_id === donnees.cuisine_id);
  // 15 min de présence − 10 min d'absence.
  expect(ligneCuisine.minutes_faites).toBeGreaterThanOrEqual(4);
  expect(ligneCuisine.minutes_faites).toBeLessThanOrEqual(5);

  // Pointage de secours à la caisse : PIN manager + motif.
  const sansPin = await app.inject({
    method: 'POST', url: '/api/pointage', cookies: caissier,
    payload: { utilisateur_id: donnees.pizzaiolo_id },
  });
  expect(sansPin.statusCode).toBe(403);
  const avecPin = await app.inject({
    method: 'POST', url: '/api/pointage', cookies: caissier,
    payload: { utilisateur_id: donnees.pizzaiolo_id, pin_manager: PIN_MANAGER, motif: 'Visage non reconnu' },
  });
  expect(avecPin.statusCode).toBe(200);
  expect((await membre(serviceId, donnees.pizzaiolo_id))?.source).toBe('CAISSE');

  // Clôture : la cuisine reste (marquée), les autres non tranchés partent.
  const reste = await app.inject({
    method: 'PATCH', url: `/api/pointage/${donnees.cuisine_id}/depart`, cookies: caissier, payload: { reste: true },
  });
  expect(reste.statusCode).toBe(200);
  await validerInventaire(app, caissier);
  const cloture = await app.inject({
    method: 'POST', url: '/api/services/cloturer', cookies: caissier, payload: { especes_comptees: 0 },
  });
  expect(cloture.statusCode).toBe(200);
  expect((await membre(serviceId, donnees.serveur_id))?.reste).toBe(false);
  expect((await membre(serviceId, donnees.cuisine_id))?.reste).toBe(true);
});

it('sans touche Entrée/Sortie, des passages répétés ne comptent qu’une fois', async () => {
  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const ouverture = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: caissier, payload: { fond_de_caisse: 0 },
  });
  expect(ouverture.statusCode).toBe(200);
  const serviceId = ouverture.json().id as string;

  // Doigt reposé trois fois en 30 s, comme vu sur la pointeuse.
  expect(await pointer('1', null, new Date(Date.now() - 30_000))).toBe('APPLIQUE');
  expect(await pointer('1', null, new Date(Date.now() - 20_000))).toBe('IGNORE');
  expect(await pointer('1', null, new Date())).toBe('IGNORE');
  const serveur = await membre(serviceId, donnees.serveur_id);
  expect(serveur?.pointe_le).not.toBeNull();
  expect(serveur?.depart_le).toBeNull();
});

it('seule la première Entrée fait foi jusqu’à la clôture, avant comme après l’ouverture', async () => {
  // Clôture du shift du test précédent, pour repartir d'une caisse fermée.
  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await validerInventaire(app, caissier);
  const fin = await app.inject({
    method: 'POST', url: '/api/services/cloturer', cookies: caissier, payload: { especes_comptees: 0 },
  });
  expect(fin.statusCode).toBe(200);

  // Employé sans historique de pointage (n° 3).
  await db.update(utilisateurs).set({ pointeuse_no: '3' }).where(eq(utilisateurs.id, donnees.caissier2_id));

  // Deux Entrées avant l'ouverture : l'arrivée est la PREMIÈRE.
  const premiere = new Date(Date.now() - 40 * 60_000);
  expect(await pointer('3', 'ENTREE', premiere)).toBe('EN_ATTENTE');
  expect(await pointer('3', 'ENTREE', ilYA(25))).toBe('EN_ATTENTE');
  const ouverture = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: caissier, payload: { fond_de_caisse: 0 },
  });
  expect(ouverture.statusCode).toBe(200);
  const serviceId = ouverture.json().id as string;
  expect((await membre(serviceId, donnees.caissier2_id))?.pointe_le?.getTime()).toBe(premiere.getTime());

  // Nouvelle Entrée pendant le shift : sans effet, l'arrivée ne bouge pas.
  expect(await pointer('3', 'ENTREE', ilYA(5))).toBe('IGNORE');
  expect(await pointer('3', 'ENTREE', new Date())).toBe('IGNORE');
  const agent = await membre(serviceId, donnees.caissier2_id);
  expect(agent?.pointe_le?.getTime()).toBe(premiere.getTime());
  expect(agent?.secondes_absence).toBe(0);
});

it('change le poste du jour d’un membre en cours de shift, sans toucher à sa fiche', async () => {
  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const [service] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.statut, 'OUVERT'));
  const [avant] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.caissier2_id));

  const rep = await app.inject({
    method: 'PATCH', url: `/api/pointage/${donnees.caissier2_id}/poste`, cookies: caissier,
    payload: { poste_jour: 'PLONGE' },
  });
  expect(rep.statusCode).toBe(200);
  expect((await membre(service!.id, donnees.caissier2_id))?.poste_jour).toBe('PLONGE');

  const [apres] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.caissier2_id));
  expect(apres?.role_id).toBe(avant?.role_id);
  expect(apres?.poste).toBe(avant?.poste);

  const inconnu = await app.inject({
    method: 'PATCH', url: `/api/pointage/${donnees.caissier2_id}/poste`, cookies: caissier,
    payload: { poste_jour: 'ASTRONAUTE' },
  });
  expect(inconnu.statusCode).toBe(400);

  // Absent de l'équipe du shift : rien à changer.
  const absent = await app.inject({
    method: 'PATCH', url: `/api/pointage/${donnees.proprio_id}/poste`, cookies: caissier,
    payload: { poste_jour: 'MANAGER' },
  });
  expect(absent.statusCode).toBe(404);
});

it('rattache après coup un numéro inconnu et rejoue ses pointages', async () => {
  const proprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  const rep = await app.inject({
    method: 'PATCH', url: `/api/admin/pointeuse/employes/${donnees.pizzaiolo_id}`, cookies: proprio,
    payload: { pointeuse_no: '99' },
  });
  expect(rep.statusCode).toBe(200);
  expect(rep.json().pointages_rattrapes).toBe(1);
  const [ev] = await db.select().from(pointeuseEvenements).where(eq(pointeuseEvenements.employe_no, '99'));
  expect(ev?.utilisateur_id).toBe(donnees.pizzaiolo_id);
  expect(ev?.statut).not.toBe('INCONNU');

  const doublon = await app.inject({
    method: 'PATCH', url: `/api/admin/pointeuse/employes/${donnees.caissier_id}`, cookies: proprio,
    payload: { pointeuse_no: '99' },
  });
  expect(doublon.statusCode).toBe(409);
});
