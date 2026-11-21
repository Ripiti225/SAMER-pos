// Edge Function `promo` — codes promo « cartes colis » (brief PROMO, § 4).
//
// Deux portes, deux authentifications :
//   * le SITE SAMER DELIV, depuis son serveur : secret partagé dans l'en-tête
//     `x-promo-secret`, IP du client dans `x-client-ip` (le cloud ne voit que
//     celle de Vercel). Actions `consulter`, `activer`, `verifier`, `reserver`.
//     Limite : 10 codes faux par IP et par heure, puis 1 h de blocage.
//   * la CONSOLE DU SIÈGE : jeton de session, comme la fonction `siege`.
//     Actions `lots`, `lot_creer`, `lot_annuler`, `lot_codes`, `relances`,
//     `restaurants_promo`, `restaurant_promo_modifier`, `exclusions`,
//     `categorie_exclure`.
//
// Ce que cette fonction NE FAIT JAMAIS : passer un code en UTILISE. Seule la
// caisse consomme un code (R10), hors ligne, et le remonte par l'outbox.
//
// Sans le secret `PROMO_SECRET_SITE` posé sur le projet, la porte du site
// reste fermée : tout appel y répond 401.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  clientAdmin,
  ENTETES_CORS,
  ErreurAuth,
  exigeAdmin,
  json,
  jsonCors,
  sha256Hex,
  verifierSiege,
  type Siege,
} from '../_shared/auth.ts';
import {
  codesUtilisablesParNumero,
  decisionActivation,
  FENETRE_ESSAIS_MS,
  ESSAIS_MAX,
  finBlocage,
  lireFicheRestaurant,
  lireLignes,
  lireLot,
  masquerCode,
  MESSAGES,
  normaliserCode,
  normaliserTelephone,
  refusActivation,
  refusUtilisation,
  remiseEstimee,
  RESERVATION_SITE_MS,
  type CodeLu,
  type LotLu,
  type Motif,
} from '../_shared/promo.ts';
import { uuidValide } from '../_shared/siege-recettes.ts';

const SECRET_SITE = Deno.env.get('PROMO_SECRET_SITE') ?? '';
const ACTIONS_SITE = new Set(['consulter', 'activer', 'verifier', 'reserver']);

const COLONNES_CODE = 'restaurant_id, id, lot_id, code, statut, telephone';
const COLONNES_LOT = 'restaurant_id, id, pourcentage, valide_du, valide_au, annule_le';
const COLONNES_RESTO = 'restaurant_id, nom, marque, telephone, adresse, slug_site';

type CodeLigne = CodeLu & { lot_id: string };
type LotLigne = LotLu & { restaurant_id: string; id: string };

/** Réponse d'une action du site. `echec` = code faux, compté pour la limite d'essais. */
interface ResultatSite {
  corps: Record<string, unknown>;
  echec?: boolean;
}

function refus(motif: Motif, echec = false): ResultatSite {
  return { corps: { ok: false, motif, message: MESSAGES[motif] }, echec };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: ENTETES_CORS });
  if (req.method !== 'POST') return jsonCors({ erreur: 'Méthode non autorisée' }, 405);

  let corps: Record<string, unknown>;
  try {
    corps = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ erreur: 'Requête invalide' }, 400);
  }
  const action = String(corps.action ?? '');
  const admin = clientAdmin();

  if (ACTIONS_SITE.has(action)) return porteSite(admin, req, action, corps);
  return porteConsole(admin, req, action, corps);
});

// ---------------------------------------------------------------------------
// Porte du site
// ---------------------------------------------------------------------------

