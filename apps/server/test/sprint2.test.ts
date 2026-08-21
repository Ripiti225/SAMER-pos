import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CommandeVue, KdsVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { commandes, tablesSalle } from '../src/db/schema/index.js';
import {
  JETON_KDS,
  PIN_CAISSIER,
  PIN_MANAGER,
  PIN_SERVEUR,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesServeur: Record<string, string>;
let cookiesCaissier: Record<string, string>;
let commandeId: string;

async function statutTable(): Promise<string> {
  const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, donnees.table_id));
  return t!.statut;
}

async function vueCommande(): Promise<CommandeVue> {
  const rep = await app.inject({ method: 'GET', url: `/api/commandes/${commandeId}`, cookies: cookiesCaissier });
  return rep.json() as CommandeVue;
}

async function vueKds(): Promise<KdsVue> {
  const rep = await app.inject({ method: 'GET', url: '/api/kds/commandes', headers: { 'x-jeton-kds': JETON_KDS } });
  expect(rep.statusCode).toBe(200);
  return rep.json() as KdsVue;
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookiesServeur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({
    method: 'POST',
    url: '/api/services/ouvrir',
    cookies: cookiesCaissier,
    payload: { fond_de_caisse: 25000 },
  });
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('tablette serveur : envoi en cuisine idempotent (file anti-coupure §B4)', () => {
  const uuidEnvoi1 = randomUUID();

  it('crée la commande de table, envoie les articles, occupe la table', async () => {
    expect(await statutTable()).toBe('LIBRE');

    const rep = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: cookiesServeur,
      payload: {
        action_uuid: uuidEnvoi1,
        table_id: donnees.table_id,
        items: [{ article_id: donnees.article_id, quantite: 2, options: [], supplements: [] }],
      },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().deja_traitee).toBe(false);
    commandeId = rep.json().commande_id;

    const vue = await vueCommande();
    expect(vue.statut).toBe('ENVOYEE_CUISINE');
    expect(vue.items).toHaveLength(1);
    expect(vue.items[0]!.envoye).toBe(true);
    expect(vue.total).toBe(6000);
    expect(await statutTable()).toBe('OCCUPEE');

    // Attribution au serveur (nécessaire pour la notation du sprint 4)
    const [c] = await db.select().from(commandes).where(eq(commandes.id, commandeId));
    expect(c!.serveur_id).toBe(donnees.serveur_id);
    expect(c!.service_id).toBeNull(); // pas encore rattachée à une caisse
  });

  it('rejouer le MÊME uuid (coupure WiFi puis reconnexion) ne crée aucun doublon', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: cookiesServeur,
      payload: {
        action_uuid: uuidEnvoi1,
        table_id: donnees.table_id,
        items: [{ article_id: donnees.article_id, quantite: 2, options: [], supplements: [] }],
      },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().deja_traitee).toBe(true);

    const vue = await vueCommande();
    expect(vue.items).toHaveLength(1); // toujours 1 seul lot
    expect(vue.total).toBe(6000);

    const toutes = await db.select().from(commandes).where(eq(commandes.table_id, donnees.table_id));
    expect(toutes).toHaveLength(1); // pas de deuxième commande
  });

  it('un NOUVEL uuid ajoute le nouveau lot à la même commande de table (§B2)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: cookiesServeur,
      payload: {
        action_uuid: randomUUID(),
        table_id: donnees.table_id,
        items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
      },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().commande_id).toBe(commandeId);

    const vue = await vueCommande();
    expect(vue.items).toHaveLength(2);
    expect(vue.total).toBe(9000);
  });
});

