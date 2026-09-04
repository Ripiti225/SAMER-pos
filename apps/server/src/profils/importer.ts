import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { pool } from '../db/client.js';

const ArticleSchema = z.object({
  nom: z.string().min(1),
  prix: z.number().int().nonnegative(),
  description: z.string().optional(),
});
const ProfilSchema = z.object({
  code: z.string().min(1),
  restaurant: z.object({
    nom: z.string().min(1), marque: z.literal('A_LA_BRAISE'), couleur_hex: z.string(),
  }).passthrough(),
  parametres: z.record(z.unknown()),
  zones: z.array(z.object({
    nom: z.string(), ordre: z.number().int(),
    tables: z.array(z.object({ numero: z.string(), partenaire: z.string().optional() })),
  })),
  categories: z.array(z.object({
    nom: z.string(), ordre: z.number().int(), jour: z.number().int().optional(),
    horaire: z.object({ debut: z.string(), fin: z.string() }).optional(),
    articles: z.array(ArticleSchema),
  })),
  options: z.array(z.object({ nom: z.string(), prix: z.number().int(), categories: z.array(z.string()) })).default([]),
  inventaire: z.array(z.object({ code: z.string(), categorie: z.string(), nom: z.string(), unite: z.string() })).default([]),
});

export type ProfilRestaurant = z.infer<typeof ProfilSchema>;

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');

function idStable(cle: string): string {
  const h = createHash('sha256').update(`pos-samer:${cle}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function lireProfilRestaurant(code: string): Promise<ProfilRestaurant> {
  if (code !== 'ALA_BRAISE') throw new Error(`Profil restaurant inconnu : ${code}`);
  const chemin = resolve(RACINE, 'config/restaurants/a-la-braise/profil.json');
  return ProfilSchema.parse(JSON.parse(await readFile(chemin, 'utf8')));
}

export async function importerProfilRestaurant(code: string): Promise<void> {
  const profil = await lireProfilRestaurant(code);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ventes = await client.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM commande_items');
    if (Number(ventes.rows[0]?.n ?? 0) > 0) {
      throw new Error('La base contient déjà des commandes : import du profil refusé.');
    }
    const courant = await client.query<{ id: string; code: string }>('SELECT id, code FROM restaurant LIMIT 1');
    const ancien = courant.rows[0];
    if (ancien && !['A_CONFIGURER', profil.code].includes(ancien.code)) {
      throw new Error(`Ce poste appartient déjà au restaurant ${ancien.code}.`);
    }
    const restaurantId = ancien?.code === profil.code ? ancien.id : randomUUID();
    if (ancien) {
      await client.query(
        'UPDATE restaurant SET id=$1, code=$2, nom=$3, marque=$4, couleur_hex=$5 WHERE id=$6',
        [restaurantId, profil.code, profil.restaurant.nom, profil.restaurant.marque, profil.restaurant.couleur_hex, ancien.id],
      );
    } else {
      await client.query(
        'INSERT INTO restaurant(id,code,nom,marque,couleur_hex) VALUES($1,$2,$3,$4,$5)',
        [restaurantId, profil.code, profil.restaurant.nom, profil.restaurant.marque, profil.restaurant.couleur_hex],
      );
    }
    for (const [cle, valeur] of Object.entries(profil.parametres)) {
      await client.query(
        `INSERT INTO parametres_locaux(cle,valeur) VALUES($1,$2::jsonb)
         ON CONFLICT(cle) DO UPDATE SET valeur=EXCLUDED.valeur, updated_at=NOW()`,
        [cle, JSON.stringify(valeur)],
      );
    }

    await client.query('DELETE FROM tables_salle');
    await client.query('DELETE FROM zones');
    for (const zone of profil.zones) {
      const zoneId = idStable(`${profil.code}:zone:${zone.nom}`);
      await client.query('INSERT INTO zones(id,nom,ordre) VALUES($1,$2,$3)', [zoneId, zone.nom, zone.ordre]);
      for (const table of zone.tables) {
        await client.query(
          'INSERT INTO tables_salle(id,zone_id,numero,partenaire) VALUES($1,$2,$3,$4)',
          [idStable(`${profil.code}:table:${zone.nom}:${table.numero}`), zoneId, table.numero, table.partenaire ?? null],
        );
      }
    }

    await client.query('DELETE FROM options_liaisons');
    await client.query('DELETE FROM options_catalogue');
    await client.query('DELETE FROM disponibilite_locale');
    await client.query('DELETE FROM combo_articles');
    await client.query('DELETE FROM combos');
    await client.query('DELETE FROM supplements');
    await client.query('DELETE FROM options');
    await client.query('DELETE FROM groupes_options');
    await client.query('DELETE FROM prix_canaux');
    await client.query('DELETE FROM mapping_poste_categorie');
    await client.query('DELETE FROM routage_article');
    await client.query('DELETE FROM routage_categorie');
    await client.query('UPDATE promotions SET article_id=NULL');
    await client.query('DELETE FROM articles');
    await client.query('DELETE FROM categories');

    const categorieIds = new Map<string, string>();
    for (const categorie of profil.categories) {
      const categorieId = idStable(`${profil.code}:categorie:${categorie.nom}`);
      categorieIds.set(categorie.nom, categorieId);
      await client.query('INSERT INTO categories(id,nom,ordre,actif) VALUES($1,$2,$3,TRUE)', [categorieId, categorie.nom, categorie.ordre]);
      for (const article of categorie.articles) {
        const articleId = idStable(`${profil.code}:article:${article.nom}`);
        await client.query(
          `INSERT INTO articles(id,categorie_id,nom,description,prix_base,image_url,disponible,actif)
           VALUES($1,$2,$3,$4,$5,NULL,TRUE,TRUE)`,
          [articleId, categorieId, article.nom, article.description ?? null, article.prix],
        );
        await client.query('INSERT INTO disponibilite_locale(article_id,disponible) VALUES($1,TRUE)', [articleId]);
      }
    }
    for (const option of profil.options) {
      const optionId = idStable(`${profil.code}:option:${option.nom}`);
      await client.query('INSERT INTO options_catalogue(id,nom,prix,ordre) VALUES($1,$2,$3,0)', [optionId, option.nom, option.prix]);
      for (const nomCategorie of option.categories) {
        const categorieId = categorieIds.get(nomCategorie);
        if (!categorieId) throw new Error(`Catégorie d’option inconnue : ${nomCategorie}`);
        await client.query(
          'INSERT INTO options_liaisons(id,option_id,categorie_id) VALUES($1,$2,$3)',
          [idStable(`${profil.code}:liaison:${option.nom}:${nomCategorie}`), optionId, categorieId],
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
