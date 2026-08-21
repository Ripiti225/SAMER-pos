/**
 * SPRINT 3 §E — simulation de pannes du moteur de synchro.
 * Objectif NON NÉGOCIABLE : zéro vente perdue, zéro doublon.
 * Un « faux cloud » HTTP mime sync-push / sync-reconcile avec UPSERT
 * idempotent par id, et sait simuler coupure / 500 / révocation / trou.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { syncOutbox } from '../src/db/schema/index.js';
import { ClientCloud, ErreurSync } from '../src/modules/sync/cloud-client.js';
import { prochainBackoff } from '../src/modules/sync/config.js';
import { etatSync } from '../src/modules/sync/etat.js';
import { pousserTout, pousserUnLot } from '../src/modules/sync/montee.js';
import { reconcilierJour } from '../src/modules/sync/reconcile.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, type Donnees } from './aide.js';

// ---------------------------------------------------------------------------
// Faux cloud
// ---------------------------------------------------------------------------
type Mode = 'normal' | 'coupure' | 'cinqcent' | 'revoque' | 'refus';

class FauxCloud {
  private serveur!: Server;
  url = '';
  mode: Mode = 'normal';
  echecsRestants = 0; // pour 500 intermittent
  pushRecus = 0;
  ordreSeq: number[] = [];
  private store = new Map<string, Map<string, Record<string, unknown>>>();

  nb(table: string): number {
    return this.store.get(table)?.size ?? 0;
  }
  supprimer(table: string, id: string): void {
    this.store.get(table)?.delete(id);
  }
  reinitialiser(): void {
    this.mode = 'normal';
    this.echecsRestants = 0;
    this.pushRecus = 0;
    this.ordreSeq = [];
    this.store.clear();
  }

  private appliquer(lignes: { seq: number; table_name: string; record_id: string; payload: Record<string, unknown> }[]): number {
    let ack = 0;
    for (const l of [...lignes].sort((a, b) => a.seq - b.seq)) {
      const t = this.store.get(l.table_name) ?? new Map();
      t.set(l.record_id, { ...l.payload, id: l.record_id }); // UPSERT idempotent par id
      this.store.set(l.table_name, t);
      this.ordreSeq.push(l.seq);
      ack = l.seq;
    }
    return ack;
  }

  async demarrer(): Promise<void> {
    this.serveur = createServer((req, res) => {
      let corps = '';
      req.on('data', (c) => (corps += c));
      req.on('end', () => {
        const body = corps ? JSON.parse(corps) : {};
        if (this.mode === 'revoque') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ erreur: 'Site non autorisé ou révoqué' }));
          return;
        }
        if (req.url === '/sync-push') {
          this.pushRecus += 1;
          if (this.mode === 'cinqcent' && this.echecsRestants > 0) {
            this.echecsRestants -= 1;
            res.writeHead(500);
            res.end('boom');
            return;
          }
          // Le cloud s'exécute (200) mais REFUSE tout : contrainte, schéma,
          // table inconnue. Rien n'est appliqué, rien n'est acquitté.
          if (this.mode === 'refus') {
            const premiere = [...(body.lignes ?? [])].sort(
              (a: { seq: number }, b: { seq: number }) => a.seq - b.seq,
            )[0];
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                acquitte_jusqua_seq: 0,
                blocage: premiere
                  ? {
                      seq: premiere.seq,
                      table_name: premiere.table_name,
                      raison: 'upsert commandes : there is no unique or exclusion constraint matching the ON CONFLICT specification',
                    }
                  : undefined,
              }),
            );
            return;
          }
          const ack = this.appliquer(body.lignes ?? []); // applique AVANT toute réponse
          if (this.mode === 'coupure') {
            res.socket?.destroy(); // réponse jamais reçue par le client
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ acquitte_jusqua_seq: ack }));
          return;
        }
        if (req.url === '/sync-reconcile') {
          const jour = body.jour as string;
          const commandes = [...(this.store.get('commandes')?.values() ?? [])].filter(
            (c) => c.statut === 'PAYEE' && String(c.created_at).slice(0, 10) === jour,
          );
          const totalCloud = commandes.reduce((s, c) => s + Number(c.total ?? 0), 0);
          const localTotal = Number(body.local?.total_ventes ?? 0);
          const ecart = localTotal - totalCloud;
          const statut = ecart === 0 && Number(body.local?.nb_payees ?? 0) === commandes.length ? 'OK' : 'ECART';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statut, total_cloud: totalCloud, nb_cloud: commandes.length, ecart }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((r) => this.serveur.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.serveur.address() as AddressInfo).port}`;
  }
  async arreter(): Promise<void> {
    await new Promise<void>((r) => this.serveur.close(() => r()));
  }
}

// ---------------------------------------------------------------------------
// Aides
// ---------------------------------------------------------------------------
let cloud: FauxCloud;
let client: ClientCloud;

async function viderOutbox(): Promise<void> {
  await db.delete(syncOutbox);
}

/** Insère n lignes outbox synthétiques (commandes), record_id distincts. */
async function insererOutbox(
  n: number,
  opts: { statut?: string; total?: number; created_at?: string } = {},
): Promise<string[]> {
  const ids: string[] = [];
  const valeurs = Array.from({ length: n }, () => {
    const id = randomUUID();
    ids.push(id);
    return {
      table_name: 'commandes',
      record_id: id,
      operation: 'INSERT' as const,
      payload: {
        id,
        statut: opts.statut ?? 'PAYEE',
        total: opts.total ?? 1000,
        created_at: opts.created_at ?? new Date().toISOString(),
      },
    };
  });
  // insertion par paquets pour les gros volumes
  for (let i = 0; i < valeurs.length; i += 500) {
    await db.insert(syncOutbox).values(valeurs.slice(i, i + 500));
  }
  return ids;
}

