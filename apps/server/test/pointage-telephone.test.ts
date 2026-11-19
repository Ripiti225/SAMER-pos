/**
 * Pointage par téléphone (2026-11-19) : garde-fou « un téléphone = un
 * compte », selfie obligatoire, premier pointage gagnant (pointeuse ou
 * téléphone), arrivées d'avant l'ouverture reprises dans l'équipe du shift.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { appareilsPointage, auditLog, equipeService, parametresLocaux, utilisateurs } from '../src/db/schema/index.js';
import { appliquerEvenement } from '../src/modules/pointeuse/presence.js';
import { COOKIE_APPAREIL } from '../src/modules/pointage-telephone/appareil.js';
import { PIN_CAISSIER, PIN_CUISINE, PIN_MANAGER, PIN_SERVEUR, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;

/** JPEG minimal valide pour le contrôle serveur (SOI … EOI, > 2 Ko). */
const SELFIE = `data:image/jpeg;base64,${Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(3000, 0x41),
  Buffer.from([0xff, 0xd9]),
]).toString('base64')}`;

const cleDe = (r: LightMyRequestResponse) =>
  r.cookies.find((c) => c.name === COOKIE_APPAREIL)?.value ?? null;
const avecCle = (cle: string | null) => (cle ? { [COOKIE_APPAREIL]: cle } : undefined);

const identifier = (utilisateur_id: string, pin: string, cle: string | null) =>
  app.inject({ method: 'POST', url: '/api/pointage-tel/identifier', cookies: avecCle(cle), payload: { utilisateur_id, pin } });
const pointer = (utilisateur_id: string, pin: string, cle: string | null, sens: 'ENTREE' | 'SORTIE', photo: string | undefined = SELFIE) =>
  app.inject({ method: 'POST', url: '/api/pointage-tel/pointer', cookies: avecCle(cle), payload: { utilisateur_id, pin, sens, photo } });
const activer = (actif: boolean) =>
  db.insert(parametresLocaux).values({ cle: 'pointage_telephone_actif', valeur: actif as never })
    .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: actif as never } });
const audits = async (action: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.action, action))).length;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('garde-fou un téléphone = un compte', () => {
  let cleServeur: string;

  it('refuse tout tant que le pointage par téléphone n’est pas activé', async () => {
    const r = await identifier(donnees.serveur_id, PIN_SERVEUR, null);
    expect(r.statusCode).toBe(403);
    expect(r.json().message ?? r.json().erreur ?? r.body).toMatch(/pas activé/);
    await activer(true);
  });

  it('rattache tout seul le premier téléphone d’un compte', async () => {
    const r = await identifier(donnees.serveur_id, PIN_SERVEUR, null);
    expect(r.statusCode).toBe(200);
    cleServeur = cleDe(r)!;
    expect(cleServeur).toBeTruthy();
    expect(r.json().presence.action).toBe('ARRIVEE');
    const etat = await app.inject({ method: 'GET', url: '/api/pointage-tel/etat', cookies: avecCle(cleServeur) });
    expect(etat.json().compte.id).toBe(donnees.serveur_id);
    // Le téléphone rattaché ne voit plus la liste des comptes.
    const comptes = await app.inject({ method: 'GET', url: '/api/pointage-tel/comptes', cookies: avecCle(cleServeur) });
    expect(comptes.json()).toEqual([]);
  });

  it('refuse un 2e compte sur le même téléphone, et le trace', async () => {
    const r = await identifier(donnees.cuisine_id, PIN_CUISINE, cleServeur);
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Ce téléphone est déjà rattaché à un compte');
    expect(await audits('APPAREIL_DEJA_RATTACHE')).toBe(1);
    // Et le refus ne crée rien pour le 2e compte.
    const lignes = await db.select().from(appareilsPointage).where(eq(appareilsPointage.utilisateur_id, donnees.cuisine_id));
    expect(lignes).toHaveLength(0);
  });

  it('un changement de téléphone attend le gérant (PIN manager)', async () => {
    const demande = await identifier(donnees.serveur_id, PIN_SERVEUR, null);
    expect(demande.statusCode).toBe(409);
    expect(demande.body).toContain('autre téléphone');
    const nouvelleCle = cleDe(demande)!;
    expect(nouvelleCle).toBeTruthy();

    // Tant que ce n'est pas accepté, le nouveau téléphone ne pointe pas.
    expect((await pointer(donnees.serveur_id, PIN_SERVEUR, nouvelleCle, 'ENTREE')).statusCode).toBe(403);

    const manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    const liste = await app.inject({ method: 'GET', url: '/api/pointage-tel/demandes', cookies: manager });
    expect(liste.json()).toHaveLength(1);
    const id = liste.json()[0].id as string;

    const mauvaisPin = await app.inject({ method: 'POST', url: `/api/pointage-tel/demandes/${id}/accepter`, cookies: manager, payload: { pin_manager: PIN_SERVEUR } });
    expect(mauvaisPin.statusCode).not.toBe(200);

    const ok = await app.inject({ method: 'POST', url: `/api/pointage-tel/demandes/${id}/accepter`, cookies: manager, payload: { pin_manager: PIN_MANAGER } });
    expect(ok.statusCode).toBe(200);

    // L'ancien téléphone ne sert plus, le nouveau oui.
    expect((await identifier(donnees.serveur_id, PIN_SERVEUR, nouvelleCle)).statusCode).toBe(200);
    const ancien = await identifier(donnees.serveur_id, PIN_SERVEUR, cleServeur);
    expect(ancien.statusCode).toBe(409);
    expect(await audits('APPAREIL_CHANGEMENT_ACCEPTE')).toBe(1);
  });
});

