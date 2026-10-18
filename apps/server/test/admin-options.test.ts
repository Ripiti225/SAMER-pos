import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, optionsCatalogue, optionsLiaisons, syncOutbox } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_PROPRIO, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let proprio: Record<string, string>;
let caissier: Record<string, string>;
const ids: string[] = [];

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  proprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  vi.restoreAllMocks();
  for (const id of ids) await db.delete(optionsCatalogue).where(eq(optionsCatalogue.id, id));
  await app?.close();
  await fermerDb();
});

async function creer(nom: string, prix: number) {
  const rep = await app.inject({ method: 'POST', url: '/api/admin/options', cookies: proprio, payload: { nom, prix } });
  expect(rep.statusCode, rep.body).toBe(200);
  ids.push(rep.json().id);
  return rep.json().id as string;
}

describe('enregistrement des options locales', () => {
  it.each([0, 500])('crée une option à %i FCFA sans accès réseau, avec audit et outbox', async (prix) => {
    const reseau = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Réseau indisponible'));
    try {
      const nom = `Option diagnostic ${prix}`;
      const id = await creer(nom, prix);
      const [option] = await db.select().from(optionsCatalogue).where(eq(optionsCatalogue.id, id));
      expect(option).toMatchObject({ nom, prix, actif: true });
      const [audit] = await db.select().from(auditLog).where(eq(auditLog.entite_id, id));
      expect(audit).toMatchObject({ action: 'MODIF_CATALOGUE', user_id: donnees.proprio_id, montant: prix });
      const [sortie] = await db.select().from(syncOutbox).where(eq(syncOutbox.record_id, id));
      expect(sortie).toMatchObject({ table_name: 'options_catalogue', operation: 'INSERT', payload: { nom, prix } });
      expect(reseau).not.toHaveBeenCalled();
    } finally {
      reseau.mockRestore();
    }
  });

  it('refuse un doublon de nom/prix avec un message explicite, sans écriture supplémentaire', async () => {
    await creer('Option doublon', 750);
    const avant = await db.select().from(syncOutbox);
    const rep = await app.inject({ method: 'POST', url: '/api/admin/options', cookies: proprio, payload: { nom: ' OPTION DOUBLON ', prix: 750 } });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toBe('Cette option existe déjà avec ce prix');
    expect((await db.select().from(syncOutbox)).length).toBe(avant.length);
  });

  it('refuse une modification qui duplique une autre option, en conservant son ancien nom', async () => {
    await creer('Option cible', 1250);
    const id = await creer('Option à modifier', 1250);
    const rep = await app.inject({ method: 'PATCH', url: `/api/admin/options/${id}`, cookies: proprio, payload: { nom: 'Option cible' } });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toBe('Une autre option porte déjà ce nom à ce prix');
    const [option] = await db.select().from(optionsCatalogue).where(eq(optionsCatalogue.id, id));
    expect(option?.nom).toBe('Option à modifier');
  });

  it('lie une option à un article, puis refuse la même liaison avec un message explicite', async () => {
    const id = await creer('Option liée', 1000);
    const requete = { method: 'POST' as const, url: `/api/admin/options/${id}/liaisons`, cookies: proprio, payload: { article_id: donnees.article_id } };
    expect((await app.inject(requete)).statusCode).toBe(200);
    const rep = await app.inject(requete);
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toBe('Cette liaison existe déjà');
    expect(await db.select().from(optionsLiaisons).where(eq(optionsLiaisons.option_id, id))).toHaveLength(1);
  });

  it('refuse la création sans permission et refuse un prix négatif', async () => {
    const refuse = await app.inject({ method: 'POST', url: '/api/admin/options', cookies: caissier, payload: { nom: 'Interdite', prix: 500 } });
    expect(refuse.statusCode).toBe(403);
    const invalide = await app.inject({ method: 'POST', url: '/api/admin/options', cookies: proprio, payload: { nom: 'Invalide', prix: -1 } });
    expect(invalide.statusCode).toBe(400);
    expect(invalide.json().erreur).toBe('Le prix ne peut pas être négatif');
  });
});
