/**
 * Applique le routage d'impression par DÉFAUT (par nom de catégorie, cf.
 * `ROUTAGE_CATEGORIE_DEFAUT` partagé). Idempotent : n'insère que pour les
 * catégories SANS routage existant — un choix fait dans Réglags › Routage
 * impression n'est jamais écrasé. Appelé au seed et après un import catalogue.
 */
import { eq } from 'drizzle-orm';
import { posteDefautCategorie } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { categories, routageCategorie } from '../../db/schema/index.js';

export async function appliquerRoutageDefaut(dbx: DbOuTx): Promise<number> {
  const [cats, existant] = await Promise.all([
    dbx.select({ id: categories.id, nom: categories.nom }).from(categories).where(eq(categories.actif, true)),
    dbx.select({ categorie_id: routageCategorie.categorie_id }).from(routageCategorie),
  ]);
  const dejaRoute = new Set(existant.map((x) => x.categorie_id));
  let inseres = 0;
  for (const c of cats) {
    if (dejaRoute.has(c.id)) continue;
    const poste = posteDefautCategorie(c.nom);
    if (!poste) continue;
    await dbx.insert(routageCategorie).values({ categorie_id: c.id, poste }).onConflictDoNothing();
    inseres++;
  }
  return inseres;
}