describe('pointer arrivée et départ', () => {
  let cleCuisine: string;
  let cleServeur: string;

  beforeAll(async () => {
    const c = await identifier(donnees.cuisine_id, PIN_CUISINE, null);
    cleCuisine = cleDe(c)!;
    const [s] = await db.select().from(appareilsPointage)
      .where(and(eq(appareilsPointage.utilisateur_id, donnees.serveur_id), eq(appareilsPointage.statut, 'ACTIF')));
    expect(s).toBeTruthy();
    // Le serveur repart d'un téléphone neuf, rattaché au 1er coup.
    await db.delete(appareilsPointage).where(eq(appareilsPointage.utilisateur_id, donnees.serveur_id));
    cleServeur = cleDe(await identifier(donnees.serveur_id, PIN_SERVEUR, null))!;
  });

  it('exige un selfie lisible', async () => {
    expect((await pointer(donnees.cuisine_id, PIN_CUISINE, cleCuisine, 'ENTREE', '')).statusCode).toBe(400);
    expect((await pointer(donnees.cuisine_id, PIN_CUISINE, cleCuisine, 'ENTREE', 'data:image/jpeg;base64,AAAA')).statusCode).toBe(400);
  });

  it('refuse un PIN faux', async () => {
    expect((await pointer(donnees.cuisine_id, '9999', cleCuisine, 'ENTREE')).statusCode).toBe(401);
  });

  it('garde l’arrivée d’avant l’ouverture et la reporte, avec son heure, dans l’équipe', async () => {
    const r = await pointer(donnees.cuisine_id, PIN_CUISINE, cleCuisine, 'ENTREE');
    expect(r.statusCode).toBe(200);
    expect(r.json().statut).toBe('EN_ATTENTE');
    // Déjà pointé : refusé, même avant l'ouverture.
    const double = await pointer(donnees.cuisine_id, PIN_CUISINE, cleCuisine, 'ENTREE');
    expect(double.statusCode).toBe(409);
    expect(double.body).toContain('déjà pointée');
    // Départ impossible tant que le shift n'est pas ouvert.
    expect((await pointer(donnees.cuisine_id, PIN_CUISINE, cleCuisine, 'SORTIE')).statusCode).toBe(409);

    // Site sans pointeuse : la caisse coche le pizzaiolo, le téléphone apporte la cuisine.
    const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    const ouverture = await app.inject({
      method: 'POST', url: '/api/services/ouvrir', cookies: caissier,
      payload: { fond_de_caisse: 0, equipe: [
        { utilisateur_id: donnees.pizzaiolo_id, poste_jour: 'PIZZAIOLO' },
        { utilisateur_id: donnees.cuisine_id, poste_jour: 'CUISINIER' },
      ] },
    });
    expect(ouverture.statusCode).toBe(200);
    const serviceId = ouverture.json().id as string;
    const equipe = await db.select().from(equipeService).where(eq(equipeService.service_id, serviceId));
    const cuisine = equipe.find((m) => m.utilisateur_id === donnees.cuisine_id)!;
    expect(cuisine.source).toBe('TELEPHONE');
    expect(cuisine.poste_jour).toBe('CUISINIER');
    expect(cuisine.pointe_le!.getTime()).toBe(new Date(r.json().heure).getTime());
    expect(equipe.find((m) => m.utilisateur_id === donnees.pizzaiolo_id)?.source).toBe('OUVERTURE');

    // Le gérant voit le selfie depuis la fiche du bandeau.
    const manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    const selfie = await app.inject({ method: 'GET', url: `/api/pointage-tel/selfie/${cuisine.id}/ENTREE`, cookies: manager });
    expect(selfie.statusCode).toBe(200);
    expect(selfie.headers['content-type']).toContain('image/jpeg');
    // Pas sans session caisse.
    expect((await app.inject({ method: 'GET', url: `/api/pointage-tel/selfie/${cuisine.id}/ENTREE` })).statusCode).toBe(401);
  });

  it('pointe le départ une seule fois, et plus d’arrivée après', async () => {
    const depart = await pointer(donnees.cuisine_id, PIN_CUISINE, cleCuisine, 'SORTIE');
    expect(depart.statusCode).toBe(200);
    expect(depart.json().presence.action).toBe('AUCUNE');
    const [m] = await db.select().from(equipeService).where(eq(equipeService.utilisateur_id, donnees.cuisine_id));
    expect(m!.depart_le).not.toBeNull();
    expect(m!.reste).toBe(false);
    expect((await pointer(donnees.cuisine_id, PIN_CUISINE, cleCuisine, 'SORTIE')).statusCode).toBe(409);
    expect((await pointer(donnees.cuisine_id, PIN_CUISINE, cleCuisine, 'ENTREE')).statusCode).toBe(409);
    expect(await audits('POINTAGE_TELEPHONE')).toBe(2);
  });

  it('la pointeuse passée en premier gagne : le téléphone est refusé', async () => {
    await db.insert(parametresLocaux).values({ cle: 'pointeuse_url', valeur: 'http://192.0.2.10' });
    await db.update(utilisateurs).set({ pointeuse_no: '5' }).where(eq(utilisateurs.id, donnees.serveur_id));
    await db.transaction((tx) => appliquerEvenement(tx, 'TEST-POINTEUSE', {
      numero: 1, employe_no: '5', nom: null, sens: 'ENTREE', pointe_le: new Date(Date.now() - 60_000),
    }));
    const r = await pointer(donnees.serveur_id, PIN_SERVEUR, cleServeur, 'ENTREE');
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('à la pointeuse');
    // Mais il peut pointer son départ au téléphone.
    const depart = await pointer(donnees.serveur_id, PIN_SERVEUR, cleServeur, 'SORTIE');
    expect(depart.statusCode).toBe(200);
  });
});
