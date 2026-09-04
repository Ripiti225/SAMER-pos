/**
 * Livraisons externes (Yango/Glovo) : réglées chez le partenaire, JAMAIS en
 * caisse. Elles se clôturent sans mode de paiement et sont comptées à part
 * (bucket « livraisons »), hors du théorique espèces. Samer Delly, livraison
 * propre du restaurant, encaisse normalement au comptoir.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrinterService } from '../src/printer/PrinterService.js';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, validerInventaire, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
/**
 * Espions sur les DEUX reçus de caisse possibles : une commande soldée d'un
 * coup passe par `imprimerSousNote` (le serveur crée tout seul une sous-note au
 * premier encaissement), les autres clôtures par `imprimerTicket`. Une livraison
 * Yango/Glovo ne doit déclencher ni l'un ni l'autre.
 */
let espionTicket: MockInstance<PrinterService['imprimerTicket']>;
let espionSousNote: MockInstance<PrinterService['imprimerSousNote']>;
/** Nombre de reçus partis à l'imprimante, tous formats confondus. */
const recusImprimes = () => espionTicket.mock.calls.length + espionSousNote.mock.calls.length;
const oublierRecus = () => { espionTicket.mockClear(); espionSousNote.mockClear(); };

/** Crée une commande d'un chawarma (3000) pour un type/partenaire donnés. */
async function commande(type: string, partenaire?: string): Promise<string> {
  const c = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: partenaire ? { type, partenaire } : { type },
  });
  const id = c.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
  });
  return id;
}

async function payerEspeces(id: string, montant: number) {
  return app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/paiements`,
    cookies,
    payload: { mode: 'ESPECES', montant },
  });
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  espionTicket = vi.spyOn(app.imprimante, 'imprimerTicket');
  espionSousNote = vi.spyOn(app.imprimante, 'imprimerSousNote');
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 25000 } });
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('Clôture d’une livraison externe (sans encaissement)', () => {
  it('Yango : la commande passe à PAYEE sans aucune ligne de paiement', async () => {
    const id = await commande('LIVRAISON', 'YANGO');
    oublierRecus();
    const rep = await app.inject({ method: 'POST', url: `/api/commandes/${id}/cloturer-livraison`, cookies });
    expect(rep.statusCode).toBe(200);
    const vue = rep.json();
    expect(vue.statut).toBe('PAYEE');
    expect(vue.paiements).toHaveLength(0);
    expect(vue.paye).toBe(0); // aucun encaissement : reste = total, réglé par le partenaire
    // Aucun reçu : la tablette du partenaire sort déjà le sien, et à des prix
    // canal plus élevés que la carte du restaurant. Le ticket partait à la
    // poubelle (décision du 2026-09-01).
    expect(recusImprimes()).toBe(0);
  });

  it('Samer Delly est refusé : il encaisse normalement en caisse', async () => {
    const id = await commande('LIVRAISON', 'SAMER_DELLY');
    const rep = await app.inject({ method: 'POST', url: `/api/commandes/${id}/cloturer-livraison`, cookies });
    expect(rep.statusCode).toBe(400);
    // …et il peut être payé normalement
    const paye = await payerEspeces(id, 3000);
    expect(paye.statusCode).toBe(200);
    expect(paye.json().statut).toBe('PAYEE');
  });

  it('une commande à emporter ne peut pas être clôturée par cette route', async () => {
    const id = await commande('EMPORTER');
    const rep = await app.inject({ method: 'POST', url: `/api/commandes/${id}/cloturer-livraison`, cookies });
    expect(rep.statusCode).toBe(400);
    oublierRecus();
    await payerEspeces(id, 3000); // soldée normalement pour ne pas bloquer la clôture
    // Non-régression : la suppression du reçu ne concerne QUE Yango/Glovo, un
    // encaissement normal imprime toujours le sien.
    expect(recusImprimes()).toBe(1);
  });
});

describe('Réconciliation : Yango à part, Samer Delly dans la caisse', () => {
  it('la clôture répartit correctement modes / livraisons / théorique', async () => {
    // État accumulé par les tests précédents (même service) :
    //  - Yango clôturée sans encaissement : 3000, HORS caisse ;
    //  - Samer Delly payée espèces : 3000, EN caisse ;
    //  - À emporter payée espèces : 3000, EN caisse.
    // On ajoute une dernière vente à emporter espèces (3000, EN caisse).
    await payerEspeces(await commande('EMPORTER'), 3000);

    // Aperçu de réconciliation : Yango dans livraisons, Samer Delly absent.
    const preview = await app.inject({ method: 'GET', url: '/api/services/reconciliation-preview', cookies });
    const p = preview.json();
    expect(p.livraisons.YANGO).toBe(3000);
    expect(p.livraisons.SAMER_DELLY).toBeUndefined();
    expect(p.modes.ESPECES).toBeUndefined(); // jamais révélé avant comptage

    // Théorique attendu = fond 25000 + espèces encaissées (3 × 3000 = 9000) =
    // 34000. Yango (3000) est comptée à part. On compte juste → écart 0, diff 0.
    await validerInventaire(app, cookies);
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      // `livraisons` volontairement FAUX : le montant partenaire n'est pas
      // modifiable (décision du 2026-08-15), le serveur ignore ce que la caisse
      // envoie et recalcule depuis les commandes payées.
      payload: { especes_comptees: 34000, livraisons: { YANGO: 999999 } },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.especes_theorique).toBe(34000);
    expect(z.ecart).toBe(0);
    expect(z.diff).toBe(0);
    // 4 commandes payées, 12000 de ventes ; 2 livraisons (Yango + Samer Delly).
    expect(z.total_ventes).toBe(12000);
    expect(z.par_type.LIVRAISON.nb).toBe(2);
    expect(z.livraisons.YANGO).toBe(3000); // le 999999 envoyé est bien ignoré
    expect(z.livraisons.SAMER_DELLY).toBeUndefined();
    // Récap partenaires (info) : les deux livraisons y figurent.
    expect(z.partenaires.YANGO.total).toBe(3000);
    expect(z.partenaires.SAMER_DELLY.total).toBe(3000);
  });
});

