import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog } from '../src/db/schema/index.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
let commandeId: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const c = await ouvrirServiceEtCommande(app, cookies, donnees, 2); // 2 × 3000 = 6000 F
  commandeId = c.commande_id;
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('facture (addition) avant paiement', () => {
  it('imprime la facture, trace l’impression et renvoie la vue', async () => {
    const rep = await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/facture`, cookies });
    expect(rep.statusCode).toBe(200);
    const vue = rep.json();
    expect(vue.total).toBe(6000);
    // Une facture ne fige pas la commande (reste encaissable)
    expect(vue.statut).not.toBe('PAYEE');

    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'FACTURE_IMPRIMEE'));
    expect(traces.length).toBe(1);
    expect(traces[0]!.entite_id).toBe(commandeId);
  });

  it('refuse la facture d’une commande sans article', async () => {
    const creation = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
    const vide = creation.json() as { id: string };
    const rep = await app.inject({ method: 'POST', url: `/api/commandes/${vide.id}/facture`, cookies });
    expect(rep.statusCode).toBe(400);
    expect(rep.json().erreur).toBe('Aucun article à facturer');
  });

  /**
   * Livraisons Yango/Glovo : rien ne s'imprime sur ce parcours. Le partenaire
   * facture le client à SES prix (plus élevés que la carte) et sa tablette sort
   * déjà le document — une facture de caisse annoncerait un montant qui n'est
   * pas celui payé. Samer Delly, lui, encaisse au comptoir : il la garde.
   */
  it('refuse la facture d’une livraison Yango/Glovo, mais pas d’une Samer Delly', async () => {
    const livraison = async (partenaire: string) => {
      const creation = await app.inject({
        method: 'POST',
        url: '/api/commandes',
        cookies,
        payload: { type: 'LIVRAISON', partenaire },
      });
      const id = creation.json().id as string;
      await app.inject({
        method: 'POST',
        url: `/api/commandes/${id}/items`,
        cookies,
        payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
      });
      return app.inject({ method: 'POST', url: `/api/commandes/${id}/facture`, cookies });
    };

    const yango = await livraison('YANGO');
    expect(yango.statusCode).toBe(400);
    expect(yango.json().erreur).toBe('Une livraison Yango/Glovo n’imprime pas de facture');

    const glovo = await livraison('GLOVO');
    expect(glovo.statusCode).toBe(400);

    const samerDelly = await livraison('SAMER_DELLY');
    expect(samerDelly.statusCode).toBe(200);
  });
});
