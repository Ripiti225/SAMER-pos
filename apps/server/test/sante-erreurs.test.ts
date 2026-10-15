import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { PIN_CAISSIER, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let caissier: Record<string, string>;
let manager: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  // Route volontairement cassée : vérifie le gestionnaire global sans ajouter
  // de panne artificielle aux routes de production.
  app.get('/api/test/incident-sante', { preHandler: app.exigerAuth }, async () => {
    const erreur = new Error('relation commandes_archivees does not exist') as Error & { code: string };
    erreur.code = '42P01';
    throw erreur;
  });
  caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('journal Santé du système', () => {
  let incidentId = '';

  it('remplace le message opaque par une explication française et une référence', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/test/incident-sante', cookies: caissier });
    expect(rep.statusCode).toBe(500);
    expect(rep.json().erreur).toContain('base locale n’est pas à jour');
    expect(rep.json().erreur).toContain('Incident');
    expect(rep.json().erreur).not.toContain('Une erreur interne est survenue');
  });

  it('affiche le contexte et le détail technique au manager', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/sante/erreurs', cookies: manager });
    expect(rep.statusCode).toBe(200);
    const [incident] = rep.json() as Array<{
      id: string;
      code: string;
      message_fr: string;
      detail_technique: string;
      contexte: { chemin: string; utilisateur_id: string };
    }>;
    incidentId = incident!.id;
    expect(incident).toMatchObject({
      code: '42P01',
      contexte: { chemin: '/api/test/incident-sante', utilisateur_id: donnees.caissier_id },
    });
    expect(incident!.message_fr).toContain('base locale n’est pas à jour');
    expect(incident!.detail_technique).toContain('commandes_archivees');
  });

  it('permet de marquer un incident comme résolu sans le supprimer', async () => {
    const resolution = await app.inject({
      method: 'POST', url: `/api/sante/erreurs/${incidentId}/resoudre`, cookies: manager, payload: {},
    });
    expect(resolution.statusCode).toBe(200);

    const actifs = await app.inject({ method: 'GET', url: '/api/sante/erreurs', cookies: manager });
    expect(actifs.json()).toEqual([]);
    const historique = await app.inject({ method: 'GET', url: '/api/sante/erreurs?resolues=true', cookies: manager });
    expect(historique.json()[0]).toMatchObject({ id: incidentId, resolue_par_nom: 'Manager Test' });
  });
});
