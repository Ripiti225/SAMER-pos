import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, servicesCaisse } from '../src/db/schema/index.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_PROPRIO,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

beforeAll(async () => {
  app = await construireApp();
});

beforeEach(async () => {
  donnees = await resetDonnees();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

async function cloturerAvecCorrection(modes: Record<string, number>, especesComptees: number) {
  const service = await ouvrirServiceEtCommande(app, cookies, donnees, 1); // 3 000 F
  const paiement = await app.inject({
    method: 'POST',
    url: `/api/commandes/${service.commande_id}/paiements`,
    cookies,
    payload: { mode: 'ESPECES', montant: 3_000 },
  });
  expect(paiement.statusCode, paiement.body).toBe(200);
  await validerInventaire(app, cookies);

  const fermeture = await app.inject({
    method: 'POST',
    url: '/api/services/cloturer',
    cookies,
    payload: { especes_comptees: especesComptees, modes },
  });
  expect(fermeture.statusCode, fermeture.body).toBe(200);
  return { serviceId: service.service_id, rapport: fermeture.json() };
}

describe('écart réconcilié — seule anomalie réelle du point', () => {
  it('ne crée aucun litige quand une erreur espèces est corrigée en Wave au pointage', async () => {
    // Le ticket a été saisi à tort en espèces. Au comptage, les 3 000 F ne
    // sont pas dans le tiroir et la caissière les remet dans Wave : le détail
    // espèces est à -3 000 F, mais le point réconcilié tombe exactement juste.
    const { serviceId, rapport } = await cloturerAvecCorrection({ WAVE: 3_000 }, 25_000);
    expect(rapport.ecart).toBe(-3_000);
    expect(rapport.diff).toBe(0);

    const alertes = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'ECART_CAISSE'),
          eq(auditLog.entite, 'services_caisse'),
          eq(auditLog.entite_id, serviceId),
        ),
      );
    expect(alertes).toHaveLength(0);

    const remise = await app.inject({ method: 'POST', url: '/api/services/remettre-cloture', cookies });
    expect(remise.statusCode, remise.body).toBe(200);

    const cookiesProprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
    const tableau = await app.inject({
      method: 'GET',
      url: '/api/rapports/tableau-bord?periode=jour',
      cookies: cookiesProprio,
    });
    expect(tableau.statusCode, tableau.body).toBe(200);
    expect(tableau.json().ecarts_par_caissier).toContainEqual({
      nom: 'Caissier Test',
      ecart: 0,
      nb_services: 1,
    });

    const [service] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.id, serviceId));
    expect(service?.explication_ecart).toBeNull();
    expect(service?.remis_le).not.toBeNull();
  });

  it('exige une explication et audite un écart réconcilié même si le tiroir espèces est juste', async () => {
    // Le tiroir correspond exactement aux paiements espèces, mais 3 000 F de
    // Wave sont déclarés en trop : c'est cette différence globale qui est le
    // vrai litige, indépendamment de l'écart espèces égal à zéro.
    const { serviceId, rapport } = await cloturerAvecCorrection({ WAVE: 3_000 }, 28_000);
    expect(rapport.ecart).toBe(0);
    expect(rapport.diff).toBe(3_000);

    const alertes = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'ECART_CAISSE'),
          eq(auditLog.entite, 'services_caisse'),
          eq(auditLog.entite_id, serviceId),
        ),
      );
    expect(alertes).toHaveLength(1);
    expect(alertes[0]!.montant).toBe(3_000);

    const remise = await app.inject({ method: 'POST', url: '/api/services/remettre-cloture', cookies });
    expect(remise.statusCode, remise.body).toBe(400);
    expect(remise.json().erreur).toContain('écart réconcilié');
  });
});
