/**
 * Cloisonnement des restaurants : l'image de déploiement est copiée telle
 * quelle sur les 7 sites, donc TOUS les postes démarrent avec le même
 * `restaurant.id`. C'est la configuration du site (Réglages → Restaurant) qui
 * doit lui donner une identité propre — sinon les ventes de Palmeraie et
 * celles du 7E remonteraient sous le même restaurant_id côté cloud.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { commandes, parametresLocaux, restaurant } from '../src/db/schema/index.js';
import { synchroniserEquipe } from '../src/modules/equipe/sync-samtrackly.js';
import { PIN_PROPRIO, resetDonnees, seConnecter, type Donnees } from './aide.js';

const RESTO_A = { id: 'aaaaaaaa-0000-4000-8000-000000000001', nom: 'Chez Samer Palmeraie', couleur: '#EF9F27' };
const RESTO_B = { id: 'bbbbbbbb-0000-4000-8000-000000000002', nom: 'Chez Samer Angré 7E', couleur: '#EF9F27' };
const ID_POS_EXISTANT = 'cccccccc-0000-4000-8000-000000000003';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

/** Fait répondre SamerTrackly avec la liste des restaurants du groupe. */
function stubSamtrackly(): void {
  process.env.SAMTRACKLY_URL = 'https://samtrackly.test';
  process.env.SAMTRACKLY_KEY = 'cle-de-test';
  vi.stubGlobal('fetch', async (url: string) =>
    url.includes('/restaurants')
      ? new Response(JSON.stringify([RESTO_A, RESTO_B]), { headers: { 'content-type': 'application/json' } })
      : new Response('[]', { headers: { 'content-type': 'application/json' } }),
  );
}

async function idRestaurant(): Promise<string> {
  const [r] = await db.select().from(restaurant).limit(1);
  return r!.id;
}

async function param(cle: string): Promise<unknown> {
  const [p] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, cle));
  return p?.valeur;
}

async function configurer(idSamtrackly: string) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/restaurant/config',
    cookies,
    payload: { samtrackly_restaurant_id: idSamtrackly },
  });
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  stubSamtrackly();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await fermerDb();
});

describe('identité de site (déploiement multi-restaurants)', () => {
  it('propose le profil local À la Braise dans la liste de configuration', async () => {
    const rep = await app.inject({
      method: 'GET',
      url: '/api/admin/restaurant/config',
      cookies,
    });

    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json().restaurant_id).toBe(await idRestaurant());
    expect(rep.json().restaurants).toContainEqual({
      id: 'profil:ALA_BRAISE',
      nom: 'À la Braise',
      couleur: '#D99A2B',
      source: 'PROFIL_LOCAL',
    });
  });

  it('la première configuration donne un identifiant NEUF et invalide l’enrôlement cloud', async () => {
    // Le poste sort de l'image master : id commun à tous les sites + clé de
    // site éventuellement héritée d'un enrôlement précédent.
    const idMaster = await idRestaurant();
    await db.insert(parametresLocaux).values({ cle: 'cle_site', valeur: 'cle-heritee-du-master' as never });

    const rep = await configurer(RESTO_A.id);
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ nom: RESTO_A.nom, code: 'CHEZ_SAMER_PALMERAIE', sync_a_reenroler: true });

    expect(await idRestaurant()).not.toBe(idMaster);
    // La clé pointait sur l'ancien restaurant_id : elle doit avoir disparu.
    expect(await param('cle_site')).toBeUndefined();
    expect(await param('samtrackly_restaurant_id')).toBe(RESTO_A.id);
  });

  it('reconfigurer le MÊME restaurant ne change pas l’identifiant (pas de ré-enrôlement inutile)', async () => {
    const avant = await idRestaurant();
    await db.insert(parametresLocaux).values({ cle: 'cle_site', valeur: 'cle-du-site-palmeraie' as never });

    const rep = await configurer(RESTO_A.id);
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ sync_a_reenroler: false });
    expect(await idRestaurant()).toBe(avant);
    expect(await param('cle_site')).toBe('cle-du-site-palmeraie');
  });

  it('réaffecter le poste à un autre restaurant régénère l’identifiant et coupe la synchro', async () => {
    const avant = await idRestaurant();

    const rep = await configurer(RESTO_B.id);
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ nom: RESTO_B.nom, sync_a_reenroler: true });

    const apres = await idRestaurant();
    expect(apres).not.toBe(avant);
    expect(await param('cle_site')).toBeUndefined();
  });

  it('un mini-PC de remplacement reprend l’identifiant POS existant sans créer un nouveau site', async () => {
    donnees = await resetDonnees();
    await db.execute(sql`UPDATE restaurant SET code = 'A_CONFIGURER', nom = 'Restaurant à configurer'`);
    await db.insert(parametresLocaux).values({ cle: 'cle_site', valeur: 'cle-heritee-du-master' as never });
    cookies = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);

    const rep = await app.inject({
      method: 'POST',
      url: '/api/admin/restaurant/config',
      cookies,
      payload: {
        mode: 'REMPLACEMENT',
        samtrackly_restaurant_id: RESTO_A.id,
        restaurant_id_existant: ID_POS_EXISTANT,
      },
    });

    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json()).toMatchObject({
      identite_reprise: true,
      restaurant_id: ID_POS_EXISTANT,
      sync_a_activer: true,
    });
    expect(await idRestaurant()).toBe(ID_POS_EXISTANT);
    expect(await param('samtrackly_restaurant_id')).toBe(RESTO_A.id);
    expect(await param('mode_configuration_site')).toBe('REMPLACEMENT');
    expect(await param('cle_site')).toBeUndefined();
  });

  it('refuse de transformer en remplacement une base qui contient déjà des ventes', async () => {
    donnees = await resetDonnees();
    await db.execute(sql`UPDATE restaurant SET code = 'A_CONFIGURER', nom = 'Restaurant à configurer'`);
    await db.insert(commandes).values({ type: 'EMPORTER' });
    cookies = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
    const avant = await idRestaurant();

    const rep = await app.inject({
      method: 'POST',
      url: '/api/admin/restaurant/config',
      cookies,
      payload: {
        mode: 'REMPLACEMENT',
        samtrackly_restaurant_id: RESTO_A.id,
        restaurant_id_existant: ID_POS_EXISTANT,
      },
    });

    expect(rep.statusCode, rep.body).toBe(409);
    expect(rep.json()).toMatchObject({
      erreur: expect.stringContaining('base neuve'),
    });
    expect(await idRestaurant()).toBe(avant);
  });

  it('sans restaurant configuré, la synchro équipe ne descend l’équipe de PERSONNE', async () => {
    await db.delete(parametresLocaux).where(eq(parametresLocaux.cle, 'samtrackly_restaurant_id'));
    const r = await synchroniserEquipe(null);
    expect(r.saute).toBe(true);
    expect(r.total).toBe(0);
  });

  it('applique le profil local À la Braise depuis le même écran', async () => {
    donnees = await resetDonnees();
    await db.execute(sql`UPDATE restaurant SET code = 'A_CONFIGURER', nom = 'Restaurant à configurer'`);
    cookies = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);

    const rep = await app.inject({
      method: 'POST',
      url: '/api/admin/restaurant/config',
      cookies,
      payload: { profil_code: 'ALA_BRAISE' },
    });

    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json()).toMatchObject({ code: 'ALA_BRAISE', nom: 'À la Braise' });
    const [identite] = await db.select().from(restaurant).limit(1);
    expect(identite).toMatchObject({ code: 'ALA_BRAISE', nom: 'À la Braise', marque: 'A_LA_BRAISE' });
  });
});
