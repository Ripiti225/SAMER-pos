/**
 * Parcours client au QR (24/08/2026) : téléphone FACULTATIF à la commande,
 * points crédités au client identifié, reçu PDF après paiement.
 *
 * Règle arbitrée par le patron : on demande toujours le numéro, mais on ne
 * bloque JAMAIS la commande — celui qui n'en donne pas perd simplement ses
 * points, et doit le savoir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { SuiviCommandeClient } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { clientsFidelite, commandes, pointsFidelite } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_SERVEUR, resetDonnees, seConnecter, type Donnees } from './aide.js';

const TELEPHONE = '+2250701020304';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesCaissier: Record<string, string>;
let cookiesServeur: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  cookiesServeur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
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

/** Une proposition client depuis le QR de la table 1, téléphone optionnel. */
async function commanderAuQr(
  telephone?: string,
  qr = donnees.table_qr,
): Promise<{ statut: number; corps: { commande_id: string; fidelite: { rattache: boolean } } }> {
  const rep = await app.inject({
    method: 'POST',
    url: `/api/client/${qr}/commande`,
    payload: {
      items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
      ...(telephone === undefined ? {} : { telephone }),
    },
  });
  return { statut: rep.statusCode, corps: rep.json() };
}

/** Valide la proposition (serveur) puis encaisse le total (caisse). */
async function validerEtEncaisser(commandeId: string): Promise<number> {
  const validation = await app.inject({
    method: 'POST',
    url: `/api/commandes/${commandeId}/valider`,
    cookies: cookiesServeur,
  });
  expect(validation.statusCode, validation.body).toBe(200);
  const total = (validation.json() as { total: number }).total;

  const paiement = await app.inject({
    method: 'POST',
    url: `/api/commandes/${commandeId}/paiements`,
    cookies: cookiesCaissier,
    payload: { mode: 'ESPECES', montant: total },
  });
  expect(paiement.statusCode, paiement.body).toBe(200);
  return total;
}

describe('Téléphone facultatif à la commande client', () => {
  it('rattache la commande au client fidélité quand le numéro est donné', async () => {
    const { statut, corps } = await commanderAuQr(TELEPHONE);
    expect(statut).toBe(200);
    expect(corps.fidelite.rattache).toBe(true);

    const [c] = await db.select().from(commandes).where(eq(commandes.id, corps.commande_id));
    expect(c!.client_fidelite_id).not.toBeNull();

    const [client] = await db
      .select()
      .from(clientsFidelite)
      .where(eq(clientsFidelite.telephone, TELEPHONE));
    expect(client!.id).toBe(c!.client_fidelite_id);
  });

  it('accepte la commande sans numéro, sans rattachement fidélité', async () => {
    const { statut, corps } = await commanderAuQr();
    expect(statut).toBe(200);
    expect(corps.fidelite.rattache).toBe(false);

    const [c] = await db.select().from(commandes).where(eq(commandes.id, corps.commande_id));
    expect(c!.client_fidelite_id).toBeNull();
  });

  it('refuse un numéro mal formé plutôt que de le rattacher en silence', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/commande`,
      payload: {
        items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
        telephone: 'abc',
      },
    });
    expect(rep.statusCode).toBe(400);
    expect(rep.json().erreur).toContain('téléphone');
  });

  it('traite un champ téléphone laissé vide comme une absence de numéro', async () => {
    const { statut, corps } = await commanderAuQr('');
    expect(statut).toBe(200);
    expect(corps.fidelite.rattache).toBe(false);
  });
});

describe('Points crédités au client identifié au QR', () => {
  it('crédite les points de la vente une fois la commande payée', async () => {
    const { corps } = await commanderAuQr(TELEPHONE);
    const total = await validerEtEncaisser(corps.commande_id);

    const [client] = await db
      .select()
      .from(clientsFidelite)
      .where(eq(clientsFidelite.telephone, TELEPHONE));
    const lignes = await db
      .select()
      .from(pointsFidelite)
      .where(
        and(eq(pointsFidelite.commande_id, corps.commande_id), gt(pointsFidelite.points, 0)),
      );
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.client_id).toBe(client!.id);
    // Barème de test : 1 point par tranche de 1 000 FCFA.
    expect(lignes[0]!.points).toBe(Math.floor(total / 1000));
  });
});

describe('Suivi client après paiement', () => {
  it('montre la commande payée avec les points gagnés', async () => {
    const { corps } = await commanderAuQr(TELEPHONE, donnees.table2_qr);
    const total = await validerEtEncaisser(corps.commande_id);

    const rep = await app.inject({ method: 'GET', url: `/api/client/${donnees.table2_qr}/commandes` });
    expect(rep.statusCode).toBe(200);
    const suivi = (rep.json() as SuiviCommandeClient[]).find((s) => s.id === corps.commande_id);
    expect(suivi, 'la commande payée doit rester visible pour afficher le reçu').toBeDefined();
    expect(suivi!.etat).toBe('PAYEE');
    expect(suivi!.fidelite).toEqual({ rattache: true, points: Math.floor(total / 1000) });
  });

  it('annonce les points manqués quand aucun numéro n’a été donné', async () => {
    const { corps } = await commanderAuQr(undefined, donnees.table2_qr);
    const total = await validerEtEncaisser(corps.commande_id);

    const rep = await app.inject({ method: 'GET', url: `/api/client/${donnees.table2_qr}/commandes` });
    const suivi = (rep.json() as SuiviCommandeClient[]).find((s) => s.id === corps.commande_id);
    expect(suivi!.etat).toBe('PAYEE');
    // Le client doit voir ce qu'il a perdu : rattaché = non, mais points chiffrés.
    expect(suivi!.fidelite).toEqual({ rattache: false, points: Math.floor(total / 1000) });
  });
});

describe('Reçu PDF client', () => {
  it('refuse le reçu tant que la commande n’est pas payée', async () => {
    const { corps } = await commanderAuQr(TELEPHONE);
    const rep = await app.inject({
      method: 'GET',
      url: `/api/client/${donnees.table_qr}/recu/${corps.commande_id}`,
    });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toContain('payée');
  });

  it('refuse le reçu d’une commande qui n’est pas celle de la table du QR', async () => {
    const { corps } = await commanderAuQr(TELEPHONE);
    await validerEtEncaisser(corps.commande_id);

    const rep = await app.inject({
      method: 'GET',
      url: `/api/client/${donnees.table2_qr}/recu/${corps.commande_id}`,
    });
    expect(rep.statusCode).toBe(404);
  });

  it('sert un vrai PDF téléchargeable une fois la commande payée', async () => {
    const { corps } = await commanderAuQr(TELEPHONE);
    await validerEtEncaisser(corps.commande_id);

    const rep = await app.inject({
      method: 'GET',
      url: `/api/client/${donnees.table_qr}/recu/${corps.commande_id}`,
    });
    expect(rep.statusCode, rep.body).toBe(200);
    expect(rep.headers['content-type']).toContain('application/pdf');
    expect(rep.headers['content-disposition']).toContain('attachment');
    expect(rep.rawPayload.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(rep.rawPayload.length).toBeGreaterThan(800);
  });
});
