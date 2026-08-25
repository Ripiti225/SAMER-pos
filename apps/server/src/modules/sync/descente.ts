/**
 * DESCENTE catalogue/utilisateurs/promotions (cloud → local) — §B.
 * Le cloud est maître : UPSERT par id, puis mise à jour de sync_etat, le tout
 * en une transaction. Ne touche JAMAIS aux tables de ventes. En cas de
 * conflit, le cloud gagne.
 */
import { pool } from '../../db/client.js';
import { invaliderCachePermissions } from '../roles/service.js';
import type { ClientCloud, LigneDescente } from './cloud-client.js';

/**
 * ROLES (2026-08-25) : le siège change les accès d'un rôle pour plusieurs
 * restaurants d'un coup. Seule `role_permissions` descend, **jamais la table
 * `roles`** : son `nom` est UNIQUE en local, et un site qui a « CAISSIER » sous
 * son propre uuid recevrait un INSERT au nom identique — violation d'unicité,
 * transaction annulée, et c'est TOUTE la descente du site qui s'arrête, catalogue
 * compris. Le siège résout donc le rôle par son NOM, restaurant par restaurant,
 * et n'envoie que le jeu de permissions de l'id local (même idiome que la
 * catégorie d'un article diffusé).
 */
const FLUX = ['CATALOGUE', 'PROMOTIONS', 'UTILISATEURS', 'PARAMETRES', 'ROLES'] as const;

/** Cible de conflit par table (id sauf combo_articles et parametres_locaux). */
const CONFLIT: Record<string, string[]> = {
  categories: ['id'],
  articles: ['id'],
  prix_canaux: ['id'],
  groupes_options: ['id'],
  options: ['id'],
  supplements: ['id'],
  combos: ['id'],
  combo_articles: ['combo_id', 'article_id'],
  promotions: ['id'],
  utilisateurs: ['id'],
  // Barème fidélité (2.5) : le siège est maître, clé = cle.
  parametres_locaux: ['cle'],
  // Inventaire (2026-08-17) : un plat et sa recette descendent ensemble.
  // Sans ça, le siège diffusait un plat sur les 7 sites sans ce qu'il consomme,
  // et l'écart d'inventaire de fin de service devenait faux partout.
  //
  // Clé = `id` comme le reste du catalogue, et NON la clé métier (`code`, ou le
  // couple produit/article), bien qu'elles soient uniques en local. La raison
  // est le lien entre les deux tables : `inventaire_consommations.produit_id`
  // désigne un produit PAR SON ID. Si la descente laissait le local réattribuer
  // ses propres ids, la recette d'un produit créé au siège pointerait dans le
  // vide. En conflictant sur `id`, l'identifiant reste le même du siège
  // jusqu'aux 7 caisses.
  produits_inventaire: ['id'],
  inventaire_consommations: ['id'],
  // `role_permissions` n'est PAS dans cette table : elle ne s'applique pas par
  // UPSERT mais par REMPLACEMENT — voir `appliquerPermissionsRole`.
};

// Colonnes propres au cloud, à retirer avant l'écriture locale.
const CLOUD_ONLY = new Set(['restaurant_id', 'version']);

function nettoyer(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const propre: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (CLOUD_ONLY.has(k)) continue;
    if (table === 'combo_articles' && k === 'id') continue; // PK composite en local
    propre[k] = v;
  }
  return propre;
}

/**
 * Applique un jeu de permissions descendu du siège.
 *
 * REMPLACEMENT, et non upsert : le cloud porte la liste complète des clés dans
 * un tableau JSONB, là où le local a une ligne par couple (rôle, permission).
 * Un simple INSERT ne saurait qu'AJOUTER — retirer une permission au siège ne
 * serait jamais appliqué sur le site, et l'écran mentirait. On efface donc les
 * couples du rôle avant d'écrire les nouveaux.
 *
 * Deux gardes, parce qu'une erreur ici annule toute la transaction de descente
 * et gèlerait aussi le catalogue :
 *   - rôle inconnu en local → on ignore la ligne (le siège a visé un id qui
 *     n'existe pas ici) plutôt que de violer la clé étrangère ;
 *   - les rôles VERROUILLÉS (propriétaire, superviseur) sont refusés côté siège,
 *     mais on ne s'en remet pas à lui : un site ne doit pas pouvoir se faire
 *     retirer son propriétaire par une ligne de synchro.
 */
