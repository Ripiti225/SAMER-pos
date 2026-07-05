/**
 * Importateur du vrai catalogue (export SAMER DELIV) — `pnpm catalogue:importer`.
 *
 * Deux cibles :
 *   --cible=local  : remplace le catalogue de la base POS locale (par défaut).
 *   --cible=cloud  : génère un fichier SQL à coller dans l'éditeur SQL Supabase
 *                    (le serveur local n'a pas les accès DB du cloud).
 *
 * Remplacement ENTIER : l'ancien catalogue (démo) est retiré, le nouveau chargé.
 * Les UUID de l'export sont réutilisés comme ids (cohérence local ↔ cloud).
 * Champs mappés : categories{id,nom,ordre,active→actif},
 *   produits{id,nom,description,prix→prix_base,photo_url→image_url,disponible}.
 * Champs ignorés (pas dans notre schéma) : allergenes, populaire,
 *   temps_preparation_min.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, fermerDb, pool } from '../db/client.js';
import { articles, categories, restaurant } from '../db/schema/index.js';

interface Produit {
  id: string;
  nom: string;
  description: string | null;
  prix: number;
  photo_url: string | null;
  disponible: boolean;
}
interface Categorie {
  id: string;
  nom: string;
  ordre: number;
  active: boolean;
  produits: Produit[];
}
interface Export {
  categories: Categorie[];
}

function arg(nom: string, defaut: string): string {
  const a = process.argv.find((x) => x.startsWith(`--${nom}=`));
  return a ? a.slice(nom.length + 3) : defaut;
}

function lireExport(chemin: string): Export {
  let brut: string;
  try {
    brut = readFileSync(chemin, 'utf8');
  } catch {
    console.error(`Fichier introuvable : ${chemin}`);
    console.error('Enregistrez l’export complet du catalogue (JSON) à cet emplacement, puis relancez.');
    process.exit(1);
  }
  const donnees = JSON.parse(brut) as Export;
  if (!Array.isArray(donnees.categories)) {
    console.error('JSON invalide : clé "categories" attendue.');
    process.exit(1);
  }
  return donnees;
}

function apostrophe(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
}

async function importerLocal(exp: Export): Promise<void> {
  // Sécurité : on ne remplace pas un catalogue déjà utilisé par des ventes.
  const n = (await db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM commande_items`)).rows[0]?.n ?? '0';
  if (Number(n) > 0) {
    console.error('La base contient déjà des commandes : import de remplacement refusé.');
    console.error('Importez sur une base fraîche (pnpm db:migrate + pnpm db:seed) ou visez le cloud.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Remplacement entier du catalogue (enfants d'abord, FK obligent)
    await client.query(`DELETE FROM combo_articles`);
    await client.query(`DELETE FROM combos`);
    await client.query(`DELETE FROM supplements`);
    await client.query(`DELETE FROM options`);
    await client.query(`DELETE FROM groupes_options`);
    await client.query(`DELETE FROM prix_canaux`);
    await client.query(`UPDATE promotions SET article_id = NULL WHERE article_id IS NOT NULL`);
    await client.query(`DELETE FROM articles`);
    await client.query(`DELETE FROM categories`);

    let nbArticles = 0;
    for (const c of exp.categories) {
      await client.query(
        `INSERT INTO categories (id, nom, ordre, actif) VALUES ($1,$2,$3,$4)`,
        [c.id, c.nom, c.ordre, c.active],
      );
      for (const p of c.produits) {
        await client.query(
          `INSERT INTO articles (id, categorie_id, nom, description, prix_base, image_url, disponible, actif)
           VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)`,
          [p.id, c.id, p.nom, p.description, p.prix, p.photo_url, p.disponible],
        );
        nbArticles += 1;
      }
    }
    await client.query('COMMIT');
    console.log(`✔ Import local : ${exp.categories.length} catégories, ${nbArticles} produits.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function genererSqlCloud(exp: Export, sortie: string): Promise<void> {
  const [resto] = await db.select().from(restaurant).limit(1);
  if (!resto) {
    console.error('Aucun restaurant en base locale (pnpm db:seed) — nécessaire pour restaurant_id.');
    process.exit(1);
  }
  const rid = resto.id;
  const lignes: string[] = [
    '-- Catalogue Chez Samer — à coller dans l’éditeur SQL Supabase (projet cloud).',
    '-- Remplacement entier pour ce restaurant ; le trigger fixe la colonne version.',
    'BEGIN;',
    `DELETE FROM articles WHERE restaurant_id = '${rid}';`,
    `DELETE FROM categories WHERE restaurant_id = '${rid}';`,
  ];
  let nbArticles = 0;
  for (const c of exp.categories) {
    lignes.push(
      `INSERT INTO categories (id, restaurant_id, nom, ordre, actif) VALUES ` +
        `('${c.id}','${rid}',${apostrophe(c.nom)},${c.ordre},${c.active}) ` +
        `ON CONFLICT (id) DO UPDATE SET nom=EXCLUDED.nom, ordre=EXCLUDED.ordre, actif=EXCLUDED.actif;`,
    );
    for (const p of c.produits) {
      lignes.push(
        `INSERT INTO articles (id, restaurant_id, categorie_id, nom, description, prix_base, image_url, disponible, actif) VALUES ` +
          `('${p.id}','${rid}','${c.id}',${apostrophe(p.nom)},${apostrophe(p.description)},${p.prix},${apostrophe(p.photo_url)},${p.disponible},TRUE) ` +
          `ON CONFLICT (id) DO UPDATE SET categorie_id=EXCLUDED.categorie_id, nom=EXCLUDED.nom, description=EXCLUDED.description, prix_base=EXCLUDED.prix_base, image_url=EXCLUDED.image_url, disponible=EXCLUDED.disponible, actif=TRUE;`,
      );
      nbArticles += 1;
    }
  }
  lignes.push('COMMIT;');
  writeFileSync(sortie, lignes.join('\n') + '\n');
  console.log(`✔ SQL cloud généré : ${sortie} (${exp.categories.length} catégories, ${nbArticles} produits).`);
  console.log('Collez ce fichier dans l’éditeur SQL de votre projet Supabase pour publier le catalogue.');
}

async function main(): Promise<void> {
  const fichier = resolve(arg('fichier', 'docs/catalogue_samer.json'));
  const cible = arg('cible', 'local');
  const exp = lireExport(fichier);

  if (cible === 'cloud') {
    await genererSqlCloud(exp, resolve(arg('sql-sortie', 'sql/cloud/catalogue_import.sql')));
  } else if (cible === 'local') {
    await importerLocal(exp);
  } else {
    console.error('--cible doit valoir "local" ou "cloud".');
    process.exit(1);
  }
  await fermerDb();
}

await main();
