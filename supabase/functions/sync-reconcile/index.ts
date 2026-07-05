// Edge Function sync-reconcile — RÉCONCILIATION quotidienne (filet de sécurité).
// Le local envoie ses chiffres de la veille ; le cloud recalcule les siens
// pour ce restaurant/jour et enregistre l'écart. Note : la Côte d'Ivoire est à
// UTC+0 (pas d'heure d'été) → created_at::date == jour local.
import { clientAdmin, ErreurAuth, json, verifierCleSite } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  const admin = clientAdmin();

  let restaurantId: string;
  let jour: string;
  let local: { nb_payees: number; total_ventes: number; par_mode?: Record<string, number> };
  try {
    const corps = await req.json();
    restaurantId = await verifierCleSite(admin, corps.cle_site);
    jour = String(corps.jour);
    local = corps.local ?? { nb_payees: 0, total_ventes: 0 };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) throw new ErreurAuth('Jour invalide');
  } catch (e) {
    if (e instanceof ErreurAuth) return json({ erreur: e.message }, 401);
    return json({ erreur: 'Requête invalide' }, 400);
  }

  const debut = `${jour}T00:00:00Z`;
  const fin = `${jour}T23:59:59.999Z`;

  const { data, error } = await admin
    .from('commandes')
    .select('total')
    .eq('restaurant_id', restaurantId)
    .eq('statut', 'PAYEE')
    .gte('created_at', debut)
    .lte('created_at', fin);
  if (error) return json({ erreur: 'Lecture cloud impossible' }, 500);

  const nbCloud = (data ?? []).length;
  const totalCloud = (data ?? []).reduce((s, c) => s + Number((c as { total: number }).total ?? 0), 0);
  const ecart = local.total_ventes - totalCloud;
  const statut = ecart === 0 && local.nb_payees === nbCloud ? 'OK' : 'ECART';

  await admin.from('reconciliations').upsert(
    {
      restaurant_id: restaurantId,
      jour,
      total_local: local.total_ventes,
      total_cloud: totalCloud,
      ecart,
      statut,
      detail: { nb_local: local.nb_payees, nb_cloud: nbCloud, par_mode: local.par_mode ?? {} },
    },
    { onConflict: 'restaurant_id,jour' },
  );

  await admin.from('sync_journal').insert({ restaurant_id: restaurantId, type: 'RECONCILE', nb_lignes: nbCloud });
  return json({ statut, total_cloud: totalCloud, nb_cloud: nbCloud, ecart });
});
