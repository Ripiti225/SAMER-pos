// Edge Function sync-pull — DESCENTE catalogue/utilisateurs/promotions
// (cloud → local). Le cloud est maître : renvoie les lignes dont version > N,
// filtrées pour ce restaurant. Ne touche JAMAIS aux ventes.
import { clientAdmin, ErreurAuth, json, verifierCleSite } from '../_shared/auth.ts';
import { FLUX_DESCENTE } from '../_shared/tables.ts';

interface LigneDescente {
  table_name: string;
  row: Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  const admin = clientAdmin();

  let restaurantId: string;
  let versions: Record<string, number>;
  try {
    const corps = await req.json();
    restaurantId = await verifierCleSite(admin, corps.cle_site);
    versions = corps.versions ?? {};
  } catch (e) {
    if (e instanceof ErreurAuth) return json({ erreur: e.message }, 401);
    return json({ erreur: 'Requête invalide' }, 400);
  }

  const resultat: Record<string, { lignes: LigneDescente[]; version: number }> = {};

  for (const [flux, tables] of Object.entries(FLUX_DESCENTE)) {
    const depuis = Number(versions[flux.toLowerCase()] ?? 0);
    let maxVersion = depuis;
    const lignes: LigneDescente[] = [];
    for (const table of tables) {
      const { data, error } = await admin
        .from(table)
        .select('*')
        .eq('restaurant_id', restaurantId)
        .gt('version', depuis)
        .order('version', { ascending: true })
        .limit(2000);
      if (error) return json({ erreur: `Lecture ${table} impossible` }, 500);
      for (const row of data ?? []) {
        const v = Number((row as { version: number }).version ?? 0);
        if (v > maxVersion) maxVersion = v;
        lignes.push({ table_name: table, row: row as Record<string, unknown> });
      }
    }
    resultat[flux.toLowerCase()] = { lignes, version: maxVersion };
  }

  await admin.from('sync_journal').insert({ restaurant_id: restaurantId, type: 'PULL', nb_lignes: 0 });
  return json(resultat);
});
