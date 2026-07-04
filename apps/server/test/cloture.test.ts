import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
let serviceId: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const c = await ouvrirServiceEtCommande(app, cookies, donnees, 2); // 6000 F
  commandeId = c.commande_id;
  serviceId = c.service_id;
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('comptage à l’aveugle (§14.3)', () => {
  it('ne renvoie JAMAIS le théorique tant que le comptage n’est pas enregistré', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/services/courant', cookies });
    expect(rep.statusCode).toBe(200);
    const corps = rep.json();
    expect(corps).not.toHaveProperty('especes_theorique');
    expect(corps).not.toHaveProperty('ecart');
    expect(JSON.stringify(corps)).not.toContain('theorique');

    const repZ = await app.inject({ method: 'GET', url: `/api/services/${serviceId}/rapport-z`, cookies });
    expect(repZ.statusCode).toBe(409);
    expect(repZ.json().erreur).toContain('comptage');
  });

  it('refuse la clôture tant qu’une commande n’est pas encaissée', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 31000 },
    });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toContain('en cours');
  });

  it('calcule théorique et écart après la saisie, fige le rapport Z, audite l’écart', async () => {
    // Encaissement 6000 F en espèces
    const repPaiement = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 6000 },
    });
    expect(repPaiement.statusCode).toBe(200);
    expect(repPaiement.json().statut).toBe('PAYEE');

    // Théorique attendu : 25 000 (fond) + 6 000 (espèces) = 31 000.
    // Comptage 28 000 → écart -3 000, au-delà du seuil de 2 000.
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 28000 },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.especes_theorique).toBe(31000);
    expect(z.especes_comptees).toBe(28000);
    expect(z.ecart).toBe(-3000);
    expect(z.nb_commandes_payees).toBe(1);
    expect(z.total_ventes).toBe(6000);
    expect(z.par_mode.ESPECES).toBe(6000);

    const alertes = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ECART_CAISSE'), eq(auditLog.entite, 'services_caisse')));
    expect(alertes.length).toBe(1);
    expect(alertes[0]!.montant).toBe(-3000);

    // Le rapport Z est maintenant consultable (snapshot figé)
    const repZ = await app.inject({ method: 'GET', url: `/api/services/${serviceId}/rapport-z`, cookies });
    expect(repZ.statusCode).toBe(200);
    expect(repZ.json().ecart).toBe(-3000);
  });

  it('interdit le rapport X aux caissiers (MANAGER/PROPRIETAIRE uniquement)', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/services/${serviceId}/rapport-x`, cookies });
    expect(rep.statusCode).toBe(403);
  });
});
