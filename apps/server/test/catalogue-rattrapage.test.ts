import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { db, fermerDb } from '../src/db/client.js';
import { restaurant, syncEtat, syncOutbox } from '../src/db/schema/index.js';
import { preparerRattrapageCatalogueHistorique } from '../src/modules/sync/catalogue-historique.js';
import { resetDonnees } from './aide.js';

beforeEach(async () => {
  await resetDonnees();
});

afterAll(async () => {
  await fermerDb();
});

describe('publication ponctuelle du catalogue historique', () => {
  it('place catégories puis articles dans un paquet unique et ne le prépare qu’une fois', async () => {
    const [site] = await db.select().from(restaurant).limit(1);

    const premier = await preparerRattrapageCatalogueHistorique();
    const second = await preparerRattrapageCatalogueHistorique();

    expect(premier).toEqual({ prepare: true, categories: 2, articles: 2 });
    expect(second).toEqual({ prepare: false, categories: 0, articles: 0 });

    const paquets = await db
      .select()
      .from(syncOutbox)
      .where(eq(syncOutbox.table_name, 'catalogue_historique'));
    expect(paquets).toHaveLength(1);
    expect(paquets[0]!.record_id).toBe(site!.id);

    const payload = paquets[0]!.payload as {
      categories: { id: string; nom: string }[];
      articles: { id: string; categorie_id: string; nom: string }[];
    };
    expect(payload.categories.map((categorie) => categorie.nom).sort()).toEqual(['Chawarmas', 'Pizzas']);
    expect(payload.articles.map((article) => article.nom).sort()).toEqual(['Chawarma Poulet', 'Pizza Test']);
    expect(payload.articles.every((article) => payload.categories.some((categorie) => categorie.id === article.categorie_id))).toBe(true);

    const [marqueur] = await db
      .select()
      .from(syncEtat)
      .where(eq(syncEtat.flux, `CATALOGUE_HISTORIQUE_PREPARE:${site!.id}`));
    expect(marqueur?.version).toBe(1);
  });

  it('prépare un nouveau paquet si le poste reçoit une nouvelle identité de restaurant', async () => {
    const [ancienSite] = await db.select().from(restaurant).limit(1);
    await preparerRattrapageCatalogueHistorique();

    const nouvelId = randomUUID();
    await db.update(restaurant).set({ id: nouvelId }).where(eq(restaurant.id, ancienSite!.id));
    const apresReenrolement = await preparerRattrapageCatalogueHistorique();

    expect(apresReenrolement.prepare).toBe(true);
    const paquets = await db
      .select({ record_id: syncOutbox.record_id })
      .from(syncOutbox)
      .where(eq(syncOutbox.table_name, 'catalogue_historique'));
    expect(paquets.map((paquet) => paquet.record_id).sort()).toEqual([ancienSite!.id, nouvelId].sort());
  });
});
