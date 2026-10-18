/**
 * Relève (§ 6.8) : qui est marqué « Reste » au shift qu'on clôture doit être
 * PRÉ-PROPOSÉ au shift suivant, sans qu'on ait à le rajouter à la main.
 *
 * Le drapeau `reste` était écrit et compté depuis toujours, mais rien ne le
 * relisait à l'ouverture suivante — c'est ce chaînon qui est testé ici.
 *
 * Le test couvre aussi la BORNE DE FRAÎCHEUR, qui est la partie risquée : un
 * pré-coché voit son arrivée datée de l'ouverture, et cette heure sert à la
 * paie. Une clôture trop ancienne ne doit donc plus rien proposer, sans quoi
 * rouvrir la caisse le lendemain créditerait des heures à des absents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { equipeService, servicesCaisse } from '../src/db/schema/index.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, validerInventaire, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

interface Propose {
  utilisateur_id: string;
  poste_defaut: string;
  reste_precedent: boolean;
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

/** Ouvre un service avec le serveur et le cuisinier, marque leurs départs, clôture. */
async function shiftAvecReleve(): Promise<void> {
  const ouvert = await app.inject({
    method: 'POST',
    url: '/api/services/ouvrir',
    cookies,
    payload: {
      fond_de_caisse: 25000,
      equipe: [
        { utilisateur_id: donnees.serveur_id, poste_jour: 'COMPTOIRISTE' },
        { utilisateur_id: donnees.cuisine_id, poste_jour: 'CUISINIER' },
      ],
    },
  });
  expect(ouvert.statusCode).toBe(200);

  // Le serveur reste ; le cuisinier part.
  for (const [id, reste] of [
    [donnees.serveur_id, true],
    [donnees.cuisine_id, false],
  ] as const) {
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/pointage/${id}/depart`,
      cookies,
      payload: { reste },
    });
    expect(rep.statusCode).toBe(200);
  }

  await validerInventaire(app, cookies);
  const fin = await app.inject({
    method: 'POST',
    url: '/api/services/cloturer',
    cookies,
    payload: { especes_comptees: 25000 },
  });
  expect(fin.statusCode).toBe(200);
}

describe('relève : report de « Reste » sur le shift suivant', () => {
  it('pré-propose qui restait, avec le poste qu’il tenait, et pas les autres', async () => {
    await shiftAvecReleve();

    const rep = await app.inject({ method: 'GET', url: '/api/services/equipe-proposee', cookies });
    expect(rep.statusCode).toBe(200);
    const props = rep.json() as Propose[];

    const serveur = props.find((p) => p.utilisateur_id === donnees.serveur_id)!;
    expect(serveur.reste_precedent).toBe(true);
    // Le poste du shift précédent prime sur le poste théorique : le serveur
    // tenait le comptoir, il ne redevient pas SERVEUR en passant la relève.
    expect(serveur.poste_defaut).toBe('COMPTOIRISTE');

    // Parti : proposé comme tout le monde, mais PAS pré-coché.
    const cuisinier = props.find((p) => p.utilisateur_id === donnees.cuisine_id)!;
    expect(cuisinier.reste_precedent).toBe(false);

    // Jamais pointé sur ce service : rien à reporter.
    const caissier = props.find((p) => p.utilisateur_id === donnees.caissier_id)!;
    expect(caissier.reste_precedent).toBe(false);
  });

  it('ne reporte plus rien passé une durée de service (l’heure compte pour la paie)', async () => {
    // La clôture est reculée de 9 h : au-delà des 8 h d'un service, la relève
    // n'en est plus une. On agit sur la donnée, pas sur l'horloge du test.
    await db
      .update(servicesCaisse)
      .set({ cloture_le: sql`now() - interval '9 hours'` })
      .where(eq(servicesCaisse.statut, 'CLOTURE'));

    const rep = await app.inject({ method: 'GET', url: '/api/services/equipe-proposee', cookies });
    const props = rep.json() as Propose[];
    expect(props.some((p) => p.reste_precedent)).toBe(false);

    // Le drapeau est toujours en base : c'est bien la borne qui filtre, et non
    // une donnée perdue en route.
    const restants = await db
      .select({ id: equipeService.id })
      .from(equipeService)
      .where(and(eq(equipeService.utilisateur_id, donnees.serveur_id), eq(equipeService.reste, true)));
    expect(restants.length).toBe(1);
  });
});
