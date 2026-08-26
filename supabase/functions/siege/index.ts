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
  exigeAdmin,
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

      /**
       * Tableau de bord — TOUT en une requête.
       *
       * Chaque bloc est une fonction SQL `siege_*` : l'agrégation se fait dans
       * PostgreSQL, jamais ici. Un mois de ventes sur 7 restaurants fait
       * ~10 000 lignes de `commandes` ; les remonter dans Deno pour les
       * additionner en JavaScript serait lent et exposé à la troncature de
       * PostgREST. Agrégées, elles tiennent en quelques dizaines de lignes.
       *
       * La PÉRIODE PRÉCÉDENTE est calculée en même temps, de même durée : sans
       * elle, un chiffre d'affaires est un nombre sans repère. C'est le seul
       * calcul de comparaison que fait cet écran — aucune soustraction entre CA
       * et dépenses n'est faite nulle part, le POS ne connaît que les sorties
       * de caisse et un « bénéfice » calculé ici serait toujours optimiste.
       */
      case 'tableau_bord': {
        const { debut, fin } = periode(corps);
        const duree = new Date(fin).getTime() - new Date(debut).getTime();
        const debutPrec = new Date(new Date(debut).getTime() - duree).toISOString();

        const bornes = { p_debut: debut, p_fin: fin };
        const restos = await restaurantsGroupe(admin);

        const [
          ventes, parJour, ventesPrec, heures, plats, modes, types,
          tables, retours, depenses, ecarts, equipe, remises, annulations, inventaire,
          livraisons,
        ] = await Promise.all([
          admin.rpc('siege_ventes', bornes),
          admin.rpc('siege_ventes_jour', bornes),
          admin.rpc('siege_ventes', { p_debut: debutPrec, p_fin: debut }),
          admin.rpc('siege_ventes_heure', bornes),
          admin.rpc('siege_top_plats', bornes),
          admin.rpc('siege_par_mode', bornes),
          admin.rpc('siege_par_type', bornes),
          admin.rpc('siege_tables', bornes),
          admin.rpc('siege_retours', bornes),
          admin.rpc('siege_depenses', bornes),
          admin.rpc('siege_ecarts_caissier', bornes),
          admin.rpc('siege_equipe_periode', bornes),
          admin.rpc('siege_remises', bornes),
          admin.rpc('siege_annulations', bornes),
          admin.rpc('siege_inventaire', bornes),
          admin.rpc('siege_livraisons_caissier', bornes),
        ]);

        // Absents : état COURANT de la fiche employé, pas un historique — le
        // POS ne garde pas trace des disponibilités passées. L'écran le dit,
        // plutôt que de laisser croire à une absence sur toute la période.
        const absents = await admin
          .from('utilisateurs_site')
          .select('id, restaurant_id, nom_complet, poste, disponibilite')
          .neq('disponibilite', 'PRESENT')
          .not('disponibilite', 'is', null)
          .eq('actif', true)
          .limit(200);

        // Une fonction absente (migration pas encore passée) ne doit pas faire
        // échouer TOUT l'écran : le bloc concerné sort vide, le reste s'affiche.
        // Le siège verra un trou, pas une page d'erreur.
        const lignesDe = (r: { data: unknown; error: unknown }): Record<string, unknown>[] =>
          r.error ? [] : ((r.data ?? []) as Record<string, unknown>[]);

        if (ventes.error) throw new Error('Lecture des ventes impossible');

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
        const precParResto = new Map<string, LigneVente>();
        for (const v of ((ventesPrec.error ? [] : ventesPrec.data) ?? []) as LigneVente[]) {
          precParResto.set(v.restaurant_id, v);
        }

        const lignes = restos.map((r) => {
          const v = r.restaurant_id ? parResto.get(r.restaurant_id) : undefined;
          const p = r.restaurant_id ? precParResto.get(r.restaurant_id) : undefined;
          return {
            ...r,
            nb_commandes: v?.nb_commandes ?? 0,
            ca: v?.ca ?? 0,
            nb_annulees: v?.nb_annulees ?? 0,
            remises: v?.remises ?? 0,
            panier_moyen: v?.panier_moyen ?? 0,
            ca_precedent: p?.ca ?? 0,
            nb_commandes_precedent: p?.nb_commandes ?? 0,
          };
        });

        return jsonCors({
          periode: { debut, fin, debut_precedent: debutPrec },
          total: lignes.reduce((s, l) => s + l.ca, 0),
          total_precedent: lignes.reduce((s, l) => s + l.ca_precedent, 0),
          restaurants: lignes,
          tendance: lignesDe(parJour),
          heures: lignesDe(heures),
          plats: lignesDe(plats),
          modes: lignesDe(modes),
          types: lignesDe(types),
          tables: lignesDe(tables),
          retours: lignesDe(retours),
          depenses: lignesDe(depenses),
          ecarts: lignesDe(ecarts),
          equipe: lignesDe(equipe),
          remises: lignesDe(remises),
          annulations: lignesDe(annulations),
          inventaire: lignesDe(inventaire),
          // Livraisons partenaires par caissier : commandes, contacts recueillis
          // et n° de commande partenaire. L'écart entre `nb` et `contacts` est
          // le nombre de courses qu'on ne saura rattacher à personne.
          livraisons: lignesDe(livraisons),
          absents: absents.error ? [] : (absents.data ?? []),
          // Ce que la console doit dire à l'écran plutôt que d'afficher 0 F sans
          // explication : personne ne synchronise encore.
          aucun_site_enrole: lignes.every((l) => !l.enrole),
          // Le référentiel de salle ne monte qu'après `pnpm salle:republier` :
          // sans lui, `siege_tables` rend des `numero` NULL. On le dit au front
          // plutôt que de lui laisser afficher des uuid.
          salle_non_publiee: lignesDe(tables).length > 0 && lignesDe(tables).every((t) => !t.numero),
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

      // -- Équipe D'UN SERVICE, nominative : qui était là, arrivé quand, parti
      // -- quand. Le rapport Z figé ne porte que les trois COMPTEURS
      // -- (présents / restent / partis) ; les noms et les heures vivent dans
      // -- `equipe_service`, qui remonte. On la lit donc à la demande, ce qui a
      // -- l'avantage de marcher aussi sur les clôtures DÉJÀ passées.
      case 'equipe_service': {
        const serviceId = String(corps.service_id ?? '');
        const restaurantId = String(corps.restaurant_id ?? '');
        if (!serviceId || !restaurantId) return jsonCors({ erreur: 'Service non précisé' }, 400);

        const { data: membres, error } = await admin
          .from('equipe_service')
          .select('utilisateur_id, poste_jour, pointe_le, reste')
          .eq('restaurant_id', restaurantId)
          .eq('service_id', serviceId);
        if (error) throw new Error('Lecture de l’équipe impossible');

        const ids = [...new Set((membres ?? []).map((m) => m.utilisateur_id).filter(Boolean))] as string[];

        // Les noms viennent de `utilisateurs_site` et NON de `utilisateurs` : le
        // siège ne mélange pas ce que les sites publient avec sa propre table
        // (SamerTrackly est maître de la fiche employé).
        const [fiches, salaires] = await Promise.all([
          ids.length
            ? admin
                .from('utilisateurs_site')
                .select('id, nom_complet, poste, taux_journalier')
                .eq('restaurant_id', restaurantId)
                .in('id', ids)
            : Promise.resolve({ data: [], error: null }),
          // L'heure de PAIE fait foi comme heure de départ pour qui est payé à
          // la journée : le paiement crée une ligne de dépense catégorie
          // SALAIRES, non supprimable, datée. Pour les autres, c'est la clôture
          // du service — la console le dit à l'écran plutôt que de laisser
          // croire à une heure pointée.
          admin
            .from('depenses')
            .select('agent_id, montant, created_at, supprime')
            .eq('restaurant_id', restaurantId)
            .eq('service_id', serviceId)
            .eq('categorie', 'SALAIRES'),
        ]);
        if (fiches.error) throw new Error('Lecture des fiches impossible');
        if (salaires.error) throw new Error('Lecture des salaires impossible');

        const parId = new Map((fiches.data ?? []).map((u) => [u.id as string, u]));
        const payePar = new Map<string, { montant: number; paye_le: string }>();
        for (const d of (salaires.data ?? []) as
          { agent_id: string | null; montant: number; created_at: string; supprime: boolean | null }[]) {
          if (!d.agent_id || d.supprime) continue;
          const dejaVu = payePar.get(d.agent_id);
          // Plusieurs lignes pour la même personne (paie + rattrapage) : on
          // additionne, et on garde la DERNIÈRE heure — c'est celle du départ.
          payePar.set(d.agent_id, {
            montant: (dejaVu?.montant ?? 0) + Number(d.montant ?? 0),
            paye_le: !dejaVu || d.created_at > dejaVu.paye_le ? d.created_at : dejaVu.paye_le,
          });
        }

        return jsonCors({
          membres: (membres ?? []).map((m) => {
            const fiche = parId.get(m.utilisateur_id as string);
            const paye = payePar.get(m.utilisateur_id as string) ?? null;
            return {
              utilisateur_id: m.utilisateur_id,
              nom_complet: (fiche?.nom_complet as string | null) ?? null,
              poste: m.poste_jour ?? (fiche?.poste as string | null) ?? null,
              taux_journalier: (fiche?.taux_journalier as number | null) ?? null,
              arrive_le: m.pointe_le,
              /** NULL = pas encore tranché ; à la clôture, tout ce qui n'est pas `true` est PARTI. */
              reste: m.reste,
              salaire: paye,
            };
          }),
        });
      }

      // -- CATALOGUE : les catégories de chaque site, PAR NOM.
      // --
      // -- Le nom et non l'id : chaque site a importé son catalogue localement,
      // -- ses `categories.id` lui sont propres. « Pizzas » existe partout, sous
      // -- sept identifiants différents. Diffuser un article suppose donc de
      // -- retrouver, restaurant par restaurant, l'id de SA catégorie — c'est ce
      // -- que cet écran prépare, et c'est déjà l'idiome du POS (la couleur de
      // -- catégorie et le routage d'impression se déduisent eux aussi du nom).
      case 'catalogue_categories': {
        const { data, error } = await admin
          .from('categories')
          .select('restaurant_id, id, nom, actif')
          .eq('actif', true)
          .order('nom');
        if (error) throw new Error('Lecture des catégories impossible');
        return jsonCors({ categories: data ?? [] });
      }

      // -- Diffuser un article vers UN ou PLUSIEURS restaurants.
      // --
      // -- Écriture dans les tables du cloud, que chaque site tire par la
      // -- descente CATALOGUE (moins de 5 min). On n'invente aucun canal : un
      // -- trigger cloud bump `version`, et sync-pull sert les lignes dont
      // -- `version > N` au restaurant concerné.
      // --
      // -- L'article porte le MÊME uuid sur tous les sites visés : c'est la
      // -- convention déjà retenue pour `produits_inventaire` — l'identifiant
      // -- reste le même du siège jusqu'aux caisses, sans quoi rien ne
      // -- rattacherait le plat d'un restaurant à celui du voisin.
      case 'catalogue_diffuser': {
        exigeAdmin(siege);

        const nom = String(corps.nom ?? '').trim();
        const prix = Number(corps.prix_base ?? NaN);
        const cibles = Array.isArray(corps.cibles) ? (corps.cibles as { restaurant_id: string; categorie_id: string }[]) : [];
        const description = corps.description ? String(corps.description).trim() : null;
        const imageUrl = corps.image_url ? String(corps.image_url).trim() : null;

        if (!nom) return jsonCors({ erreur: 'Le nom de l’article est obligatoire' }, 400);
        if (!Number.isInteger(prix) || prix < 0) {
          return jsonCors({ erreur: 'Le prix doit être un entier en FCFA, sans centimes' }, 400);
        }
        if (cibles.length === 0) return jsonCors({ erreur: 'Choisissez au moins un restaurant' }, 400);
        for (const c of cibles) {
          if (!c?.restaurant_id || !c?.categorie_id) {
            return jsonCors({ erreur: 'Un des restaurants n’a pas de catégorie correspondante' }, 400);
          }
        }

        // Un seul uuid pour tout le lot.
        const articleId = crypto.randomUUID();
        const lignes = cibles.map((c) => ({
          restaurant_id: c.restaurant_id,
          id: articleId,
          categorie_id: c.categorie_id,
          nom,
          description,
          prix_base: prix,
          image_url: imageUrl,
          disponible: true,
          actif: true,
          updated_at: new Date().toISOString(),
        }));

        // Conflit TOUJOURS préfixé par restaurant_id : les uuid du catalogue ne
        // sont uniques que PAR SITE, un upsert sur `id` seul réécrirait la ligne
        // — et le restaurant_id — d'un autre restaurant.
        const { error } = await admin.from('articles').upsert(lignes, { onConflict: 'restaurant_id,id' });
        if (error) throw new Error(`Diffusion impossible : ${error.message}`);

        await tracer(admin, siege, 'CATALOGUE_DIFFUSER', {
          entite: 'articles',
          entiteId: articleId,
          portee: cibles.map((c) => c.restaurant_id),
          meta: { nom, prix_base: prix, nb_restaurants: cibles.length },
        });

        return jsonCors({ article_id: articleId, diffuse_vers: cibles.length });
      }

      // -- RÔLES : ce que chaque restaurant donne à chaque rôle.
      // --
      // -- Les sites publient `roles` et `role_permissions` par la montée ; le
      // -- siège les relit ici pour montrer les DIVERGENCES — quel restaurant a
      // -- donné la remise à ses caissiers, lequel ne l'a pas.
      case 'roles_groupe': {
        const [roles, perms] = await Promise.all([
          admin.from('roles').select('restaurant_id, id, nom, systeme, actif'),
          admin.from('role_permissions').select('restaurant_id, role_id, permissions'),
        ]);
        if (roles.error) throw new Error('Lecture des rôles impossible');
        if (perms.error) throw new Error('Lecture des permissions impossible');

        const parRole = new Map<string, string[]>();
        for (const p of (perms.data ?? []) as { restaurant_id: string; role_id: string; permissions: unknown }[]) {
          parRole.set(
            `${p.restaurant_id}:${p.role_id}`,
            Array.isArray(p.permissions) ? (p.permissions as unknown[]).filter((x): x is string => typeof x === 'string') : [],
          );
        }
        return jsonCors({
          roles: (roles.data ?? []).map((r) => ({
            ...r,
            permissions: parRole.get(`${r.restaurant_id}:${r.id}`) ?? [],
          })),
        });
      }

      // -- Diffuser un jeu de permissions vers plusieurs restaurants.
      // --
      // -- Comme pour un article, le siège vise un rôle PAR SON NOM et la
      // -- console a résolu l'id propre à chaque site : `roles.nom` est UNIQUE
      // -- en local, y pousser un uuid étranger casserait toute la descente.
      // --
      // -- Les gardes du POS sont reprises telles quelles. Elles ne sont pas
      // -- décoratives : diffuser un mauvais jeu sur 7 restaurants d'un clic est
      // -- exactement le geste qui enferme tout le monde dehors.
      case 'roles_diffuser': {
        exigeAdmin(siege);

        const nomRole = String(corps.role_nom ?? '').trim();
        const cibles = Array.isArray(corps.cibles) ? (corps.cibles as { restaurant_id: string; role_id: string }[]) : [];
        const demandees = Array.isArray(corps.permissions)
          ? (corps.permissions as unknown[]).filter((p): p is string => typeof p === 'string')
          : [];

        if (!nomRole) return jsonCors({ erreur: 'Rôle non précisé' }, 400);
        if (cibles.length === 0) return jsonCors({ erreur: 'Choisissez au moins un restaurant' }, 400);

        // Rôles VERROUILLÉS : le propriétaire et le superviseur ne se modifient
        // pas, ici pas plus que depuis la caisse.
        if (['PROPRIETAIRE', 'SUPERVISEUR'].includes(nomRole.toUpperCase())) {
          return jsonCors({ erreur: 'Le compte propriétaire est protégé' }, 403);
        }
        // Permission PROTÉGÉE : « Rôles & accès » ne s'attribue à aucun autre
        // rôle — sinon n'importe qui peut se donner tout le reste.
        if (demandees.includes('roles.gerer')) {
          return jsonCors({ erreur: 'La permission « Rôles & accès » ne peut pas être attribuée à ce rôle' }, 403);
        }

        const permissions = [...new Set(demandees)];
        const lignes = cibles.map((c) => ({
          restaurant_id: c.restaurant_id,
          id: c.role_id, // `role_permissions.id` = role_id côté cloud
          role_id: c.role_id,
          permissions,
        }));

        const { error } = await admin.from('role_permissions').upsert(lignes, { onConflict: 'restaurant_id,id' });
        if (error) throw new Error(`Diffusion impossible : ${error.message}`);

        await tracer(admin, siege, 'ROLES_DIFFUSER', {
          entite: 'role_permissions',
          entiteId: nomRole,
          portee: cibles.map((c) => c.restaurant_id),
          meta: { role_nom: nomRole, nb_permissions: permissions.length, permissions },
        });

        return jsonCors({ diffuse_vers: cibles.length, permissions: permissions.length });
      }

      // -- Créer une CATÉGORIE et la diffuser vers un ou plusieurs restaurants.
      // --
      // -- Le catalogue ne voyage QUE vers le bas : le cloud est maître, les
      // -- sites ne publient ni `categories` ni `articles` (absentes de la liste
      // -- de montée comme des tables publiables du POS). Le siège ne peut donc
      // -- pas savoir ce qu'un site a déjà en local — et `categories.nom` n'y est
      // -- pas unique : créer « Pizzas » sur un site qui en a déjà une lui en
      // -- donnera DEUX. La console le dit à l'écran ; elle ne peut pas le
      // -- vérifier à sa place.
      case 'categorie_creer': {
        exigeAdmin(siege);

        const nom = String(corps.nom ?? '').trim();
        const ordre = Number.isInteger(corps.ordre) ? (corps.ordre as number) : 0;
        const restaurants = Array.isArray(corps.restaurants) ? (corps.restaurants as string[]) : [];

        if (!nom) return jsonCors({ erreur: 'Le nom de la catégorie est obligatoire' }, 400);
        if (restaurants.length === 0) return jsonCors({ erreur: 'Choisissez au moins un restaurant' }, 400);

        // Un seul uuid pour tout le lot : la catégorie créée au siège porte le
        // même identifiant sur toutes les caisses visées, comme le reste du
        // catalogue diffusé.
        const categorieId = crypto.randomUUID();
        const lignes = restaurants.map((restaurant_id) => ({
          restaurant_id,
          id: categorieId,
          parent_id: null,
          nom,
          ordre,
          actif: true,
        }));

        const { error } = await admin.from('categories').upsert(lignes, { onConflict: 'restaurant_id,id' });
        if (error) throw new Error(`Création impossible : ${error.message}`);

        await tracer(admin, siege, 'CATEGORIE_CREER', {
          entite: 'categories',
          entiteId: categorieId,
          portee: restaurants,
          meta: { nom, ordre, nb_restaurants: restaurants.length },
        });

        return jsonCors({ categorie_id: categorieId, diffuse_vers: restaurants.length });
      }

      // -- PHOTO D'ARTICLE : une URL de téléversement signée.
      // --
      // -- Le fichier ne transite PAS par cette fonction. Elle signe une URL,
      // -- le navigateur y dépose l'image en direct : une photo de 2 Mo en
      // -- base64 dans un corps JSON, c'est 2,7 Mo de payload et une fonction
      // -- qui recopie l'octet pour rien.
      // --
      // -- Le bucket est créé à la première photo. `createBucket` échoue si le
      // -- bucket existe : on avale cette erreur-là, et elle seule.
      case 'photo_signer': {
        exigeAdmin(siege);

        const extension = String(corps.extension ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
        if (!EXTENSIONS.includes(extension)) {
          return jsonCors({ erreur: 'Format d’image non accepté (jpg, png, webp ou avif)' }, 400);
        }

        const bucket = 'photos';
        const { error: erreurBucket } = await admin.storage.createBucket(bucket, { public: true });
        // « already exists » est le cas NORMAL dès la deuxième photo.
        if (erreurBucket && !/exist/i.test(erreurBucket.message)) {
          throw new Error(`Espace de stockage indisponible : ${erreurBucket.message}`);
        }

        const chemin = `articles/${crypto.randomUUID()}.${extension}`;
        const { data, error } = await admin.storage.from(bucket).createSignedUploadUrl(chemin);
        if (error || !data) throw new Error('Impossible de préparer le téléversement');

        const { data: publique } = admin.storage.from(bucket).getPublicUrl(chemin);
        return jsonCors({
          bucket,
          chemin: data.path,
          jeton: data.token,
          url_publique: publique.publicUrl,
        });
      }

      // -- SÉQUENCES : où en est la journée de chaque restaurant.
      // --
      // -- Une séquence ouverte depuis douze heures, c'est un gérant qui a
      // -- oublié de raser. C'est ce que cet écran vient montrer — et les
      // -- shifts qu'elle contient, parce qu'on ne rase pas ce qu'on ne voit pas.
      case 'sequences_groupe': {
        const [seqs, shifts, ordres] = await Promise.all([
          admin
            .from('sequences_caisse')
            .select('restaurant_id, id, ouverte_le, cloturee_le, statut')
            .eq('statut', 'OUVERTE'),
          // Borné : sans limite, PostgREST tronque en silence sur un site qui
          // tourne depuis des mois, et la séquence perdrait des shifts.
          admin
            .from('services_caisse')
            .select('restaurant_id, id, sequence_id, caissier_id, ouvert_le, cloture_le, statut, ecart, rapport_z')
            .order('ouvert_le', { ascending: false })
            .limit(500),
          admin
            .from('ordres_site')
            .select('id, restaurant_id, type, params, demandeur, statut, cree_le, execute_le, erreur')
            .order('cree_le', { ascending: false })
            .limit(50),
        ]);
        if (seqs.error) throw new Error('Lecture des séquences impossible');
        if (shifts.error) throw new Error('Lecture des shifts impossible');
        if (ordres.error) throw new Error('Lecture des ordres impossible');

        // Le total d'un shift se lit dans son rapport Z figé : le cloud n'a pas
        // de colonne de vente sur `services_caisse`, et refaire la somme des
        // paiements ici donnerait un chiffre qui pourrait différer du ticket.
        type Shift = {
          restaurant_id: string;
          id: string;
          sequence_id: string | null;
          caissier_id: string | null;
          ouvert_le: string;
          cloture_le: string | null;
          statut: string;
          ecart: number | null;
          rapport_z: { caissier?: string; vente_totale?: number } | null;
        };

        return jsonCors({
          sequences: (seqs.data ?? []).map((sq) => ({
            restaurant_id: sq.restaurant_id,
            sequence_id: sq.id,
            ouverte_le: sq.ouverte_le,
            shifts: ((shifts.data ?? []) as Shift[])
              .filter((s) => s.restaurant_id === sq.restaurant_id && s.sequence_id === sq.id)
              .map((s) => ({
                service_id: s.id,
                caissier: s.rapport_z?.caissier ?? null,
                ouvert_le: s.ouvert_le,
                cloture_le: s.cloture_le,
                statut: s.statut,
                ecart: s.ecart,
                vente_totale: s.rapport_z?.vente_totale ?? null,
              })),
          })),
          ordres: ordres.data ?? [],
        });
      }

      // -- Créer un ORDRE pour un site. Rien n'est exécuté ici : la ligne est
      // -- posée dans la file, le site viendra la chercher à son prochain cycle
      // -- (30 s) et rendra compte. Le siège ne peut pas joindre un mini-PC
      // -- derrière la box d'un restaurant.
      case 'ordre_creer': {
        exigeAdmin(siege);

        const restaurantId = String(corps.restaurant_id ?? '');
        const type = String(corps.type ?? '');
        if (!restaurantId) return jsonCors({ erreur: 'Restaurant non précisé' }, 400);
        if (type !== 'RASER_SEQUENCE') return jsonCors({ erreur: `Ordre inconnu : ${type}` }, 400);

        const sequenceId = String((corps.params as Record<string, unknown>)?.sequence_id ?? '');
        if (!sequenceId) {
          return jsonCors({ erreur: 'La séquence à raser doit être précisée' }, 400);
        }

        // Un seul ordre de rasage en attente par site : deux ordres empilés, le
        // second raserait la séquence SUIVANTE. Le garde-fou d'obsolescence
        // côté POS le refuserait, mais mieux vaut ne pas le créer.
        const { data: dejaEnAttente } = await admin
          .from('ordres_site')
          .select('id')
          .eq('restaurant_id', restaurantId)
          .eq('type', 'RASER_SEQUENCE')
          .eq('statut', 'EN_ATTENTE')
          .limit(1);
        if (dejaEnAttente && dejaEnAttente.length > 0) {
          return jsonCors({ erreur: 'Un rasage est déjà en attente pour ce restaurant' }, 409);
        }

        const id = crypto.randomUUID();
        const { error } = await admin.from('ordres_site').insert({
          id,
          restaurant_id: restaurantId,
          type,
          params: corps.params ?? {},
          demandeur: siege.nomComplet,
          demandeur_id: siege.userId,
        });
        if (error) throw new Error(`Création de l’ordre impossible : ${error.message}`);

        await tracer(admin, siege, 'ORDRE_RASER_SEQUENCE', {
          entite: 'ordres_site',
          entiteId: id,
          portee: [restaurantId],
          meta: { sequence_id: sequenceId, service_ids: (corps.params as Record<string, unknown>)?.service_ids ?? null },
        });

        return jsonCors({ ordre_id: id });
      }

      default:
        return jsonCors({ erreur: `Action inconnue : ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof ErreurAuth) return jsonCors({ erreur: e.message }, 403);
    return jsonCors({ erreur: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
});
