/** Tests des corrections post-test terrain (docs/CORRECTIONS.md). */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as attendre } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { commandeItems, parametresLocaux, pointages } from '../src/db/schema/index.js';
import { JETON_KDS, PIN_CAISSIER, PIN_SERVEUR, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
let cookiesServeur: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  cookiesServeur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('correction 1 — délai de verrouillage caisse configurable (10 min par défaut)', () => {
  it('renvoie 600 s par défaut quand le paramètre est absent', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().verrouillage_inactivite_secondes).toBe(600);
  });

  it('lit la valeur définie par le manager dans parametres_locaux', async () => {
    await db
      .insert(parametresLocaux)
      .values({ cle: 'verrou_inactivite_caisse_secondes', valeur: 900 })
      .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: 900 } });

    const rep = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies });
    expect(rep.json().verrouillage_inactivite_secondes).toBe(900);
  });

  it('le déverrouillage par PIN ne touche ni à la session ni au service', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/services/ouvrir',
      cookies,
      payload: { fond_de_caisse: 10000 },
    });

    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/deverrouiller',
      cookies,
      payload: { pin: PIN_CAISSIER },
    });
    expect(rep.statusCode).toBe(200);

    // La session est toujours valable et le service toujours OUVERT
    const moi = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies });
    expect(moi.statusCode).toBe(200);
    expect(moi.json().service_ouvert).not.toBeNull();
  });
});

describe('correction 2 — la demande d’addition alerte la caisse (WebSocket)', () => {
  it('émet « table:addition_demandee » une seule fois, jamais au rejeu idempotent', async () => {
    // Commande en cours sur la table T1 (prise tablette)
    const envoi = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: cookiesServeur,
      payload: {
        action_uuid: randomUUID(),
        table_id: donnees.table_id,
        items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
      },
    });
    expect(envoi.statusCode).toBe(200);

    // Écoute WebSocket réelle (comme la caisse)
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const evenements: { type: string; id: string | null }[] = [];
    socket.on('message', (brut) => {
      evenements.push(JSON.parse(brut.toString()) as { type: string; id: string | null });
    });
    await new Promise<void>((resoudre, rejeter) => {
      socket.once('open', () => resoudre());
      socket.once('error', rejeter);
    });

    const actionUuid = randomUUID();
    const rep = await app.inject({
      method: 'POST',
      url: '/api/serveur/addition',
      cookies: cookiesServeur,
      payload: { action_uuid: actionUuid, table_id: donnees.table_id },
    });
    expect(rep.statusCode).toBe(200);
    await attendre(150);

    const additions = evenements.filter((e) => e.type === 'table:addition_demandee');
    expect(additions).toHaveLength(1);
    expect(additions[0]!.id).toBe(donnees.table_id);

    // Rejeu (coupure WiFi) : aucune nouvelle alerte — le son ne sonne qu'une fois
    const rejeu = await app.inject({
      method: 'POST',
      url: '/api/serveur/addition',
      cookies: cookiesServeur,
      payload: { action_uuid: actionUuid, table_id: donnees.table_id },
    });
    expect(rejeu.json().deja_traitee).toBe(true);
    await attendre(150);
    expect(evenements.filter((e) => e.type === 'table:addition_demandee')).toHaveLength(1);

    socket.close();
  });
});