async function nbEnAttente(): Promise<number> {
  const [r] = await db.select({ n: sql<string>`COUNT(*)` }).from(syncOutbox).where(isNull(syncOutbox.synced_at));
  return Number(r?.n ?? 0);
}

beforeAll(async () => {
  // Repart d'une base propre : les autres fichiers de test laissent des lignes
  // dans l'outbox partagé.
  await resetDonnees();
  await viderOutbox();
  cloud = new FauxCloud();
  await cloud.demarrer();
  client = new ClientCloud(cloud.url, 'cle-de-test-1234567890');
});

afterAll(async () => {
  await cloud.arreter();
  await fermerDb();
});

afterEach(async () => {
  cloud.reinitialiser();
  Object.assign(etatSync, {
    echecs_consecutifs: 0,
    premier_echec: null,
    revoque: false,
    derniere_erreur: null,
    dernier_acquittement: null,
    lignes_en_attente: 0,
    derniere_reconciliation: null,
  });
  await viderOutbox();
});

describe('Panne 1 — coupure pendant l’envoi (réponse jamais reçue)', () => {
  it('le lot est renvoyé au cycle suivant, sans aucun doublon côté cloud', async () => {
    await insererOutbox(3);

    cloud.mode = 'coupure';
    await expect(pousserUnLot(client)).rejects.toBeInstanceOf(ErreurSync);
    // Rien marqué synced (zéro perte : on garde tout)
    expect(await nbEnAttente()).toBe(3);
    // Le cloud a bien REÇU et appliqué le lot (réponse perdue)
    expect(cloud.nb('commandes')).toBe(3);

    // Cycle suivant : renvoi du même lot → toujours 3 (idempotent), pas 6
    cloud.mode = 'normal';
    const r = await pousserUnLot(client);
    expect(r.fini).toBe(true);
    expect(cloud.nb('commandes')).toBe(3);
    expect(await nbEnAttente()).toBe(0);
  });
});

describe('Panne 2 — 500 par intermittence', () => {
  it('respecte le backoff et ne marque AUCUNE ligne synced à tort', async () => {
    await insererOutbox(4);
    cloud.mode = 'cinqcent';
    cloud.echecsRestants = 2;

    for (let essai = 0; essai < 2; essai++) {
      await expect(pousserUnLot(client)).rejects.toBeInstanceOf(ErreurSync);
      expect(await nbEnAttente()).toBe(4); // rien marqué
    }
    // Backoff progressif 30 s → 1 min → 5 min (plafonné)
    expect(prochainBackoff(1)).toBe(30_000);
    expect(prochainBackoff(2)).toBe(60_000);
    expect(prochainBackoff(3)).toBe(300_000);
    expect(prochainBackoff(9)).toBe(300_000);

    // 3e essai : le cloud répond 200 → tout est acquitté
    const r = await pousserUnLot(client);
    expect(r.fini).toBe(true);
    expect(await nbEnAttente()).toBe(0);
    expect(cloud.nb('commandes')).toBe(4);
  });
});

describe('Panne 3 — 48 h hors ligne (5 000 lignes)', () => {
  it('à la reconnexion, tout remonte dans l’ordre, une seule fois', async () => {
    await insererOutbox(5000);
    expect(await nbEnAttente()).toBe(5000);

    const envoye = await pousserTout(client);
    expect(envoye).toBe(5000);
    expect(await nbEnAttente()).toBe(0);
    expect(cloud.nb('commandes')).toBe(5000); // pas de doublon

    // Ordre strict par seq sur toute la remontée
    const ordonne = [...cloud.ordreSeq].every((v, i, a) => i === 0 || a[i - 1]! < v);
    expect(ordonne).toBe(true);
    expect(cloud.ordreSeq.length).toBe(5000);
  }, 30_000);
});