const ROLES_NON_DESCENDABLES = ['PROPRIETAIRE', 'SUPERVISEUR'];

async function appliquerPermissionsRole(
  clientPg: { query: (t: string, v?: unknown[]) => Promise<unknown> },
  row: Record<string, unknown>,
): Promise<boolean> {
  const roleId = typeof row.role_id === 'string' ? row.role_id : typeof row.id === 'string' ? row.id : null;
  if (!roleId) return false;
  const brutes = Array.isArray(row.permissions) ? (row.permissions as unknown[]) : [];
  const permissions = [...new Set(brutes.filter((p): p is string => typeof p === 'string'))];

  const existe = (await clientPg.query(
    `SELECT nom FROM roles WHERE id = $1`,
    [roleId],
  )) as { rows: { nom: string }[] };
  const nom = existe.rows[0]?.nom;
  if (!nom) return false;
  if (ROLES_NON_DESCENDABLES.includes(nom)) return false;

  await clientPg.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
  if (permissions.length > 0) {
    await clientPg.query(
      `INSERT INTO role_permissions (role_id, permission_cle)
       SELECT $1, unnest($2::text[])
       ON CONFLICT DO NOTHING`,
      [roleId, permissions],
    );
  }
  return true;
}

async function appliquerLigne(
  clientPg: { query: (t: string, v?: unknown[]) => Promise<unknown> },
  ligne: LigneDescente,
): Promise<void> {
  if (ligne.table_name === 'role_permissions') {
    await appliquerPermissionsRole(clientPg, ligne.row);
    return;
  }
  const pk = CONFLIT[ligne.table_name];
  if (!pk) return; // table inconnue → ignorée
  const row = nettoyer(ligne.table_name, ligne.row);
  const cols = Object.keys(row);
  if (cols.length === 0) return;
  const valeurs = cols.map((c) => row[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const majSet = cols
    .filter((c) => !pk.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`);
  const action = majSet.length > 0 ? `DO UPDATE SET ${majSet.join(', ')}` : 'DO NOTHING';
  const sql =
    `INSERT INTO ${ligne.table_name} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ` +
    `ON CONFLICT (${pk.join(', ')}) ${action}`;
  await clientPg.query(sql, valeurs);
}

/**
 * Tire les nouveautés depuis le cloud et les applique. Retourne le nombre de
 * lignes appliquées. Peut lever ErreurSync (réseau) — l'appelant réessaiera.
 */
export async function tirerCatalogue(client: ClientCloud): Promise<number> {
  // Versions courantes (lues hors transaction, lecture seule)
  const etat = await pool.query<{ flux: string; version: string }>(
    `SELECT flux, version FROM sync_etat WHERE flux = ANY($1)`,
    [FLUX as unknown as string[]],
  );
  const versionParFlux = new Map(etat.rows.map((r) => [r.flux, Number(r.version)]));
  const requete: Record<string, number> = {};
  for (const f of FLUX) requete[f.toLowerCase()] = versionParFlux.get(f) ?? 0;

  const reponse = await client.pull(requete);

  const clientPg = await pool.connect();
  let applique = 0;
  let permissionsTouchees = false;
  try {
    await clientPg.query('BEGIN');
    for (const f of FLUX) {
      const bloc = reponse[f.toLowerCase()];
      if (!bloc) continue;
      for (const ligne of bloc.lignes) {
        await appliquerLigne(clientPg, ligne);
        if (ligne.table_name === 'role_permissions') permissionsTouchees = true;
        applique += 1;
      }
      // Mise à jour de la version du flux dans la même transaction
      await clientPg.query(
        `INSERT INTO sync_etat (flux, version, synced_at) VALUES ($1, $2, now())
         ON CONFLICT (flux) DO UPDATE SET version = EXCLUDED.version, synced_at = now()`,
        [f, bloc.version],
      );
    }
    await clientPg.query('COMMIT');
    // Le cache des permissions est en mémoire : sans cette invalidation, le
    // site continuerait de servir les anciens accès jusqu'à son redémarrage.
    // APRÈS le commit, comme le font les routes de gestion des rôles.
    if (permissionsTouchees) invaliderCachePermissions();
  } catch (e) {
    await clientPg.query('ROLLBACK');
    throw e;
  } finally {
    clientPg.release();
  }
  return applique;
}
