/**
 * Migration 0045 (QCM du propriétaire, 2026-10-26) rejouée sur un site qui a
 * déjà vécu : brochettes poulet ET viande en stock, recettes posées, Darina
 * à 9. Les migrations tournent sur une base vide au lancement des tests ; ici
 * on remet le site dans l'état d'avant, puis on exécute le fichier tel quel.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, fermerDb } from '../src/db/client.js';
import {
  articles, categories, entreesStock, inventaireConsommations, inventaireLignes, inventairesService,
  produitsInventaire, servicesCaisse,
} from '../src/db/schema/index.js';
import { resetDonnees, type Donnees } from './aide.js';

let donnees: Donnees;
const MIGRATION = readFileSync(new URL('../drizzle/0045_recettes_brochette_darina.sql', import.meta.url), 'utf8');

const produit = async (code: string) =>
  (await db.select().from(produitsInventaire).where(eq(produitsInventaire.code, code)))[0]!;
const recette = async (code: string, articleId: string) => {
  const p = await produit(code);
  return (await db.select().from(inventaireConsommations)
    .where(and(eq(inventaireConsommations.produit_id, p.id), eq(inventaireConsommations.article_id, articleId))))[0];
};

let ids: Record<string, string>;
let ouvert: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  await db.insert(produitsInventaire).values([
    { code: 'a10', categorie: 'PLAT', nom: 'Brochette poulet', role: 'COMPTE' },
    { code: 'a11', categorie: 'PLAT', nom: 'Brochette viande', role: 'COMPTE' },
    { code: 'b7', categorie: 'BOIS', nom: 'Darina', role: 'DARINA', ratio: '9' },
    { code: 'b4', categorie: 'BOIS', nom: 'Boisson 1000f', role: 'COMPTE' },
    { code: 'b5', categorie: 'BOIS', nom: 'Boisson 1500f', role: 'COMPTE' },
    { code: 'b8', categorie: 'BOIS', nom: 'Thé', role: 'COMPTE' },
    { code: 'p1', categorie: 'PAIN', nom: 'Pain chawarma', role: 'COMPTE' },
    { code: 'p2', categorie: 'PAIN', nom: 'Pain burger', role: 'COMPTE' },
    { code: 'pl3', categorie: 'PLAT', nom: 'Chicken burger', role: 'COMPTE' },
    { code: 'pl4', categorie: 'PLAT', nom: 'Viande burger', role: 'COMPTE' },
    { code: 'fr1', categorie: 'FRIT', nom: 'Portions de frites', role: 'CONSO_FRITES', ratio: '8' },
  ]);
  const [cat] = await db.insert(categories).values({ nom: 'Carte QCM', ordre: 99 }).returning();
  const noms = ['Brochette Frites', 'Brochette Viande', 'Boisson', 'Cody’s Énergie', "Cody's Malta",
    'Bavaria (Bouteille)', 'Thé Infusion', 'Assiette Chicken', 'Assiette Hamburger', 'Assiette Chawarma'];
  const arts = await db.insert(articles)
    .values(noms.map((nom) => ({ categorie_id: cat!.id, nom, prix_base: 1000 }))).returning();
  ids = Object.fromEntries(arts.map((a) => [a.nom, a.id]));

  // Recettes d'avant : frites sur la Brochette Frites, un plat lié à la viande,
  // et une Assiette Hamburger déjà réglée à la main (pain seul).
  const [fr1, a11, p2] = [await produit('fr1'), await produit('a11'), await produit('p2')];
  await db.insert(inventaireConsommations).values([
    { produit_id: fr1.id, article_id: ids['Brochette Frites']!, quantite: '1' },
    { produit_id: a11.id, article_id: ids['Brochette Viande']!, quantite: '1' },
    { produit_id: p2.id, article_id: ids['Assiette Hamburger']!, quantite: '1' },
  ]);

  // Deux shifts : un clôturé avec inventaire validé, un en cours.
  const a10 = await produit('a10');
  const [s1, s2] = await db.insert(servicesCaisse).values([
    { caissier_id: donnees.caissier_id, fond_de_caisse: 0, statut: 'CLOTURE', cloture_le: new Date() },
    { caissier_id: donnees.caissier2_id, fond_de_caisse: 0 },
  ]).returning();
  const [valide, enCours] = await db.insert(inventairesService).values([
    { service_id: s1!.id, valide: true, valide_le: new Date() },
    { service_id: s2!.id },
  ]).returning();
  ouvert = enCours!.id;
  await db.insert(inventaireLignes).values([
    { inventaire_id: valide!.id, produit_id: a10.id, stock_compte: '4' },
    { inventaire_id: valide!.id, produit_id: a11.id, stock_compte: '3' },
    { inventaire_id: ouvert, produit_id: a10.id, stock_initial: '4' },
    { inventaire_id: ouvert, produit_id: a11.id, stock_initial: '3' },
  ]);
  await db.insert(entreesStock).values({ inventaire_id: ouvert, produit_id: a11.id, quantite: '10' });

  // Le fichier, tel que drizzle l'exécute : instruction par instruction.
  for (const instruction of MIGRATION.split('--> statement-breakpoint')) {
    if (instruction.trim()) await db.execute(sql.raw(instruction));
  }
});

afterAll(fermerDb);

it('fusionne les brochettes : un seul produit, stock et réceptions additionnés', async () => {
  const [a10, a11] = [await produit('a10'), await produit('a11')];
  expect(a10.nom).toBe('Brochette');
  expect(a11.actif).toBe(false);

  const lignes = await db.select().from(inventaireLignes).where(eq(inventaireLignes.produit_id, a10.id));
  const parInventaire = new Map(lignes.map((l) => [l.inventaire_id, l]));
  expect(Number(parInventaire.get(ouvert)!.stock_initial)).toBe(7);
  expect(lignes.some((l) => Number(l.stock_compte) === 7)).toBe(true);

  const [entree] = await db.select().from(entreesStock).where(eq(entreesStock.inventaire_id, ouvert));
  expect(entree!.produit_id).toBe(a10.id);

  // Le plat qui consommait la viande consomme la Brochette ; plus rien sur a11.
  expect(await recette('a10', ids['Brochette Viande']!)).toBeDefined();
  expect(await db.select().from(inventaireConsommations).where(eq(inventaireConsommations.produit_id, a11.id))).toEqual([]);
});

it('applique les choix du QCM sans toucher une recette posée à la main', async () => {
  expect(Number((await produit('b7')).ratio)).toBe(8);

  expect(Number((await recette('a10', ids['Brochette Frites']!))!.quantite)).toBe(1);
  expect(await recette('fr1', ids['Brochette Frites']!)).toBeDefined();
  expect(await recette('b4', ids.Boisson!)).toBeDefined();
  expect(await recette('b4', ids['Cody’s Énergie']!)).toBeDefined();
  expect(await recette('b5', ids["Cody's Malta"]!)).toBeDefined();
  expect(await recette('b5', ids['Bavaria (Bouteille)']!)).toBeDefined();
  expect(await recette('b8', ids['Thé Infusion']!)).toBeDefined();
  expect(await recette('p2', ids['Assiette Chicken']!)).toBeDefined();
  expect(await recette('pl3', ids['Assiette Chicken']!)).toBeDefined();
  expect(Number((await recette('p1', ids['Assiette Chawarma']!))!.quantite)).toBe(2);

  // Assiette Hamburger avait déjà sa recette : elle reste telle quelle.
  expect(await recette('pl4', ids['Assiette Hamburger']!)).toBeUndefined();
});

it('rejouée une seconde fois, ne change plus rien', async () => {
  const avant = await db.select().from(inventaireConsommations);
  for (const instruction of MIGRATION.split('--> statement-breakpoint')) {
    if (instruction.trim()) await db.execute(sql.raw(instruction));
  }
  expect((await db.select().from(inventaireConsommations)).length).toBe(avant.length);
  const lignes = await db.select().from(inventaireLignes).where(eq(inventaireLignes.inventaire_id, ouvert));
  const a10 = await produit('a10');
  expect(Number(lignes.find((l) => l.produit_id === a10.id)!.stock_initial)).toBe(7);
});
