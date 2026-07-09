/**
 * DESCENTE catalogue/utilisateurs/promotions (cloud → local) — §B.
 * Le cloud est maître : UPSERT par id, puis mise à jour de sync_etat, le tout
 * en une transaction. Ne touche JAMAIS aux tables de ventes. En cas de
 * conflit, le cloud gagne.
 */
import { pool } from '../../db/client.js';
import type { ClientCloud, LigneDescente } from './cloud-client.js';

const FLUX = ['CATALOGUE', 'PROMOTIONS', 'UTILISATEURS', 'PARAMETRES'] as const;

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

async function appliquerLigne(
  clientPg: { query: (t: string, v?: unknown[]) => Promise<unknown> },
  ligne: LigneDescente,
): Promise<void> {
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
  try {
    await clientPg.query('BEGIN');
    for (const f of FLUX) {
      const bloc = reponse[f.toLowerCase()];
      if (!bloc) continue;
      for (const ligne of bloc.lignes) {
        await appliquerLigne(clientPg, ligne);
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
  } catch (e) {
    await clientPg.query('ROLLBACK');
    throw e;
  } finally {
    clientPg.release();
  }
  return applique;
}