/** Comparaison à temps constant, sur les empreintes pour égaliser les longueurs. */
async function secretValide(fourni: string | null): Promise<boolean> {
  if (!SECRET_SITE || !fourni) return false;
  const [a, b] = await Promise.all([sha256Hex(fourni), sha256Hex(SECRET_SITE)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function porteSite(
  admin: SupabaseClient,
  req: Request,
  action: string,
  corps: Record<string, unknown>,
): Promise<Response> {
  if (!(await secretValide(req.headers.get('x-promo-secret')))) return json({ erreur: 'Accès refusé' }, 401);
  const ip = (req.headers.get('x-client-ip') ?? '').trim();
  if (!ip || ip.length > 64) return json({ erreur: 'IP du client manquante' }, 400);

  try {
    // L'IP n'est jamais stockée : seulement son empreinte, salée par le secret.
    const empreinte = await sha256Hex(`${SECRET_SITE}:${ip}`);
    const maintenant = new Date();
    const { data: essais, error } = await admin
      .from('promo_essais')
      .select('essai_le')
      .eq('ip_empreinte', empreinte)
      .eq('reussi', false)
      .gte('essai_le', new Date(maintenant.getTime() - 2 * FENETRE_ESSAIS_MS).toISOString())
      .order('essai_le', { ascending: false })
      .limit(ESSAIS_MAX);
    if (error) throw new Error('Lecture des essais impossible');
    if (finBlocage((essais ?? []).map((e) => new Date(e.essai_le as string)), maintenant)) {
      return json(refus('RATE_LIMITED').corps, 429);
    }

    const resultat =
      action === 'consulter'
        ? await consulter(admin, corps, maintenant)
        : action === 'activer'
          ? await activer(admin, corps, maintenant)
          : action === 'verifier'
            ? await verifier(admin, corps, maintenant, false)
            : await verifier(admin, corps, maintenant, true);

    // Pendant un blocage, rien n'est noté : sinon il ne finirait jamais.
    await admin.from('promo_essais').insert({ ip_empreinte: empreinte, reussi: !resultat.echec });
    return json(resultat.corps);
  } catch (e) {
    return json({ erreur: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
}

async function lireCode(admin: SupabaseClient, code: string): Promise<{ code: CodeLigne; lot: LotLigne } | null> {
  const { data, error } = await admin.from('promo_codes').select(COLONNES_CODE).eq('code', code).maybeSingle();
  if (error) throw new Error('Lecture du code impossible');
  if (!data) return null;
  const ligne = data as CodeLigne;
  const { data: lot, error: e2 } = await admin
    .from('promo_lots')
    .select(COLONNES_LOT)
    .eq('restaurant_id', ligne.restaurant_id)
    .eq('id', ligne.lot_id)
    .single();
  if (e2) throw new Error('Lecture du lot impossible');
  return { code: ligne, lot: lot as LotLigne };
}

async function lireRestaurant(admin: SupabaseClient, colonne: 'restaurant_id' | 'slug_site', valeur: string) {
  const { data, error } = await admin.from('restaurants').select(COLONNES_RESTO).eq(colonne, valeur).eq('actif', true).maybeSingle();
  if (error) throw new Error('Lecture du restaurant impossible');
  return data as { restaurant_id: string; nom: string; marque: string; telephone: string | null; adresse: string | null; slug_site: string | null } | null;
}

/**
 * Noms des catégories exclues du restaurant (« Hors Chawarma »), pour que la
 * page dise la vérité quand le siège change les exclusions. Les combos qui
 * contiennent un article exclu le sont aussi, sans être listés ici.
 */
async function lireExclusions(admin: SupabaseClient, restaurantId: string): Promise<string[]> {
  const { data, error } = await admin
    .from('promo_categories_exclues')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('exclue', true);
  if (error) throw new Error('Lecture des exclusions impossible');
  const ids = (data ?? []).map((l) => (l as { id: string }).id);
  if (ids.length === 0) return [];
  const { data: categories, error: e2 } = await admin
    .from('categories')
    .select('nom')
    .eq('restaurant_id', restaurantId)
    .in('id', ids);
  if (e2) throw new Error('Lecture des catégories impossible');
  return (categories ?? [])
    .map((c) => (c as { nom: string | null }).nom?.trim())
    .filter((nom): nom is string => !!nom)
    .sort((a, b) => a.localeCompare(b, 'fr'));
}

/** Ce que la page d'activation affiche avant que le client tape son numéro. */
async function consulter(admin: SupabaseClient, corps: Record<string, unknown>, maintenant: Date): Promise<ResultatSite> {
  const code = normaliserCode(corps.code);
  const lu = code ? await lireCode(admin, code) : null;
  if (!lu) return refus('INVALID', true);
  const resto = await lireRestaurant(admin, 'restaurant_id', lu.code.restaurant_id);
  if (!resto) return refus('INVALID', true);

  const motif = refusActivation(lu.code, lu.lot, maintenant);
  return {
    corps: {
      ok: motif === null,
      ...(motif ? { motif, message: MESSAGES[motif] } : {}),
      deja_garde: lu.code.telephone !== null,
      restaurant: resto,
      pourcentage: lu.lot.pourcentage,
      valide_du: lu.lot.valide_du,
      valide_au: lu.lot.valide_au,
      exclusions: await lireExclusions(admin, resto.restaurant_id),
    },
  };
}

/** R11 + R13 : le client garde son code sur son numéro. */
async function activer(admin: SupabaseClient, corps: Record<string, unknown>, maintenant: Date): Promise<ResultatSite> {
  const code = normaliserCode(corps.code);
  const lu = code ? await lireCode(admin, code) : null;
  if (!lu) return refus('INVALID', true);
  const telephone = normaliserTelephone(corps.telephone);
  if (!telephone) return refus('INVALID_PHONE');

  let decision = decisionActivation(lu.code, lu.lot, telephone, corps.consentement === true, maintenant);
  if ('motif' in decision) return refus(decision.motif);

  if (!decision.deja) {
    // `telephone IS NULL` dans la condition : si deux numéros activent le même
    // code au même instant, un seul UPDATE trouve la ligne.
    const { data, error } = await admin
      .from('promo_codes')
      .update({ telephone, active_le: maintenant.toISOString(), consentement_relance: true })
      .eq('restaurant_id', lu.code.restaurant_id)
      .eq('id', lu.code.id)
      .is('telephone', null)
      .in('statut', ['DISPONIBLE', 'RESERVE'])
      .select('id');
    if (error) throw new Error('Activation impossible');
    if (!data || data.length === 0) {
      // Course perdue : on relit. Le même numéro a pu gagner (double clic), ou
      // un autre numéro, ou le code a été utilisé ou annulé entre-temps.
      const relu = await lireCode(admin, lu.code.code);
      decision = relu ? decisionActivation(relu.code, relu.lot, telephone, true, maintenant) : { motif: 'INVALID' };
      if ('motif' in decision) return refus(decision.motif);
      if (!decision.deja) return refus('ALREADY_CLAIMED');
    }
  }

  const resto = await lireRestaurant(admin, 'restaurant_id', lu.code.restaurant_id);
  return {
    corps: {
      ok: true,
      deja: decision.deja,
      restaurant: resto,
      pourcentage: lu.lot.pourcentage,
      valide_du: lu.lot.valide_du,
      valide_au: lu.lot.valide_au,
    },
  };
}

/**
 * Vérifier (lecture seule) ou réserver (DISPONIBLE → RESERVE, 2 h) un code,
 * donné tel quel ou retrouvé par le numéro du client (R12).
 * Par numéro, le site ne reçoit que le code masqué.
 */
async function verifier(
  admin: SupabaseClient,
  corps: Record<string, unknown>,
  maintenant: Date,
  reserver: boolean,
): Promise<ResultatSite> {
  const slug = typeof corps.slug_site === 'string' ? corps.slug_site : '';
  const resto = slug ? await lireRestaurant(admin, 'slug_site', slug) : null;
  if (!resto) return { corps: { ok: false, erreur: 'Restaurant inconnu du site' } };

  const { lignes, erreur } = lireLignes(corps.lignes);
  if (erreur) return { corps: { ok: false, erreur } };

  const refSite = typeof corps.ref_site === 'string' ? corps.ref_site.trim() : '';
  if (reserver && (!refSite || refSite.length > 100)) return { corps: { ok: false, erreur: 'Référence de commande manquante' } };

  // Candidats : le code tapé, ou les codes gardés sur ce numéro dans ce restaurant.
  let candidats: { code: CodeLigne; lot: LotLigne }[];
  let parNumero = false;
  if (corps.code !== undefined && corps.code !== null && corps.code !== '') {
    const code = normaliserCode(corps.code);
    const lu = code ? await lireCode(admin, code) : null;
    if (!lu) return refus('INVALID', true);
    const motif = refusUtilisation(lu.code, lu.lot, resto.restaurant_id, maintenant);
    if (motif) return refus(motif);
    candidats = [lu];
  } else {
    const telephone = normaliserTelephone(corps.telephone);
    if (!telephone) return refus('INVALID_PHONE');
    parNumero = true;
    candidats = codesUtilisablesParNumero(await codesDuNumero(admin, resto.restaurant_id, telephone), resto.restaurant_id, maintenant);
    if (candidats.length === 0) return refus('NO_ACTIVE_CODE');
  }

  const pourcentage = candidats[0]!.lot.pourcentage;
  const remise = lignes ? remiseEstimee(lignes, pourcentage) : undefined;
  if (remise === null) return refus('NO_ELIGIBLE_ITEM');

  let retenu = candidats[0]!;
  if (reserver) {
    // UPDATE conditionnel : deux réservations simultanées, une seule gagne.
    // Par numéro, on passe au code suivant si le premier vient d'être pris.
    const pris = await reserverPremier(admin, candidats, refSite, maintenant);
    if (!pris) return refus(parNumero ? 'NO_ACTIVE_CODE' : 'ALREADY_USED');
    retenu = pris;
  }

  return {
    corps: {
      ok: true,
      code_masque: masquerCode(retenu.code.code),
      ...(parNumero ? {} : { code: retenu.code.code }),
      pourcentage: retenu.lot.pourcentage,
      valide_au: retenu.lot.valide_au,
      ...(remise !== undefined ? { remise_estimee: remise } : {}),
      ...(reserver ? { reserve_jusqua: new Date(maintenant.getTime() + RESERVATION_SITE_MS).toISOString() } : {}),
    },
  };
}

async function codesDuNumero(admin: SupabaseClient, restaurantId: string, telephone: string) {
  const { data, error } = await admin
    .from('promo_codes')
    .select(COLONNES_CODE)
    .eq('restaurant_id', restaurantId)
    .eq('telephone', telephone)
    .eq('statut', 'DISPONIBLE')
    .limit(50);
  if (error) throw new Error('Lecture des codes impossible');
  const codes = (data ?? []) as CodeLigne[];
  if (codes.length === 0) return [];
  const { data: lots, error: e2 } = await admin
    .from('promo_lots')
    .select(COLONNES_LOT)
    .eq('restaurant_id', restaurantId)
    .in('id', [...new Set(codes.map((c) => c.lot_id))]);
  if (e2) throw new Error('Lecture des lots impossible');
  const parId = new Map(((lots ?? []) as LotLigne[]).map((l) => [l.id, l]));
  return codes.filter((c) => parId.has(c.lot_id)).map((c) => ({ code: c, lot: parId.get(c.lot_id)! }));
}

async function reserverPremier<T extends { code: CodeLigne }>(
  admin: SupabaseClient,
  candidats: T[],
  refSite: string,
  maintenant: Date,
): Promise<T | null> {
  for (const candidat of candidats) {
    const { data, error } = await admin
      .from('promo_codes')
      .update({ statut: 'RESERVE', reserve_le: maintenant.toISOString(), reserve_source: 'SITE', reserve_ref: refSite })
      .eq('restaurant_id', candidat.code.restaurant_id)
      .eq('id', candidat.code.id)
      .eq('statut', 'DISPONIBLE')
      .select('id');
    if (error) throw new Error('Réservation impossible');
    if (data && data.length > 0) return candidat;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Porte de la console du siège
// ---------------------------------------------------------------------------

/** Trace une action du siège. Best-effort, comme dans la fonction `siege`. */
async function tracer(
  admin: SupabaseClient,
  siege: Siege,
  action: string,
  entite: string,
  entiteId: string,
  portee: string,
  meta: unknown,
) {
  try {
    await admin.from('siege_audit').insert({
      user_id: siege.userId,
      nom_complet: siege.nomComplet,
      action,
      entite,
      entite_id: entiteId,
      portee: [portee],
      meta,
    });
  } catch {
    // Le journal ne doit jamais bloquer le travail.
  }
}

/** Restaurant facultatif du filtre de la console : absent = tout le groupe. */
function filtreRestaurant(corps: Record<string, unknown>): string | null | undefined {
  const r = corps.restaurant_id;
  if (r === undefined || r === null || r === '') return null;
  return uuidValide(r) ? r : undefined;
}

/** PostgREST plafonne une lecture à 1 000 lignes : un lot peut en compter 2 000. */
async function toutesLesLignes<T>(lire: (de: number, a: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const PAGE = 1000;
  const lignes: T[] = [];
  for (let de = 0; ; de += PAGE) {
    const { data, error } = await lire(de, de + PAGE - 1);
    if (error) throw new Error('Lecture impossible');
    const page = (data ?? []) as T[];
    lignes.push(...page);
    if (page.length < PAGE) return lignes;
  }
}

async function porteConsole(
  admin: SupabaseClient,
  req: Request,
  action: string,
  corps: Record<string, unknown>,
): Promise<Response> {
  let siege: Siege;
  try {
    siege = await verifierSiege(admin, req);
  } catch (e) {
    if (e instanceof ErreurAuth) return jsonCors({ erreur: e.message }, 401);
    return jsonCors({ erreur: 'Requête invalide' }, 400);
  }

  try {
    switch (action) {
      // -- Lots et compteurs. Visible au niveau LECTURE : aucun code ni numéro.
      case 'lots': {
        const restaurantId = filtreRestaurant(corps);
        if (restaurantId === undefined) return jsonCors({ erreur: 'Restaurant invalide' }, 400);
        const { data, error } = await admin.rpc('promo_lots_stats', { p_restaurant_id: restaurantId });
        if (error) throw new Error('Lecture des lots impossible');
        return jsonCors({ lots: data ?? [] });
      }

      case 'lot_creer': {
        exigeAdmin(siege);
        const { valeur, erreur } = lireLot(corps, new Date());
        if (!valeur) return jsonCors({ erreur }, 400);
        const { data, error } = await admin.rpc('promo_lot_creer', {
          p_restaurant_id: valeur.restaurant_id,
          p_libelle: valeur.libelle,
          p_pourcentage: valeur.pourcentage,
          p_valide_du: valeur.valide_du,
          p_valide_au: valeur.valide_au,
          p_quantite: valeur.quantite,
          p_cree_par: siege.nomComplet,
        });
        // Les refus de la fonction SQL (préfixe manquant, restaurant inactif) sont écrits pour l'écran.
        if (error) return jsonCors({ erreur: error.message }, 400);
        const id = data as string;
        await tracer(admin, siege, 'PROMO_LOT_CREE', 'promo_lots', id, valeur.restaurant_id, valeur);
        return jsonCors({ lot_id: id });
      }

      case 'lot_annuler': {
        exigeAdmin(siege);
        if (!uuidValide(corps.restaurant_id) || !uuidValide(corps.lot_id)) {
          return jsonCors({ erreur: 'Lot non précisé' }, 400);
        }
        const { data, error } = await admin.rpc('promo_lot_annuler', {
          p_restaurant_id: corps.restaurant_id,
          p_lot_id: corps.lot_id,
        });
        if (error) return jsonCors({ erreur: error.message }, 400);
        await tracer(admin, siege, 'PROMO_LOT_ANNULE', 'promo_lots', corps.lot_id, corps.restaurant_id, { codes_annules: data });
        return jsonCors({ codes_annules: data });
      }

      // -- Les codes en clair d'un lot, pour l'impression et le CSV de contrôle.
      // -- Réservé aux ADMIN : un code est un bon de réduction.
      case 'lot_codes': {
        exigeAdmin(siege);
        if (!uuidValide(corps.restaurant_id) || !uuidValide(corps.lot_id)) {
          return jsonCors({ erreur: 'Lot non précisé' }, 400);
        }
        const restaurantId = corps.restaurant_id;
        const lotId = corps.lot_id;
        const [{ data: lot, error }, resto] = await Promise.all([
          admin
            .from('promo_lots')
            .select('restaurant_id, id, libelle, pourcentage, valide_du, valide_au, quantite, annule_le, cree_le')
            .eq('restaurant_id', restaurantId)
            .eq('id', lotId)
            .maybeSingle(),
          admin
            .from('restaurants')
            .select('restaurant_id, nom, marque, couleur_hex, telephone, adresse, prefixe_promo, slug_site')
            .eq('restaurant_id', restaurantId)
            .maybeSingle(),
        ]);
        if (error || resto.error) throw new Error('Lecture du lot impossible');
        if (!lot) return jsonCors({ erreur: 'Lot introuvable' }, 404);
        const codes = await toutesLesLignes<Record<string, unknown>>((de, a) =>
          admin
            .from('promo_codes')
            .select('code, statut, active_le, utilise_le, utilise_canal')
            .eq('restaurant_id', restaurantId)
            .eq('lot_id', lotId)
            .order('code')
            .range(de, a),
        );
        return jsonCors({ lot, restaurant: resto.data, codes });
      }

      // -- Numéros à relancer (relance manuelle, WhatsApp). Des numéros de
      // -- téléphone : réservé aux ADMIN.
      case 'relances': {
        exigeAdmin(siege);
        const restaurantId = filtreRestaurant(corps);
        if (restaurantId === undefined) return jsonCors({ erreur: 'Restaurant invalide' }, 400);
        const jours = corps.jours ?? 3;
        if (jours !== null && (!Number.isInteger(jours) || (jours as number) < 1 || (jours as number) > 60)) {
          return jsonCors({ erreur: 'Nombre de jours invalide' }, 400);
        }
        const jusqua = jours === null ? null : new Date(Date.now() + (jours as number) * 24 * 3600 * 1000).toISOString();
        const lignes = await toutesLesLignes<Record<string, unknown> & { code: string; restaurant_id: string; lot_id: string }>((de, a) =>
          admin.rpc('promo_relances', { p_restaurant_id: restaurantId, p_jusqua: jusqua }).range(de, a),
        );
        // Le pourcentage du lot, pour que le message de relance dise « ton −20 % »
        // sans le supposer. Lu à part : promo_relances ne le rend pas.
        const lotIds = [...new Set(lignes.map((l) => l.lot_id))];
        const pourcentages = new Map<string, number>();
        if (lotIds.length > 0) {
          const { data: lots, error } = await admin.from('promo_lots').select('id, pourcentage').in('id', lotIds);
          if (error) throw new Error('Lecture des lots impossible');
          for (const l of lots ?? []) pourcentages.set(l.id as string, l.pourcentage as number);
        }
        return jsonCors({
          relances: lignes.map(({ code, ...reste }) => ({
            ...reste,
            pourcentage: pourcentages.get(reste.lot_id) ?? null,
            code_masque: masquerCode(code),
          })),
        });
      }

      // -- Fiches promo des restaurants : ce qui s'imprime sur l'autocollant.
      // -- `a_des_lots` : le préfixe est alors figé, il est sur des codes imprimés.
      case 'restaurants_promo': {
        const [{ data, error }, { data: lots, error: e2 }] = await Promise.all([
          admin
            .from('restaurants')
            .select('restaurant_id, code, nom, marque, telephone, adresse, prefixe_promo, slug_site')
            .eq('actif', true)
            .order('nom'),
          admin.from('promo_lots').select('restaurant_id'),
        ]);
        if (error || e2) throw new Error('Lecture des restaurants impossible');
        const avecLots = new Set((lots ?? []).map((l) => l.restaurant_id as string));
        return jsonCors({
          restaurants: (data ?? []).map((r) => ({ ...r, a_des_lots: avecLots.has(r.restaurant_id as string) })),
        });
      }

      case 'restaurant_promo_modifier': {
        exigeAdmin(siege);
        if (!uuidValide(corps.restaurant_id)) return jsonCors({ erreur: 'Restaurant non précisé' }, 400);
        const restaurantId = corps.restaurant_id;
        const { valeur, erreur } = lireFicheRestaurant(corps);
        if (!valeur) return jsonCors({ erreur }, 400);

        const { data: actuel, error } = await admin
          .from('restaurants')
          .select('prefixe_promo')
          .eq('restaurant_id', restaurantId)
          .maybeSingle();
        if (error) throw new Error('Lecture du restaurant impossible');
        if (!actuel) return jsonCors({ erreur: 'Restaurant introuvable' }, 404);
        if (actuel.prefixe_promo !== valeur.prefixe_promo) {
          const { count, error: e2 } = await admin
            .from('promo_lots')
            .select('id', { count: 'exact', head: true })
            .eq('restaurant_id', restaurantId);
          if (e2) throw new Error('Lecture des lots impossible');
          if ((count ?? 0) > 0) {
            return jsonCors({ erreur: 'Ce restaurant a déjà des lots : son préfixe est imprimé sur des autocollants, il ne change plus.' }, 409);
          }
        }

        const { error: e3 } = await admin.from('restaurants').update(valeur).eq('restaurant_id', restaurantId);
        if (e3) {
          // 23505 : index unique sur le préfixe ou l'identifiant du site.
          if (e3.code === '23505') return jsonCors({ erreur: 'Ce préfixe ou cet identifiant de site est déjà pris par un autre restaurant.' }, 409);
          if (e3.code === '23514') return jsonCors({ erreur: 'Valeur refusée par la base : vérifiez le préfixe et le téléphone.' }, 400);
          throw new Error('Enregistrement impossible');
        }
        await tracer(admin, siege, 'PROMO_FICHE_RESTAURANT', 'restaurants', restaurantId, restaurantId, valeur);
        return jsonCors({ ok: true });
      }

      // -- Catégories exclues des codes carte (Chawarma). Une ligne avec
      // -- `exclue: false` lève l'exclusion et descend quand même aux caisses.
      case 'exclusions': {
        const restaurantId = filtreRestaurant(corps);
        if (restaurantId === undefined) return jsonCors({ erreur: 'Restaurant invalide' }, 400);
        let requete = admin.from('promo_categories_exclues').select('restaurant_id, id, exclue');
        if (restaurantId) requete = requete.eq('restaurant_id', restaurantId);
        const { data, error } = await requete;
        if (error) throw new Error('Lecture des exclusions impossible');
        return jsonCors({ exclusions: data ?? [] });
      }

      case 'categorie_exclure': {
        exigeAdmin(siege);
        if (!uuidValide(corps.restaurant_id) || !uuidValide(corps.categorie_id) || typeof corps.exclue !== 'boolean') {
          return jsonCors({ erreur: 'Catégorie non précisée' }, 400);
        }
        const { error } = await admin.from('promo_categories_exclues').upsert(
          {
            restaurant_id: corps.restaurant_id,
            id: corps.categorie_id,
            exclue: corps.exclue,
            modifie_par: siege.nomComplet,
            modifie_le: new Date().toISOString(),
          },
          { onConflict: 'restaurant_id,id' },
        );
        if (error) {
          if (error.code === '23503') return jsonCors({ erreur: 'Cette catégorie n’existe pas dans ce restaurant.' }, 404);
          throw new Error('Enregistrement impossible');
        }
        await tracer(admin, siege, corps.exclue ? 'PROMO_CATEGORIE_EXCLUE' : 'PROMO_CATEGORIE_REMISEE', 'promo_categories_exclues', corps.categorie_id, corps.restaurant_id, {});
        return jsonCors({ ok: true });
      }

      default:
        return jsonCors({ erreur: `Action inconnue : ${action}` }, 400);
    }
  } catch (e) {
    if (e instanceof ErreurAuth) return jsonCors({ erreur: e.message }, 403);
    return jsonCors({ erreur: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
}
