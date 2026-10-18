import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, fermerDb } from '../src/db/client.js';
import { articles, categories, inventaireConsommations, produitsInventaire, restaurant, tablesSalle, zones } from '../src/db/schema/index.js';
import { resetDonnees } from './aide.js';
import { marqueRestaurant } from '../src/profils/marque.js';

interface Profil {
  code: string;
  restaurant: { nom: string; marque: string; telephone: string; google_maps: string };
  zones: { nom: string; tables: { numero: string; partenaire?: string }[] }[];
  categories: {
    nom: string;
    jour?: number;
    horaire?: { debut: string; fin: string };
    articles: { nom: string; prix: number }[];
  }[];
}

async function profil(): Promise<Profil> {
  const chemin = resolve(process.cwd(), '../../config/restaurants/a-la-braise/profil.json');
  return JSON.parse(await readFile(chemin, 'utf8')) as Profil;
}

describe('profil d’installation À la Braise', () => {
  it('reconnaît la marque renvoyée par SamerTrackly', () => {
    for (const nom of ['À la Braise', 'A la Braise chez Mapau', 'ALA_BRAISE']) {
      expect(marqueRestaurant(nom)).toBe('A_LA_BRAISE');
    }
    expect(marqueRestaurant('Chez Samer 7e')).toBe('SAMER');
    expect(marqueRestaurant('Al Kayan')).toBe('AL_KAYAN');
  });

  it('répare le profil déjà configuré sans changer son identifiant', async () => {
    await resetDonnees();
    await db.execute(sql`UPDATE restaurant SET code = 'A_LA_BRAISE_CHEZ_MAPAU', nom = 'À la Braise chez Mapau', marque = 'SAMER'`);
    const [avant] = await db.select().from(restaurant);
    if (!avant) throw new Error('Restaurant de test absent');
    const { importerProfilRestaurant } = await import('../src/profils/importer.js');
    await importerProfilRestaurant('ALA_BRAISE');
    const [apres] = await db.select().from(restaurant);
    expect(apres).toMatchObject({ id: avant.id, code: 'ALA_BRAISE', marque: 'A_LA_BRAISE' });
    expect((await db.execute(sql`SELECT COUNT(*)::int AS n FROM promotions`)).rows[0]).toMatchObject({ n: 0 });
  });

  it('refuse de remplacer le catalogue d’un autre restaurant', async () => {
    await resetDonnees();
    const avant = await db.select().from(articles);
    const { importerProfilRestaurant } = await import('../src/profils/importer.js');
    await expect(importerProfilRestaurant('ALA_BRAISE')).rejects.toThrow('appartient déjà');
    expect(await db.select().from(articles)).toEqual(avant);
  });

  it('refuse une commande même sans article et conserve le catalogue', async () => {
    await resetDonnees();
    await db.execute(sql`UPDATE restaurant SET code = 'ALA_BRAISE', nom = 'À la Braise'`);
    await db.execute(sql`INSERT INTO commandes(type) VALUES ('EMPORTER')`);
    const avant = await db.select().from(articles);
    const { importerProfilRestaurant } = await import('../src/profils/importer.js');
    await expect(importerProfilRestaurant('ALA_BRAISE')).rejects.toThrow('contient déjà des commandes');
    expect(await db.select().from(articles)).toEqual(avant);
  });
  it('porte l’identité et la localisation officielles', async () => {
    const p = await profil();
    expect(p.code).toBe('ALA_BRAISE');
    expect(p.restaurant).toMatchObject({
      nom: 'À la Braise',
      marque: 'A_LA_BRAISE',
      telephone: '07 01 11 11 18',
      google_maps: 'https://maps.app.goo.gl/fdjXuftprfN4RWQ27',
    });
  });

  it('décrit les 34 tables physiques, la table KDO en RC et les 3 tables de livraison', async () => {
    const p = await profil();
    const tables = p.zones.flatMap((zone) => zone.tables);
    expect(tables.filter((table) => !table.partenaire)).toHaveLength(34);
    expect(tables.filter((table) => table.partenaire).map((table) => table.partenaire)).toEqual([
      'KDO', 'GLOVO', 'YANGO', 'LIVRAISON_DIRECTE',
    ]);
    expect(p.zones.find((zone) => zone.nom === 'RC')?.tables).toContainEqual({ numero: 'KDO', partenaire: 'KDO' });
  });

  // 2026-09-25 : aucune plage horaire. Une catégorie hors plage refusait la
  // vente et rien au comptoir ne permettait de la rouvrir simplement — la carte
  // se pilote désormais par les jours et par « Plats du jour » (épuisé / dispo).
  it('ne pose aucun horaire et garde la sauce du jour sur les sept jours', async () => {
    const p = await profil();
    expect(p.categories.filter((categorie) => categorie.horaire)).toEqual([]);
    const sauces = p.categories.filter((categorie) => categorie.nom.startsWith('Sauces —'));
    expect(sauces).toHaveLength(8);
    // « Tous les jours » sans jour + un jour dédié pour chaque jour de la semaine.
    expect(sauces.filter((categorie) => categorie.jour === undefined)).toHaveLength(1);
    expect(sauces.map((categorie) => categorie.jour).filter(Boolean).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(p.categories.find((categorie) => categorie.nom === 'Placali et Cabato')?.horaire).toBeUndefined();
  });

  it('contient les prix corrigés et aucun montant fractionnaire', async () => {
    const p = await profil();
    const articles = p.categories.flatMap((categorie) => categorie.articles);
    const prix = (nom: string) => articles.find((article) => article.nom === nom)?.prix;
    expect(articles.length).toBeGreaterThanOrEqual(70);
    expect(prix('Poulet braisé de chair — entier')).toBe(8000);
    expect(prix('Poulet braisé hybride — entier')).toBe(10000);
    expect(prix('Lapin braisé')).toBe(10000);
    expect(prix('Demi lapin braisé')).toBe(6000);
    expect(prix('Kedjenou de lapin — entier')).toBe(10000);
    expect(prix('Soupe de machoiron')).toBe(7000);
    expect(prix('Salade classique')).toBe(2000);
    expect(prix('Salade composée')).toBe(3000);
    expect(prix('Spaghetti bolognaise')).toBe(3000);
    expect(prix('Carpe braisée — petite')).toBe(5000);
    expect(prix('Carpe braisée — grande')).toBe(6000);
    expect(p.categories.find((categorie) => categorie.nom === 'Kedjenou')?.articles.map((article) => article.nom)).toEqual(
      expect.arrayContaining(['Soupe de machoiron', 'Salade classique', 'Salade composée']),
    );
    expect(p.categories.find((categorie) => categorie.nom === 'Assiettes')?.articles.map((article) => article.nom)).toContain(
      'Spaghetti bolognaise',
    );
    expect(articles.every((article) => Number.isInteger(article.prix))).toBe(true);
  });

  it('s’importe deux fois sans doublon dans une base neuve', async () => {
    await resetDonnees();
    await db.execute(sql`UPDATE restaurant SET code = 'A_CONFIGURER', nom = 'Restaurant à configurer'`);
    const module = await import('../src/profils/importer.js');

    await module.importerProfilRestaurant('ALA_BRAISE');
    await module.importerProfilRestaurant('ALA_BRAISE');

    const [identite] = await db.select().from(restaurant);
    expect(identite).toMatchObject({ code: 'ALA_BRAISE', nom: 'À la Braise', marque: 'A_LA_BRAISE' });
    expect(await db.select().from(zones)).toHaveLength(4);
    expect(await db.select().from(tablesSalle)).toHaveLength(38);
    expect(await db.select().from(categories)).toHaveLength(15);
    expect((await db.select().from(articles)).length).toBeGreaterThanOrEqual(70);
    expect(await db.select().from(produitsInventaire)).toHaveLength(5);
    const consommations = await db.select().from(inventaireConsommations);
    expect(consommations).toHaveLength(8);
    expect(consommations.filter((c) => c.quantite === '0.500')).toHaveLength(2);
  });
});

afterAll(async () => {
  await fermerDb();
});
