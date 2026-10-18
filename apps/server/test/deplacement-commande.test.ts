import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, commandeItems, commandes } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_SERVEUR, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let caisse: Record<string, string>;
let serveur: Record<string, string>;

async function creerCommande(payload: Record<string, unknown>) {
  const rep = await app.inject({ method: 'POST', url: '/api/commandes', cookies: caisse, payload });
  expect(rep.statusCode, rep.body).toBe(200);
  return rep.json() as { id: string };
}

async function ajouter(commandeId: string) {
  const rep = await app.inject({
    method: 'POST', url: `/api/commandes/${commandeId}/items`, cookies: caisse,
    payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
  });
  expect(rep.statusCode, rep.body).toBe(200);
  return rep.json() as { total: number; items: Array<{ id: string; prix_unitaire: number }> };
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  caisse = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  serveur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
  const service = await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: caisse, payload: { fond_de_caisse: 25000 } });
  expect(service.statusCode, service.body).toBe(200);
});

afterAll(async () => { await app.close(); await fermerDb(); });

describe('déplacement sans faux retour', () => {
  it('transforme une commande à emporter en Yango en conservant les prix', async () => {
    const commande = await creerCommande({ type: 'EMPORTER' });
    const avant = await ajouter(commande.id);
    const rep = await app.inject({
      method: 'POST', url: `/api/commandes/${commande.id}/deplacer`, cookies: caisse,
      payload: { type: 'LIVRAISON', partenaire: 'YANGO', table_id: donnees.table_yango_id },
    });
    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json()).toMatchObject({ type: 'LIVRAISON', partenaire: 'YANGO', table_id: donnees.table_yango_id, total: avant.total });
    expect(rep.json().items[0].prix_unitaire).toBe(avant.items[0]!.prix_unitaire);
  });

  it('déplace un produit déjà envoyé vers une autre commande sans retour', async () => {
    const source = await creerCommande({ type: 'EMPORTER' });
    const item = (await ajouter(source.id)).items[0]!;
    const envoi = await app.inject({ method: 'POST', url: `/api/commandes/${source.id}/envoyer`, cookies: caisse, payload: {} });
    expect(envoi.statusCode, envoi.body).toBe(200);
    const destination = await creerCommande({ type: 'SUR_PLACE', table_id: donnees.table2_id });

    const rep = await app.inject({
      method: 'POST', url: `/api/commandes/${source.id}/items/${item.id}/deplacer`, cookies: caisse,
      payload: { commande_destination_id: destination.id },
    });
    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.json().source_annulee).toBe(true);
    expect(rep.json().commande.items.map((x: { id: string }) => x.id)).toContain(item.id);
    const [sourceDb] = await db.select().from(commandes).where(eq(commandes.id, source.id));
    const [itemDb] = await db.select().from(commandeItems).where(eq(commandeItems.id, item.id));
    expect(sourceDb!.statut).toBe('ANNULEE');
    expect(itemDb!.commande_id).toBe(destination.id);
    expect(itemDb!.envoye_le).not.toBeNull();
    expect(itemDb!.statut_cuisine).not.toBe('ANNULE');
    const retours = await db.select().from(commandeItems).where(eq(commandeItems.statut_cuisine, 'ANNULE'));
    expect(retours).toHaveLength(0);
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'DEPLACEMENT_PRODUIT'));
    expect(traces).toHaveLength(1);
  });

  it('refuse le droit au serveur par défaut', async () => {
    const ouvertes = await app.inject({ method: 'GET', url: '/api/commandes/ouvertes', cookies: caisse });
    const id = ouvertes.json()[0].id as string;
    const rep = await app.inject({ method: 'POST', url: `/api/commandes/${id}/deplacer`, cookies: serveur, payload: { type: 'EMPORTER' } });
    expect(rep.statusCode).toBe(403);
  });
});
