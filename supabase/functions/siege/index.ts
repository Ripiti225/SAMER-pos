// Edge Function `siege` — point d'entrée UNIQUE de la console d'administration.
//
// Pourquoi tout passe par ici plutôt que par un accès direct à la base :
//   * La RLS est forcée sans politique sur toutes les tables. Une console qui
//     lirait la base directement aurait besoin de la clé service_role — donc
//     d'embarquer, dans du JavaScript téléchargé par un navigateur, la clé qui
//     ouvre les ventes des 7 restaurants. C'est exactement l'erreur qu'on est
//     en train de corriger côté SamerTrackly.
//   * La console n'embarque donc que la clé anonyme (publique par nature) et le
//     jeton de session de la personne connectée. Tout privilège reste ici.
//
// Une action = une entrée dans le `switch`. Le corps de la requête porte
// `{ action, ... }` ; la réponse est toujours du JSON avec les en-têtes CORS.
import {
  clientAdmin,
  ENTETES_CORS,
  ErreurAuth,
  jsonCors,
  verifierSiege,
  type Siege,
} from '../_shared/auth.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// SamerTrackly — source de vérité des restaurants et des employés.
//
// La clé vit ici, en secret de fonction, et NON dans la console. C'est le même
// principe que pour le service_role : le navigateur ne reçoit jamais de clé
// capable d'écrire dans la base RH du groupe.
// ---------------------------------------------------------------------------
const ST_URL = Deno.env.get('SAMTRACKLY_URL') ?? '';
const ST_KEY = Deno.env.get('SAMTRACKLY_KEY') ?? '';

async function samtrackly(chemin: string): Promise<unknown[]> {
  if (!ST_URL || !ST_KEY) throw new Error('SamerTrackly non configuré (secrets de la fonction)');
  const rep = await fetch(`${ST_URL}/rest/v1/${chemin}`, {
    headers: { apikey: ST_KEY, Authorization: `Bearer ${ST_KEY}` },
  });
  if (!rep.ok) throw new Error(`SamerTrackly a répondu ${rep.status}`);
  return (await rep.json()) as unknown[];
}

interface RestoST {
  id: string;
  nom: string | null;
  couleur: string | null;
}

interface RestoPOS {
  restaurant_id: string;
  code: string;
  nom: string;
  marque: string;
  couleur_hex: string | null;
  samtrackly_id: string | null;
  actif: boolean;
}

/** Vue unifiée d'un restaurant du groupe, quel que soit son état d'enrôlement. */
interface RestoGroupe {
  /** UUID POS — présent SEULEMENT si le site est enrôlé. C'est la clé des ventes. */
  restaurant_id: string | null;
  samtrackly_id: string;
  nom: string;
  marque: 'SAMER' | 'AL_KAYAN';
  /** false = le POS de ce site ne synchronise pas encore : aucune vente ici. */
  enrole: boolean;
}

/**
 * Liste des restaurants du groupe.
 *
 * SamerTrackly fait foi pour la LISTE et les NOMS : c'est là qu'un restaurant
 * est créé, et il y en a 7 aujourd'hui. Le cloud POS n'apporte qu'une chose,
 * mais essentielle : l'UUID sous lequel les ventes de ce site remontent.
 *
 * Un restaurant non enrôlé apparaît quand même, marqué comme tel. C'est
 * volontaire : une console qui masquerait les sites muets laisserait croire que
 * le groupe fait 2 restaurants au lieu de 7.
 */
async function restaurantsGroupe(admin: SupabaseClient): Promise<RestoGroupe[]> {
  const [stRows, { data: posRows, error }] = await Promise.all([
    samtrackly('restaurants?select=id,nom,couleur&order=nom') as Promise<RestoST[]>,
    admin.from('restaurants').select('restaurant_id, code, nom, marque, couleur_hex, samtrackly_id, actif'),
  ]);
  if (error) throw new Error('Lecture des restaurants impossible');

  const parST = new Map<string, RestoPOS>();
  for (const r of (posRows ?? []) as RestoPOS[]) {
    if (r.samtrackly_id) parST.set(r.samtrackly_id, r);
  }

  return stRows
    .filter((r) => (r.nom ?? '').trim())
    .map((r) => {
      const pos = parST.get(r.id);
      // La marque vient de la couleur RH (« vert » = Al Kayan) tant que le site
      // n'est pas enrôlé ; ensuite c'est le POS qui fait foi, il la porte en dur.
      const marque: 'SAMER' | 'AL_KAYAN' =
        pos?.marque === 'AL_KAYAN' || (!pos && (r.couleur ?? '').toLowerCase().includes('vert'))
          ? 'AL_KAYAN'
          : 'SAMER';
      return {
        restaurant_id: pos?.restaurant_id ?? null,
        samtrackly_id: r.id,
        nom: r.nom!.trim(),
        marque,
        enrole: !!pos && pos.actif,
      };
    });
}

/** Trace une action du siège. Best-effort : n'échoue jamais l'action elle-même. */
async function tracer(
  admin: SupabaseClient,
  siege: Siege,
  action: string,
  details: { entite?: string; entiteId?: string; portee?: string[]; meta?: unknown },
): Promise<void> {
  try {
    await admin.from('siege_audit').insert({
      user_id: siege.userId,
      nom_complet: siege.nomComplet,
      action,
      entite: details.entite ?? null,
      entite_id: details.entiteId ?? null,
      portee: details.portee ?? [],
      meta: details.meta ?? {},
    });
  } catch {
    // Le journal ne doit jamais bloquer le travail.
  }
}

