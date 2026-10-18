import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, utilisateurs } from '../src/db/schema/index.js';
import { ouvrirServiceEtCommande, PIN_CAISSIER, PIN_CAISSIER2, PIN_PROPRIO, resetDonnees, seConnecter, type Donnees } from './aide.js';

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

it('un caissier promu manager valide une remise et libère une table avec son PIN de connexion', async () => {
  const proprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const commande = await ouvrirServiceEtCommande(app, caissier, donnees, 2);

  const promotion = await app.inject({
    method: 'PATCH', url: `/api/admin/equipe/${donnees.caissier2_id}`, cookies: proprio,
    payload: { role_id: donnees.roles.MANAGER },
  });
  expect(promotion.statusCode).toBe(200);
  const [promu] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.caissier2_id));
  expect(promu!.role).toBeNull();
  expect(promu!.role_id).toBe(donnees.roles.MANAGER);
  await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);

  // Le droit de consulter le rapport Z est indépendant du droit de valider
  // une action protégée par le PIN d'un manager.
  const liste = await app.inject({ method: 'GET', url: '/api/admin/roles', cookies: proprio });
  const manager = (liste.json() as { id: string; permissions: string[] }[])
    .find((r) => r.id === donnees.roles.MANAGER)!;
  const droits = manager.permissions.filter((p) => p !== 'rapports.z');
  expect(droits).toContain('caisse.remise');
  expect(droits).toContain('caisse.annuler_envoye');
  const changement = await app.inject({
    method: 'PATCH', url: `/api/admin/roles/${manager.id}`, cookies: proprio,
    payload: { permissions: droits },
  });
  expect(changement.statusCode).toBe(200);

  const remise = await app.inject({
    method: 'POST', url: `/api/commandes/${commande.commande_id}/remise`, cookies: caissier,
    payload: { montant: 500, motif: 'Client fidèle', pin_manager: PIN_CAISSIER2 },
  });
  expect(remise.statusCode).toBe(200);
  expect(remise.json().remise_montant).toBe(500);

  const ouverture = await app.inject({
    method: 'POST', url: '/api/commandes', cookies: caissier,
    payload: { type: 'SUR_PLACE', table_id: donnees.table_id },
  });
  expect(ouverture.statusCode).toBe(200);
  const ajout = await app.inject({
    method: 'POST', url: `/api/commandes/${ouverture.json().id}/items`, cookies: caissier,
    payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
  });
  expect(ajout.statusCode).toBe(200);
  const liberation = await app.inject({
    method: 'POST', url: `/api/caisse/tables/${donnees.table_id}/liberer`, cookies: caissier,
    payload: { pin_manager: PIN_CAISSIER2, motif: 'Client parti' },
  });
  expect(liberation.statusCode).toBe(200);
  expect(liberation.json().annulees).toBe(1);

  const traces = await db.select().from(auditLog);
  expect(traces.find((t) => t.action === 'REMISE')?.user_id).toBe(donnees.caissier2_id);
  expect(traces.find((t) => t.action === 'ANNULATION_COMMANDE')?.user_id).toBe(donnees.caissier2_id);
});
