// Edge Function sync-pull — DESCENTE catalogue/utilisateurs/promotions
// (cloud → local). Le cloud est maître : renvoie les lignes dont version > N,
// filtrées pour ce restaurant. Ne touche JAMAIS aux ventes.
import { clientAdmin, ErreurAuth, json, verifierCleSite } from '../_shared/auth.ts';
import { FLUX_DESCENTE } from '../_shared/tables.ts';
import { lireBattement } from '../_shared/sante-sites.ts';

interface LigneDescente {
  table_name: string;
  row: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  const admin = clientAdmin();

  let restaurantId: string;
  let versions: Record<string, number>;
  let sante: unknown;
  try {
    const corps = await req.json();
    restaurantId = await verifierCleSite(admin, corps.cle_site);
    versions = corps.versions ?? {};
    sante = corps.sante;
  } catch (e) {
    if (e instanceof ErreurAuth) return json({ erreur: e.message }, 401);
    return json({ erreur: 'Requête invalide' }, 400);
  }

  const resultat: Record<string, { lignes: LigneDescente[]; version: number }> = {};

  for (const [flux, tables] of Object.entries(FLUX_DESCENTE)) {
    const depuis = Number(versions[flux.toLowerCase()] ?? 0);
    let maxVersion = depuis;
    let incomplet = false;
    const lignes: LigneDescente[] = [];
    for (const table of tables) {
      const { data, error } = await admin
        .from(table)
        .select('*')
        .eq('restaurant_id', restaurantId)
        .gt('version', depuis)
        .order('version', { ascending: true })
        .limit(2000);
      // Une table absente du cloud (fonction déployée avant sa migration) ne
      // doit PAS faire échouer toute la descente : le site perdrait aussi les
      // mises à jour des tables qui, elles, existent. On la saute — il ne
      // manquera que ce qu'elle contient, et la descente suivante le rattrapera
      // une fois la migration passée. Symétrique du garde-fou posé côté montée
      // le 2026-08-16, où une table inconnue gelait le site.
      if (error) {
        console.error(`descente: table ${table} ignorée (${error.message})`);
        incomplet = true;
        continue;
      }
      for (const row of data ?? []) {
        const v = Number((row as { version: number }).version ?? 0);
        if (v > maxVersion) maxVersion = v;
        lignes.push({ table_name: table, row: row as Record<string, unknown> });
      }
    }
    // Si une table du flux a été sautée, on NE FAIT PAS avancer la version.
    // `version` est une séquence GLOBALE à tout le cloud : laisser le flux
    // progresser grâce aux tables lues effacerait définitivement les lignes de
    // la table manquée, dont les versions seraient déjà dépassées au prochain
    // passage. Le site rejouera donc le même intervalle — les lignes déjà
    // appliquées le seront à nouveau, ce qui est sans effet (UPSERT par id).
    resultat[flux.toLowerCase()] = { lignes, version: incomplet ? depuis : maxVersion };
  }

  await admin.from('sync_journal').insert({ restaurant_id: restaurantId, type: 'PULL', nb_lignes: 0 });

  // BATTEMENT DE CŒUR (2026-10-21) : version, ventes en attente, dernière
  // erreur — ce que seul le site sait, pour l'écran « Santé des sites ».
  // Porté par la descente et non par la montée : la montée ne parle au cloud
  // QUE s'il y a des ventes à envoyer, un site calme la nuit paraîtrait mort.
  // La descente, elle, passe toutes les 5 min quoi qu'il arrive.
  // Au mieux : une table absente (migration pas encore passée) ne doit jamais
  // priver le site de son catalogue.
  const battement = lireBattement(sante);
  if (battement) {
    const { error } = await admin
      .from('sites_sante')
      .upsert({ restaurant_id: restaurantId, recu_le: new Date().toISOString(), ...battement }, { onConflict: 'restaurant_id' });
    if (error) console.error(`battement ignoré (${error.message})`);
  }

  return json(resultat);
});