describe('correction 3 — KDS sans PIN : jeton d’appareil, aucune donnée sensible', () => {
  it('refuse le KDS sans jeton ou avec un mauvais jeton', async () => {
    const sans = await app.inject({ method: 'GET', url: '/api/kds/commandes' });
    expect(sans.statusCode).toBe(403);
    expect(sans.json().erreur).toContain('jeton');

    const mauvais = await app.inject({
      method: 'GET',
      url: '/api/kds/commandes',
      headers: { 'x-jeton-kds': 'FAUX-JETON' },
    });
    expect(mauvais.statusCode).toBe(403);
  });

  it('ouvre la grille directement avec le jeton, sans session ni PIN', async () => {
    const rep = await app.inject({
      method: 'GET',
      url: '/api/kds/commandes',
      headers: { 'x-jeton-kds': JETON_KDS },
    });
    expect(rep.statusCode).toBe(200);
    const corps = rep.json();
    expect(corps.en_cuisine).toBeDefined();

    // Aucune donnée de caisse dans la réponse : ni prix, ni totaux, ni CA
    const brut = JSON.stringify(corps);
    expect(brut).not.toContain('"prix"');
    expect(brut).not.toContain('"total"');
    expect(brut).not.toContain('"sous_total"');
  });

  it('le jeton KDS ne donne accès à AUCUNE route sensible', async () => {
    const jeton = { 'x-jeton-kds': JETON_KDS };
    const rapports = await app.inject({ method: 'GET', url: '/api/rapports/jour', headers: jeton });
    expect(rapports.statusCode).toBe(401);

    const catalogue = await app.inject({ method: 'GET', url: '/api/catalogue', headers: jeton });
    expect(catalogue.statusCode).toBe(401);

    const utilisateursMoi = await app.inject({ method: 'GET', url: '/api/auth/moi', headers: jeton });
    expect(utilisateursMoi.statusCode).toBe(401);

    const paiement = await app.inject({
      method: 'POST',
      url: '/api/commandes/00000000-0000-0000-0000-000000000000/paiements',
      headers: jeton,
      payload: { mode: 'ESPECES', montant: 1000 },
    });
    expect(paiement.statusCode).toBe(401);
  });
});

describe('correction 4 — attribution automatique des plats par poste (mapping)', () => {
  const jeton = { 'x-jeton-kds': JETON_KDS };
  let commandeId: string;
  let itemChawarmaId: string;
  let itemPizzaId: string;

  it('au passage « Prêt », chaque plat est attribué au bon poste (fallback : tous actifs en poste)', async () => {
    // Envoi tablette : 1 chawarma (CUISINIER) + 1 pizza (PIZZAIOLO)
    const envoi = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: cookiesServeur,
      payload: {
        action_uuid: randomUUID(),
        table_id: donnees.table_id,
        items: [
          { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
          { article_id: donnees.pizza_id, quantite: 1, options: [], supplements: [] },
        ],
      },
    });
    expect(envoi.statusCode).toBe(200);
    commandeId = envoi.json().commande_id;

    const pret = await app.inject({
      method: 'POST',
      url: `/api/kds/commandes/${commandeId}/pret`,
      headers: jeton,
    });
    expect(pret.statusCode).toBe(200);

    const items = await db.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId));
    const chawarma = items.find((i) => i.article_id === donnees.article_id)!;
    const pizza = items.find((i) => i.article_id === donnees.pizza_id)!;
    itemChawarmaId = chawarma.id;
    itemPizzaId = pizza.id;

    // Aucun pointage → tous les employés cuisine actifs sont « en poste »
    expect(chawarma.attribue_a).toEqual([donnees.cuisine_id]);
    expect(pizza.attribue_a).toEqual([donnees.pizzaiolo_id]);
  });

  it('avec le pointage : seuls les employés pointés sont attribués, vide sinon (ne bloque jamais)', async () => {
    // Le cuisinier pointe son arrivée ; le pizzaiolo NON
    await db.insert(pointages).values({ user_id: donnees.cuisine_id, methode: 'PIN_POS' });

    // Reprendre puis re-Prêt → l'attribution est recalculée au moment de la préparation
    await app.inject({ method: 'POST', url: `/api/kds/commandes/${commandeId}/reprendre`, headers: jeton });
    const rePret = await app.inject({
      method: 'POST',
      url: `/api/kds/commandes/${commandeId}/pret`,
      headers: jeton,
    });
    expect(rePret.statusCode).toBe(200); // le service n'est jamais bloqué

    const items = await db.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId));
    expect(items.find((i) => i.id === itemChawarmaId)!.attribue_a).toEqual([donnees.cuisine_id]);
    // Personne du poste PIZZAIOLO n'est pointé → attribution vide, à rattacher plus tard
    expect(items.find((i) => i.id === itemPizzaId)!.attribue_a).toEqual([]);
  });
});
