import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, commandes } from '../src/db/schema/index.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_CAISSIER2,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesA: Record<string, string>;
let commandeId: string;
let serviceAId: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookiesA = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const c = await ouvrirServiceEtCommande(app, cookiesA, donnees, 2); // 6000 F, non encaissée
  commandeId = c.commande_id;
  serviceAId = c.service_id;
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('relève de caisse : transfert des commandes en cours au caissier suivant', () => {
  it('la clôture est refusée tant que la commande n’est ni encaissée ni transférée', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: cookiesA,
      payload: { especes_comptees: 25000 },
    });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toContain('transférez');
  });

  it('refuse le transfert si le PIN du receveur est faux (acceptation obligatoire)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/transferer',
      cookies: cookiesA,
      payload: { receveur_id: donnees.caissier2_id, pin_receveur: '9999' },
    });
    expect(rep.statusCode).toBe(401);
    expect(rep.json().erreur).toBe('PIN incorrect');
  });

  // Se transférer à SOI-MÊME est désormais permis (un caissier enchaîne deux
  // tranches : 16h-00h puis 00h-08h) et ne se teste pas ici, car cela détache
  // la commande du service et casserait la relève jouée dans ce fichier.
  // Voir test/shift-enchaine-et-notifs.test.ts.

  it('transfère avec le PIN du receveur, trace dans audit_log, puis autorise la clôture', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/transferer',
      cookies: cookiesA,
      payload: { receveur_id: donnees.caissier2_id, pin_receveur: PIN_CAISSIER2 },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().nb_transferees).toBe(1);
    expect(rep.json().receveur).toBe('Caissier Suivant');

    // La commande appartient au receveur, sans service tant qu'il n'en a pas ouvert
    const [c] = await db.select().from(commandes).where(eq(commandes.id, commandeId));
    expect(c!.caissier_id).toBe(donnees.caissier2_id);
    expect(c!.service_id).toBeNull();
    expect(c!.statut).not.toBe('PAYEE');

    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'TRANSFERT_COMMANDES'));
    expect(traces.length).toBe(1);
    expect(traces[0]!.montant).toBe(6000);
    expect((traces[0]!.meta as { receveur_id: string }).receveur_id).toBe(donnees.caissier2_id);

    // Le caissier A peut maintenant clôturer : aucune vente encaissée, écart nul
    await validerInventaire(app, cookiesA);
    const cloture = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: cookiesA,
      payload: { especes_comptees: 25000 },
    });
    expect(cloture.statusCode).toBe(200);
    expect(cloture.json().ecart).toBe(0);
    expect(cloture.json().nb_commandes_payees).toBe(0);
  });

  it('le receveur récupère la commande dans son service à l’ouverture et l’encaisse', async () => {
    const cookiesB = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);

    const ouverture = await app.inject({
      method: 'POST',
      url: '/api/services/ouvrir',
      cookies: cookiesB,
      payload: { fond_de_caisse: 10000 },
    });
    expect(ouverture.statusCode).toBe(200);
    const serviceBId = ouverture.json().id as string;
    expect(serviceBId).not.toBe(serviceAId);

    // La commande transférée est rattachée au nouveau service
    const [c] = await db.select().from(commandes).where(eq(commandes.id, commandeId));
    expect(c!.service_id).toBe(serviceBId);

    // Elle apparaît dans « Mes ventes » du receveur
    const ventes = await app.inject({ method: 'GET', url: '/api/rapports/mes-ventes', cookies: cookiesB });
    expect(ventes.json().commandes.map((x: { id: string }) => x.id)).toContain(commandeId);

    // Le receveur l'encaisse : le paiement compte dans SON service
    const paiement = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies: cookiesB,
      payload: { mode: 'ESPECES', montant: 6000 },
    });
    expect(paiement.statusCode).toBe(200);
    expect(paiement.json().statut).toBe('PAYEE');

    await validerInventaire(app, cookiesB);
    const cloture = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: cookiesB,
      payload: { especes_comptees: 16000 }, // 10 000 fond + 6 000 espèces
    });
    expect(cloture.statusCode).toBe(200);
    expect(cloture.json().especes_theorique).toBe(16000);
    expect(cloture.json().ecart).toBe(0);
    expect(cloture.json().total_ventes).toBe(6000);
  });
});
