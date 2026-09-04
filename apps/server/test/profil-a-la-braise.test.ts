import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, fermerDb } from '../src/db/client.js';
import { articles, categories, inventaireConsommations, produitsInventaire, restaurant, tablesSalle, zones } from '../src/db/schema/index.js';
import { resetDonnees } from './aide.js';

interface Profil {
  code: string;
  restaurant: { nom: string; marque: string; telephone: string; google_maps: string };
  zones: { nom: string; tables: { numero: string; partenaire?: string }[] }[];
  categories: { nom: string; articles: { nom: string; prix: number }[] }[];
}

async function profil(): Promise<Profil> {
  const chemin = resolve(process.cwd(), '../../config/restaurants/a-la-braise/profil.json');
  return JSON.parse(await readFile(chemin, 'utf8')) as Profil;
}

describe('profil d’installation À la Braise', () => {
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

  it('décrit les 34 tables physiques et les 3 tables de livraison', async () => {
    const p = await profil();
    const tables = p.zones.flatMap((zone) => zone.tables);
    expect(tables.filter((table) => !table.partenaire)).toHaveLength(34);
    expect(tables.filter((table) => table.partenaire).map((table) => table.partenaire)).toEqual([
      'GLOVO', 'YANGO', 'LIVRAISON_DIRECTE',
    ]);
  });

  it('contient les prix corrigés et aucun montant fractionnaire', async () => {
    const p = await profil();
    const articles = p.categories.flatMap((categorie) => categorie.articles);
    const prix = (nom: string) => articles.find((article) => article.nom === nom)?.prix;
    expect(articles.length).toBeGreaterThanOrEqual(70);
    expect(prix('Poulet braisé de chair — entier')).toBe(8000);
    expect(prix('Poulet braisé hybride — entier')).toBe(10000);
    expect(prix('Carpe braisée — petite')).toBe(5000);
    expect(prix('Carpe braisée — grande')).toBe(6000);
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
    expect(await db.select().from(tablesSalle)).toHaveLength(37);
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
