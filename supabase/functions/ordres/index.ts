// Edge Function `ordres` — file d'ORDRES du siège vers un site.
//
// Pourquoi une fonction à part plutôt qu'un flux de plus dans `sync-pull` :
// la descente est un UPSERT de données de catalogue qui « ne touche JAMAIS aux
// tables de ventes ». Un ordre n'est pas une donnée à recopier, c'est une
// ACTION à exécuter — mélanger les deux aurait fait de la descente un moteur
// d'exécution, et un ordre mal formé aurait pu geler la descente du catalogue.
//
// Authentifiée par la CLÉ DE SITE, comme sync-pull et sync-push : c'est le site
// qui vient chercher ses ordres, jamais le cloud qui pousse. Un mini-PC derrière
// la box d'un restaurant n'est de toute façon pas joignable de l'extérieur.
import { clientAdmin, ErreurAuth, json, verifierCleSite } from '../_shared/auth.ts';

/** Ordres servis d'un coup. Au-delà, le site repassera : rien ne presse. */
const LOT = 10;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  const admin = clientAdmin();

  let restaurantId: string;
  let corps: Record<string, unknown>;
  try {
    corps = await req.json();
    restaurantId = await verifierCleSite(admin, corps.cle_site);
  } catch (e) {
    if (e instanceof ErreurAuth) return json({ erreur: e.message }, 401);
    return json({ erreur: 'Requête invalide' }, 400);
  }

  const action = String(corps.action ?? 'lister');

  try {
    if (action === 'lister') {
      const maintenant = new Date().toISOString();

      // Ménage d'abord : un ordre périmé ne doit pas être servi. Le siège le
      // verra EXPIRE et saura qu'il faut le refaire, plutôt que de le croire
      // en route pendant des jours.
      await admin
        .from('ordres_site')
        .update({ statut: 'EXPIRE', erreur: 'Le site n’est pas venu le chercher à temps' })
        .eq('restaurant_id', restaurantId)
        .eq('statut', 'EN_ATTENTE')
        .lt('expire_le', maintenant);

      const { data, error } = await admin
        .from('ordres_site')
        .select('id, type, params, demandeur, demandeur_id, cree_le, expire_le')
        .eq('restaurant_id', restaurantId)
        .eq('statut', 'EN_ATTENTE')
        .order('cree_le', { ascending: true })
        .limit(LOT);
      if (error) throw new Error('Lecture des ordres impossible');

      return json({ ordres: data ?? [] });
    }

    if (action === 'acquitter') {
      const id = String(corps.id ?? '');
      const statut = String(corps.statut ?? '');
      if (!id) return json({ erreur: 'Ordre non précisé' }, 400);
      if (!['EXECUTE', 'ECHEC'].includes(statut)) return json({ erreur: 'Statut d’acquittement invalide' }, 400);

      // `eq('statut', 'EN_ATTENTE')` : un ordre déjà acquitté ne se réécrit pas.
      // Le site rejoue parfois (redémarrage entre l'exécution et l'acquittement) ;
      // c'est `actions_recues` côté POS qui empêche la double exécution, et cette
      // clause qui empêche d'écraser le premier résultat par un « déjà fait ».
      const { error } = await admin
        .from('ordres_site')
        .update({
          statut,
          execute_le: new Date().toISOString(),
          resultat: corps.resultat ?? null,
          erreur: corps.erreur ? String(corps.erreur) : null,
        })
        .eq('restaurant_id', restaurantId)
        .eq('id', id)
        .eq('statut', 'EN_ATTENTE');
      if (error) throw new Error('Acquittement impossible');

      return json({ ok: true });
    }

    return json({ erreur: `Action inconnue : ${action}` }, 400);
  } catch (e) {
    return json({ erreur: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
});
