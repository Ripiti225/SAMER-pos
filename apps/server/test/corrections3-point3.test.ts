/**
 * CORRECTIONS3 point 3 — propriété de table : un serveur ne peut pas entrer
 * dans la table d'un autre ; caisse/manager oui ; transfert tracé.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, tablesSalle, utilisateurs } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_SERVEUR, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesAwa: Record<string, string>; // serveur propriétaire
let cookiesFatou: Record<string, string>; // autre serveur
let cookiesCaissier: Record<string, string>;
let fatouId: string;
let commandeId: string;

async function ouvrirTableParAwa(): Promise<string> {
  const rep = await app.inject({
    method: 'POST',
    url: '/api/serveur/envoyer',
    cookies: cookiesAwa,
    payload: {
      action_uuid: crypto.randomUUID(),
      table_id: donnees.table_id,
      items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
    },
  });
  return rep.json().commande_id as string;
}

beforeAll(async () => {
  donnees = await resetDonnees();
  // Un 2e serveur « Fatou » (le fixture n'en a qu'un)
  const [fatou] = await db
    .insert(utilisateurs)
    .values({ nom_complet: 'Fatou Bamba', role: 'SERVEUR', pin_hash: (await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.serveur_id)))[0]!.pin_hash })
    .returning();
  fatouId = fatou!.id;

  app = await construireApp();
  cookiesAwa = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR); // « Awa » = serveur du fixture
  cookiesFatou = await seConnecter(app, fatouId, PIN_SERVEUR);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: cookiesCaissier, payload: { fond_de_caisse: 25000 } });
  commandeId = await ouvrirTableParAwa();
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('propriété : la table appartient au serveur qui l’a ouverte', () => {
  it('l’ouverture renseigne ouverte_par sur la table', async () => {
    const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, donnees.table_id));
    expect(t!.ouverte_par).toBe(donnees.serveur_id);
  });

  it('un AUTRE serveur reçoit 403 « Table ouverte par … » (voir détail)', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/commandes/${commandeId}`, cookies: cookiesFatou });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).toContain('Table ouverte par');
  });

  it('un autre serveur ne peut ni ajouter/envoyer ni demander l’addition (403)', async () => {
    const envoi = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: cookiesFatou,
      payload: {
        action_uuid: crypto.randomUUID(),
        table_id: donnees.table_id,
        items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
      },
    });
    expect(envoi.statusCode).toBe(403);

    const addition = await app.inject({
      method: 'POST',
      url: '/api/serveur/addition',
      cookies: cookiesFatou,
      payload: { action_uuid: crypto.randomUUID(), table_id: donnees.table_id },
    });
    expect(addition.statusCode).toBe(403);
  });

  it('le propriétaire, LUI, a accès à sa table', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/commandes/${commandeId}`, cookies: cookiesAwa });
    expect(rep.statusCode).toBe(200);
  });

  it('la caissière a accès à toutes les tables', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/commandes/${commandeId}`, cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(200);
  });
});

describe('transfert de table (caisse) + audit', () => {
  it('la caisse réaffecte la table à Fatou et trace TRANSFERT_TABLE', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/caisse/tables/${donnees.table_id}/transferer`,
      cookies: cookiesCaissier,
      payload: { serveur_id: fatouId },
    });
    expect(rep.statusCode).toBe(200);

    const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, donnees.table_id));
    expect(t!.ouverte_par).toBe(fatouId);

    // Fatou a maintenant accès ; Awa ne l'a plus
    const fatouOk = await app.inject({ method: 'GET', url: `/api/commandes/${commandeId}`, cookies: cookiesFatou });
    expect(fatouOk.statusCode).toBe(200);
    const awaNon = await app.inject({ method: 'GET', url: `/api/commandes/${commandeId}`, cookies: cookiesAwa });
    expect(awaNon.statusCode).toBe(403);

    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'TRANSFERT_TABLE'));
    expect(traces.length).toBe(1);
    expect((traces[0]!.meta as { nouveau_serveur: string }).nouveau_serveur).toBe(fatouId);
  });

  it('un serveur ne peut pas transférer une table (route réservée caisse/manager)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/caisse/tables/${donnees.table_id}/transferer`,
      cookies: cookiesFatou,
      payload: { serveur_id: donnees.serveur_id },
    });
    expect(rep.statusCode).toBe(403);
  });

  it('l’encaissement libère la table et efface le propriétaire', async () => {
    // Manager encaisse (accès total) — d'abord total connu
    const vue = await app.inject({ method: 'GET', url: `/api/commandes/${commandeId}`, cookies: cookiesCaissier });
    const total = vue.json().total as number;
    const pay = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies: cookiesCaissier,
      payload: { mode: 'ESPECES', montant: total },
    });
    expect(pay.statusCode).toBe(200);
    const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, donnees.table_id));
    expect(t!.statut).toBe('LIBRE');
    expect(t!.ouverte_par).toBeNull();
  });
});