describe('Panne 4 — redémarrage brutal au milieu d’un cycle', () => {
  it('reprise propre : rien perdu, rien dupliqué', async () => {
    // 300 lignes > 1 lot (200) : le 1er lot est acquitté, puis « crash ».
    await insererOutbox(300);
    const r1 = await pousserUnLot(client); // 1 lot de 200
    expect(r1.fini).toBe(false);
    expect(cloud.nb('commandes')).toBe(200);
    expect(await nbEnAttente()).toBe(100); // 200 marqués synced, persistés en base

    // « Redémarrage » : on relit l'état depuis la base (synced_at) et on reprend.
    const r2 = await pousserUnLot(client);
    expect(r2.fini).toBe(true);
    expect(await nbEnAttente()).toBe(0);
    expect(cloud.nb('commandes')).toBe(300); // les 200 déjà envoyés ne repartent pas → pas de doublon
  });
});

describe('Panne 5 — clé de site révoquée', () => {
  it('montée refusée proprement (401), voyant rouge, aucune perte locale', async () => {
    await insererOutbox(3);
    cloud.mode = 'revoque';

    const erreur = await pousserUnLot(client).catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(ErreurSync);
    expect((erreur as ErreurSync).statut).toBe(401);
    expect((erreur as ErreurSync).estRevocation).toBe(true);

    // Le moteur consigne l'échec → voyant rouge, aucune ligne appliquée ni perdue
    etatSync.echecMontee((erreur as ErreurSync).message, true);
    expect(etatSync.voyant().couleur).toBe('rouge');
    expect(await nbEnAttente()).toBe(3);
    expect(cloud.nb('commandes')).toBe(0);
  });
});

describe('Panne 6 — réconciliation détecte un trou côté cloud', () => {
  let app: FastifyInstance;
  let donnees: Donnees;

  beforeAll(async () => {
    donnees = await resetDonnees();
    app = await construireApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('re-poussée automatique → écart résolu', async () => {
    await viderOutbox();
    const cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 25000 } });

    // 2 ventes réelles encaissées aujourd'hui
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
      const id = c.json().id as string;
      ids.push(id);
      await app.inject({
        method: 'POST',
        url: `/api/commandes/${id}/items`,
        cookies,
        payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
      });
      await app.inject({ method: 'POST', url: `/api/commandes/${id}/paiements`, cookies, payload: { mode: 'ESPECES', montant: 3000 } });
    }

    // Montée complète
    await pousserTout(client);
    expect(cloud.nb('commandes')).toBeGreaterThanOrEqual(2);

    // Trou artificiel : on supprime UNE commande côté cloud de test
    cloud.supprimer('commandes', ids[0]!);

    const jour = new Date().toISOString().slice(0, 10);
    const r = await reconcilierJour(client, jour);
    // reconcilierJour a détecté l'écart, re-poussé le jour, puis re-vérifié → OK
    expect(r.statut).toBe('OK');
    expect(etatSync.derniere_reconciliation?.statut).toBe('OK');
  });
});

describe('Panne 7 — le cloud répond 200 mais n’applique rien', () => {
  /**
   * La panne du 2026-08-17 en production : la `sync-push` déployée upsertait
   * sur `id` alors que le cloud était passé en PK composite. Elle répondait
   * 200 avec `acquitte_jusqua_seq: 0`. Le POS comptait ça comme un SUCCÈS :
   * file figée au même seq à chaque cycle, voyant au vert, et la caisse
   * répétait « ventes en attente » sans jamais dire pourquoi.
   */
  it('c’est un échec, pas un succès : rien n’est marqué et la raison est affichable', async () => {
    await insererOutbox(3);
    cloud.mode = 'refus';

    const erreur = await pousserUnLot(client).catch((e: unknown) => e);
    expect(erreur).toBeInstanceOf(ErreurSync);
    // Ni panne réseau ni révocation : l'appel a parfaitement abouti.
    expect((erreur as ErreurSync).estReseau).toBe(false);
    expect((erreur as ErreurSync).estRevocation).toBe(false);
    // La raison exacte doit arriver jusqu'à l'écran.
    expect((erreur as ErreurSync).message).toContain('ON CONFLICT');
    expect((erreur as ErreurSync).message).toContain('commandes');

    // Zéro perte : rien n'est marqué synchronisé.
    expect(await nbEnAttente()).toBe(3);
    expect(etatSync.dernier_acquittement).toBeNull();

    // Le voyant ne doit PAS dire « Hors ligne » : le cloud répondait très bien.
    etatSync.echecMontee((erreur as ErreurSync).message);
    etatSync.majEnAttente(3);
    const voyant = etatSync.voyant();
    expect(voyant.couleur).toBe('orange');
    expect(voyant.message).not.toContain('Hors ligne');
    expect(voyant.message).toContain('ON CONFLICT');

    // Le cloud réparé : tout repart, sans doublon.
    cloud.mode = 'normal';
    const r = await pousserUnLot(client);
    expect(r.fini).toBe(true);
    expect(await nbEnAttente()).toBe(0);
    expect(cloud.nb('commandes')).toBe(3);
  });
});
