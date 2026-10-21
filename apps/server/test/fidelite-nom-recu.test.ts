/**
 * Nom du client fidélité et solde sur le reçu (21/10/2026).
 *
 * Le nom est facultatif, saisi au paiement ; il sert au tirage au sort
 * mensuel du siège. Le solde s'imprime sur le reçu : c'est là qu'un client
 * MTN ou Moov voit ses points, le SMS ne partant que vers Orange.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, clientsFidelite, syncOutbox } from '../src/db/schema/index.js';
import { fideliteRecu } from '../src/printer/escpos.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
const TEL = '0501020304';

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 25000 } });
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

/** Commande d'un chawarma (3 000), client rattaché, payée en espèces. */
async function venteAvecClient(): Promise<{ commandeId: string; clientId: string }> {
  const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
  const commandeId = c.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/api/commandes/${commandeId}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
  });
  const r = await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/fidelite`, cookies, payload: { telephone: TEL } });
  const clientId = r.json().commande.client_fidelite_id as string;
  const p = await app.inject({
    method: 'POST',
    url: `/api/commandes/${commandeId}/paiements`,
    cookies,
    payload: { mode: 'ESPECES', montant: 3000 },
  });
  expect(p.statusCode).toBe(200);
  return { commandeId, clientId };
}

const nommer = (id: string, nom: string) =>
  app.inject({ method: 'PATCH', url: `/api/clients-fidelite/${id}`, cookies, payload: { nom } });

describe('Nom du client fidélité', () => {
  let clientId = '';

  it('enregistre le nom, le trace au journal et le fait remonter au cloud', async () => {
    ({ clientId } = await venteAvecClient());
    const rep = await nommer(clientId, '  Awa Koné ');
    expect(rep.statusCode).toBe(200);
    expect(rep.json().nom).toBe('Awa Koné');

    const [client] = await db.select().from(clientsFidelite).where(eq(clientsFidelite.id, clientId));
    expect(client!.nom).toBe('Awa Koné');
    const journal = await db.select().from(auditLog).where(and(eq(auditLog.action, 'NOM_CLIENT'), eq(auditLog.entite_id, clientId)));
    expect(journal).toHaveLength(1);
    const outbox = await db
      .select()
      .from(syncOutbox)
      .where(and(eq(syncOutbox.table_name, 'clients_fidelite'), eq(syncOutbox.record_id, clientId), eq(syncOutbox.operation, 'UPDATE')));
    expect(outbox.length).toBeGreaterThan(0);
  });

  it('une saisie vide efface le nom, un nom trop long est refusé', async () => {
    expect((await nommer(clientId, '')).json().nom).toBeNull();
    expect((await nommer(clientId, 'x'.repeat(61))).statusCode).toBe(400);
  });

  it('refuse un client inconnu', async () => {
    const rep = await nommer('00000000-0000-0000-0000-000000000000', 'Personne');
    expect(rep.statusCode).toBe(404);
  });
});

describe('Solde sur le reçu', () => {
  it('donne le nom et le solde APRÈS la vente, en points et en francs', async () => {
    const { clientId } = await venteAvecClient();
    await nommer(clientId, 'Awa');
    const f = await fideliteRecu(clientId);
    // 2 ventes de 3 000 F au barème de test (1 pt / 1 000 F, 1 pt = 10 F).
    expect(f).toEqual({ nom: 'Awa', solde: 6, valeur_fcfa: 60 });
  });

  it('rien sans client rattaché', async () => {
    expect(await fideliteRecu(null)).toBeNull();
  });
});