/** Bornes de période. Abidjan est à UTC+0 toute l'année — pas de décalage à gérer. */
function periode(corps: Record<string, unknown>): { debut: string; fin: string } {
  const debut = typeof corps.debut === 'string' ? corps.debut : '';
  const fin = typeof corps.fin === 'string' ? corps.fin : '';
  if (!debut || !fin) throw new Error('Période manquante');
  return { debut, fin };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: ENTETES_CORS });
  if (req.method !== 'POST') return jsonCors({ erreur: 'Méthode non autorisée' }, 405);

  const admin = clientAdmin();

  let siege: Siege;
  let corps: Record<string, unknown>;
  try {
    siege = await verifierSiege(admin, req);
    corps = (await req.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ErreurAuth) return jsonCors({ erreur: e.message }, 401);
    return jsonCors({ erreur: 'Requête invalide' }, 400);
  }

  const action = String(corps.action ?? '');

  try {
    switch (action) {
      // -- Qui suis-je : la console appelle ceci au démarrage pour savoir si la
      // -- session tient encore et si elle doit masquer les boutons d'écriture.
      case 'moi': {
        await admin.from('siege_utilisateurs').update({ vu_le: new Date().toISOString() }).eq('user_id', siege.userId);
        if (corps.connexion === true) await tracer(admin, siege, 'CONNEXION_SIEGE', {});
        return jsonCors({ ...siege });
      }

      case 'restaurants': {
        return jsonCors({ restaurants: await restaurantsGroupe(admin) });
      }

      // -- Tableau de bord : les 7 restaurants sur une période, plus la
      // -- tendance jour par jour. Les sites non enrôlés sortent à zéro, avec
      // -- le drapeau qui explique pourquoi.
      case 'tableau_bord': {
        const { debut, fin } = periode(corps);
        const restos = await restaurantsGroupe(admin);

        const [ventes, parJour] = await Promise.all([
          admin.rpc('siege_ventes', { p_debut: debut, p_fin: fin }),
          admin.rpc('siege_ventes_jour', { p_debut: debut, p_fin: fin }),
        ]);
        if (ventes.error) throw new Error('Lecture des ventes impossible');
        if (parJour.error) throw new Error('Lecture de la tendance impossible');

        type LigneVente = {
          restaurant_id: string;
          nb_commandes: number;
          ca: number;
          nb_annulees: number;
          remises: number;
          panier_moyen: number;
        };
        const parResto = new Map<string, LigneVente>();
        for (const v of (ventes.data ?? []) as LigneVente[]) parResto.set(v.restaurant_id, v);

        const lignes = restos.map((r) => {
          const v = r.restaurant_id ? parResto.get(r.restaurant_id) : undefined;
          return {
            ...r,
            nb_commandes: v?.nb_commandes ?? 0,
            ca: v?.ca ?? 0,
            nb_annulees: v?.nb_annulees ?? 0,
            remises: v?.remises ?? 0,
            panier_moyen: v?.panier_moyen ?? 0,
          };
        });

        return jsonCors({
          periode: { debut, fin },
          total: lignes.reduce((s, l) => s + l.ca, 0),
          restaurants: lignes,
          tendance: parJour.data ?? [],
          // Ce que la console doit dire à l'écran plutôt que d'afficher 0 F sans
          // explication : personne ne synchronise encore.
          aucun_site_enrole: lignes.every((l) => !l.enrole),
        });
      }

      case 'clotures': {
        const { debut, fin } = periode(corps);
        const { data, error } = await admin.rpc('siege_clotures', { p_debut: debut, p_fin: fin });
        if (error) throw new Error('Lecture des clôtures impossible');
        return jsonCors({ clotures: data ?? [] });
      }

      // -- Le rapport Z complet d'une clôture, à la demande (il est volumineux).
      case 'rapport_z': {
        const serviceId = String(corps.service_id ?? '');
        const restaurantId = String(corps.restaurant_id ?? '');
        if (!serviceId || !restaurantId) return jsonCors({ erreur: 'Clôture non précisée' }, 400);
        const { data, error } = await admin
          .from('services_caisse')
          .select('*')
          .eq('restaurant_id', restaurantId)
          .eq('id', serviceId)
          .maybeSingle();
        if (error) throw new Error('Lecture du rapport impossible');
        if (!data) return jsonCors({ erreur: 'Clôture introuvable' }, 404);
        return jsonCors({ cloture: data });
      }

      // -- Équipe : lue chez SamerTrackly, qui en est maître (décision du
      // -- 2026-08-16). La console est une façade, pas une seconde source.
      case 'equipe': {
        const restos = await restaurantsGroupe(admin);
        const travailleurs = (await samtrackly(
          'travailleurs?select=id,nom,poste,contact,photo_url,actif,restaurant_id&archived_at=is.null&order=nom',
        )) as { id: string; nom: string | null; restaurant_id: string | null }[];

        const nomParST = new Map(restos.map((r) => [r.samtrackly_id, r.nom]));
        return jsonCors({
          employes: travailleurs.map((t) => ({
            ...t,
            restaurant_nom: t.restaurant_id ? nomParST.get(t.restaurant_id) ?? null : null,
          })),
        });
      }

      default:
        return jsonCors({ erreur: `Action inconnue : ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof ErreurAuth) return jsonCors({ erreur: e.message }, 403);
    return jsonCors({ erreur: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
});