describe('guard de rôle : le SERVEUR ne peut ni encaisser, ni remiser, ni clôturer', () => {
  it('encaissement par un serveur → 403', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies: cookiesServeur,
      payload: { mode: 'ESPECES', montant: 9000 },
    });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).toBe('Vous n’avez pas le droit d’effectuer cette action');
  });

  it('remise par un serveur → 403, clôture par un serveur → 403', async () => {
    const remise = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/remise`,
      cookies: cookiesServeur,
      payload: { montant: 500, motif: 'Tentative', pin_manager: PIN_MANAGER },
    });
    expect(remise.statusCode).toBe(403);

    const cloture = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: cookiesServeur,
      payload: { especes_comptees: 1000 },
    });
    expect(cloture.statusCode).toBe(403);
  });

  it('le KDS est réservé aux appareils munis du jeton (correction 3)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/kds/commandes', cookies: cookiesServeur });
    expect(rep.statusCode).toBe(403);
  });
});

describe('KDS : cycle Commencer → Prêt → Reprendre, article annulé barré', () => {
  it('la carte apparaît dans la grille avec ses articles A_PREPARER', async () => {
    const kds = await vueKds();
    expect(kds.seuils).toEqual({ orange_minutes: 10, rouge_minutes: 20 });
    const carte = kds.en_cuisine.find((c) => c.id === commandeId);
    expect(carte).toBeDefined();
    expect(carte!.table_numero).toBe('T1');
    expect(carte!.type).toBe('SUR_PLACE');
    expect(carte!.items).toHaveLength(2);
    expect(carte!.items.every((i) => i.statut_cuisine === 'A_PREPARER')).toBe(true);
  });

  it('« Commencer » passe toute la carte à EN_COURS', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/kds/commandes/${commandeId}/commencer`,
      headers: { 'x-jeton-kds': JETON_KDS },
    });
    expect(rep.statusCode).toBe(200);
    const kds = await vueKds();
    const carte = kds.en_cuisine.find((c) => c.id === commandeId)!;
    expect(carte.items.every((i) => i.statut_cuisine === 'EN_COURS')).toBe(true);
  });

  it('un article annulé depuis la caisse (PIN manager + motif) reste sur la carte, marqué ANNULE', async () => {
    const vueAvant = await vueCommande();
    const itemAnnule = vueAvant.items[1]!; // le lot de 1 (3000 F)

    // Sans PIN manager → refus (article déjà envoyé en cuisine)
    const sansPin = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/items/${itemAnnule.id}/annuler`,
      cookies: cookiesCaissier,
      payload: { motif: 'Client a changé d’avis' },
    });
    expect(sansPin.statusCode).toBe(403);

    const avecPin = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/items/${itemAnnule.id}/annuler`,
      cookies: cookiesCaissier,
      payload: { motif: 'Client a changé d’avis', pin_manager: PIN_MANAGER },
    });
    expect(avecPin.statusCode).toBe(200);
    expect(avecPin.json().total).toBe(6000); // l'article annulé ne compte plus

    const kds = await vueKds();
    const carte = kds.en_cuisine.find((c) => c.id === commandeId)!;
    const surCarte = carte.items.find((i) => i.id === itemAnnule.id);
    expect(surCarte).toBeDefined(); // jamais supprimé de la carte
    expect(surCarte!.statut_cuisine).toBe('ANNULE');
  });

  it('« Prêt » sort la carte de la grille vers la colonne Prêtes ; « Reprendre » la rappelle', async () => {
    const pret = await app.inject({
      method: 'POST',
      url: `/api/kds/commandes/${commandeId}/pret`,
      headers: { 'x-jeton-kds': JETON_KDS },
    });
    expect(pret.statusCode).toBe(200);

    let kds = await vueKds();
    expect(kds.en_cuisine.find((c) => c.id === commandeId)).toBeUndefined();
    const prete = kds.pretes.find((c) => c.id === commandeId)!;
    expect(prete.statut).toBe('PRETE');
    // les articles non annulés sont PRET, l'annulé reste ANNULE
    expect(prete.items.find((i) => i.statut_cuisine === 'PRET')).toBeDefined();
    expect(prete.items.find((i) => i.statut_cuisine === 'ANNULE')).toBeDefined();

    const reprendre = await app.inject({
      method: 'POST',
      url: `/api/kds/commandes/${commandeId}/reprendre`,
      headers: { 'x-jeton-kds': JETON_KDS },
    });
    expect(reprendre.statusCode).toBe(200);
    kds = await vueKds();
    expect(kds.en_cuisine.find((c) => c.id === commandeId)).toBeDefined();
    expect(kds.pretes.find((c) => c.id === commandeId)).toBeUndefined();

    // On remet Prêt pour la suite du parcours
    await app.inject({ method: 'POST', url: `/api/kds/commandes/${commandeId}/pret`, headers: { 'x-jeton-kds': JETON_KDS } });
  });
});

describe('transitions de statut de table (§B3, §C)', () => {
  const uuidAddition = randomUUID();

  it('« Demander l’addition » passe la table à ADDITION_DEMANDEE (idempotent)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/serveur/addition',
      cookies: cookiesServeur,
      payload: { action_uuid: uuidAddition, table_id: donnees.table_id },
    });
    expect(rep.statusCode).toBe(200);
    expect(await statutTable()).toBe('ADDITION_DEMANDEE');

    // rejeu → aucun effet, aucun échec
    const rejeu = await app.inject({
      method: 'POST',
      url: '/api/serveur/addition',
      cookies: cookiesServeur,
      payload: { action_uuid: uuidAddition, table_id: donnees.table_id },
    });
    expect(rejeu.statusCode).toBe(200);
    expect(rejeu.json().deja_traitee).toBe(true);
  });

  it('l’encaissement complet à la caisse libère la table et rattache la commande au service du caissier', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies: cookiesCaissier,
      payload: { mode: 'ESPECES', montant: 6000 },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().statut).toBe('PAYEE');
    expect(await statutTable()).toBe('LIBRE');

    const [c] = await db.select().from(commandes).where(eq(commandes.id, commandeId));
    expect(c!.service_id).not.toBeNull(); // comptera dans le rapport Z du caissier
  });

  it('l’addition sans commande en cours est refusée avec un message clair', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/serveur/addition',
      cookies: cookiesServeur,
      payload: { action_uuid: randomUUID(), table_id: donnees.table_id },
    });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toBe('Aucune commande en cours sur cette table');
  });
});
