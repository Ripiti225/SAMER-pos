// ──────────────────────────────────────────────────────────────────────────────
// Edge Function `samtrackly-points` — le pont cloud POS → SamerTrackly.
//
// Appelée toutes les 5 minutes par pg_cron (migration 20260817140000). Elle
// prend les services de caisse clôturés qui n'ont pas encore été transférés,
// construit le point de shift attendu par SamerTrackly, et l'y écrit avec ses
// dépenses et ses présences.
//
// TOUTE LA LOGIQUE DE CALCUL EST AILLEURS, dans `_shared/samtrackly-shift.ts` et
// `_shared/samtrackly-detail.ts`, testées avec `npm run test:functions`. Ce
// fichier ne fait que de la plomberie : lire, appeler, écrire, marquer.
//
// TROIS RÈGLES QUI GOUVERNENT CE CODE
//
//  1. Un service qui échoue n'arrête pas les autres. Un site mal configuré ne
//     doit jamais geler les six autres — c'est la leçon de `sync-push`, où une
//     table inconnue gelait un restaurant pour toujours.
//
//  2. Rien n'est marqué transféré sans que TOUT soit écrit. Un demi-transfert
//     marqué réussi, c'est une vente qui n'arrivera jamais.
//
//  3. Écrire deux fois ne double rien. Le shift retombe sur `pos_service_id`,
//     les dépenses sur leur `id` du POS, les présences sur le trio
//     (point_id, caissier_id, travailleur_id). Rejouer est donc sans danger,
//     et c'est ce qui permet de réessayer sans réfléchir.
// ──────────────────────────────────────────────────────────────────────────────
import { clientAdmin, json } from '../_shared/auth.ts';
import {
  construireShift,
  journeeExploitation,
  journeePourTransfert,
  aDejaEtePlace,
  doitTransferer,
  totalVentePoint,
  totalVenteMachinePoint,
  type ServiceCloud,
} from '../_shared/samtrackly-shift.ts';
import {
  construireDepenses,
  construirePresences,
  type DepenseDetail,
  type EquipeService,
  type FicheRH,
} from '../_shared/samtrackly-detail.ts';
import { ErreurSamtrackly, lire, inserer, upsert, patch, supprimer, samtracklyConfigure } from '../_shared/samtrackly-api.ts';
import {
  servicesARattraper,
  construireJournalRattrapage,
  doitAlerterEchec,
  construireAlerteEchec,
  type TransfertPresencesIgnorees,
} from '../_shared/samtrackly-rattrapage.ts';
import {
  construireInventaireShift,
  construireLignesInventaire,
  construireEntreesShift,
  correspondanceRompue,
  type InventaireServiceCloud,
} from '../_shared/samtrackly-inventaire.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Services traités par passage. Le cron repasse dans 5 minutes pour la suite. */
const LOT_MAX = 25;

interface Bilan {
  transferes: number;
  echecs: number;
  ignores: number;
  details: { service: string; resultat: string }[];
}

// ---------------------------------------------------------------------------
// Résolution de l'identité : POS → SamerTrackly
// ---------------------------------------------------------------------------

/**
 * Le caissier POS, retrouvé dans `utilisateurs` de SamerTrackly.
 *
 * Chaîne complète : `services_caisse.caissier_id` (un utilisateur POS) →
 * `utilisateurs_site.externe_id` (l'id RH) → `utilisateurs.travailleur_id`
 * (le pont ajouté par supabase_pos_bascule.sql).
 *
 * Si le pont n'est pas posé pour cette personne, on garde son NOM et on laisse
 * `caissier_id` vide : le shift arrive quand même. Perdre l'attribution vaut
 * mieux que perdre la recette — mais les écrans qui filtrent par caissier
 * seront aveugles à ce shift, d'où le remplissage de `travailleur_id`.
 */
async function resoudreCaissier(
  admin: SupabaseClient,
  posUserId: string | null,
): Promise<{ id: string | null; nom: string | null; externeId: string | null }> {
  if (!posUserId) return { id: null, nom: null, externeId: null };

  const { data: site } = await admin
    .from('utilisateurs_site')
    .select('nom_complet, externe_id')
    .eq('id', posUserId)
    .maybeSingle();

  const nom = site?.nom_complet ?? null;
  const externeId = site?.externe_id ?? null;
  if (!externeId) return { id: null, nom, externeId: null };

  const trouves = await lire<{ id: string; nom: string }>(
    `utilisateurs?travailleur_id=eq.${externeId}&select=id,nom&limit=1`,
  );
  return { id: trouves[0]?.id ?? null, nom: trouves[0]?.nom ?? nom, externeId };
}

/** Les fiches RH de l'équipe du service, indexées par id d'utilisateur POS. */
async function resoudreEquipeRH(
  admin: SupabaseClient,
  posUserIds: string[],
): Promise<Map<string, FicheRH>> {
  const fiches = new Map<string, FicheRH>();
  if (posUserIds.length === 0) return fiches;

  const { data: sites } = await admin
    .from('utilisateurs_site')
    .select('id, nom_complet, externe_id')
    .in('id', posUserIds);

  for (const s of sites ?? []) {
    // Sans `externe_id`, l'employé a été créé sur place et n'existe pas encore
    // côté RH : sa présence ferait échouer la clé étrangère et bloquerait le
    // shift entier. On l'écarte (voir samtrackly-detail.ts).
    if (!s.externe_id) continue;
    fiches.set(s.id, { travailleurId: s.externe_id, nom: s.nom_complet ?? '' });
  }
  return fiches;
}

// ---------------------------------------------------------------------------
// L'inventaire du service, côté POS
// ---------------------------------------------------------------------------

interface InventaireDuService {
  inventaire: InventaireServiceCloud;
  lignes: {
    produit_id: string;
    produit_code: string | null;
    produit_nom: string | null;
    produit_prix: string | number | null;
    stock_initial: string | number | null;
    entrees: string | number | null;
    sorties: string | number | null;
    stock_compte: string | number | null;
    ecart: string | number | null;
    quantite_expliquee: string | number | null;
    explication: string | null;
  }[];
  entrees: {
    produit_id: string;
    produit_code: string | null;
    produit_nom: string | null;
    quantite: string | number;
    fournisseur: string | null;
  }[];
}

/**
 * Null si ce service n'a jamais eu d'inventaire (cas théorique seulement — la
 * clôture POS le garantit) : le shift part quand même, l'inventaire est un
 * bonus, pas une condition d'envoi de la vente.
 */
async function lireInventaireDuService(
  admin: SupabaseClient,
  serviceId: string,
): Promise<InventaireDuService | null> {
  const { data: inventaire } = await admin
    .from('inventaires_service')
    .select('id, valide, debloque_par, montant_manquant')
    .eq('service_id', serviceId)
    .maybeSingle();
  if (!inventaire) return null;

  const [{ data: lignes }, { data: entrees }] = await Promise.all([
    admin
      .from('inventaire_lignes')
      .select('produit_id, produit_code, produit_nom, produit_prix, stock_initial, entrees, sorties, stock_compte, ecart, quantite_expliquee, explication')
      .eq('inventaire_id', inventaire.id),
    admin
      .from('entrees_stock')
      .select('produit_id, produit_code, produit_nom, quantite, fournisseur')
      .eq('inventaire_id', inventaire.id),
  ]);

  return {
    inventaire: inventaire as InventaireServiceCloud,
    lignes: lignes ?? [],
    entrees: entrees ?? [],
  };
}

// ---------------------------------------------------------------------------
// Le point (journée) côté SamerTrackly
// ---------------------------------------------------------------------------

/**
 * Retrouve — ou crée — le point de la journée, en sautant les jours déjà
 * validés par le gérant.
 */
async function resoudrePoint(
  restaurantStId: string,
  journeeSouhaitee: string,
  dejaTransfere: boolean,
): Promise<{ pointId: string; journee: string }> {
  // Les points du restaurant autour de la journée visée, pour savoir lesquels
  // sont validés sans faire un aller-retour par jour.
  const points = await lire<{ id: string; date: string; valide: boolean }>(
    `points?restaurant_id=eq.${restaurantStId}&date=gte.${journeeSouhaitee}` +
      `&select=id,date,valide&order=date&limit=40`,
  );

  const valideParJour = new Map<string, boolean>();
  const idParJour = new Map<string, string>();
  for (const p of points) {
    valideParJour.set(p.date, p.valide === true);
    idParJour.set(p.date, p.id);
  }

  const journee = journeePourTransfert(journeeSouhaitee, valideParJour, dejaTransfere);
  const existant = idParJour.get(journee);
  if (existant) return { pointId: existant, journee };

  // Aucun point ce jour-là : on le crée. Il doit exister avant toute
  // sous-écriture — dépenses et présences le référencent.
  const crees = await inserer<{ id: string }>('points', [
    { restaurant_id: restaurantStId, date: journee, valide: false },
  ]);
  const pointId = crees[0]?.id;
  if (!pointId) throw new ErreurSamtrackly(`Création du point du ${journee} sans identifiant en retour`);
  return { pointId, journee };
}

// ---------------------------------------------------------------------------
// Transfert d'un service
// ---------------------------------------------------------------------------

async function transfererService(
  admin: SupabaseClient,
  service: ServiceCloud & { restaurant_id: string; caissier_id: string | null },
  restaurantStId: string,
  dejaTransfere: boolean,
): Promise<{
  pointId: string;
  journee: string;
  vente: number;
  nbDep: number;
  nbPres: number;
  nbInv: number;
  ignores: string[];
}> {
  const journeeSouhaitee = journeeExploitation(service);
  if (!journeeSouhaitee) throw new ErreurSamtrackly('Service sans date d’ouverture exploitable');

  const [caissier, depensesRes, equipeRes] = await Promise.all([
    resoudreCaissier(admin, service.caissier_id),
    admin
      .from('depenses')
      .select('id, categorie, libelle, montant, agent_id, supprime')
      .eq('service_id', service.id),
    admin
      .from('equipe_service')
      .select('utilisateur_id, poste_jour, pointe_le, reste')
      .eq('service_id', service.id),
  ]);

  const depenses = (depensesRes.data ?? []) as DepenseDetail[];
  const equipe = (equipeRes.data ?? []) as EquipeService[];

  const { pointId, journee } = await resoudrePoint(restaurantStId, journeeSouhaitee, dejaTransfere);

  const ligneShift = construireShift(service, depenses, {
    restaurantId: restaurantStId,
    pointId,
    caissierId: caissier.id,
    caissierNom: caissier.nom,
  });
  // La journée retenue peut différer de celle du shift si le point était validé.
  ligneShift.date = journee;

  const ctxDetail = {
    pointId,
    restaurantId: restaurantStId,
    caissierId: caissier.id,
    caissierNom: caissier.nom,
    date: journee,
    heureDebut: ligneShift.heure_debut,
    heureFin: ligneShift.heure_fin,
  };

  const fichesRH = await resoudreEquipeRH(
    admin,
    equipe.map((e) => e.utilisateur_id).filter((x): x is string => !!x),
  );
  const lignesDepenses = construireDepenses(depenses, ctxDetail);
  const lignesPresences = construirePresences(equipe, depenses, fichesRH, ctxDetail);

  // Le shift d'abord : c'est lui qui porte la recette. Si les écritures de
  // détail échouent derrière, l'exception empêche de marquer le transfert et
  // le prochain passage rejouera tout — sans rien doubler.
  await upsert('points_shifts', [ligneShift as unknown as Record<string, unknown>], 'pos_service_id');
  await upsert('depenses', lignesDepenses as unknown as Record<string, unknown>[], 'id');
  await upsert(
    'presences',
    lignesPresences as unknown as Record<string, unknown>[],
    'point_id,caissier_id,travailleur_id',
  );

  // Qui n'a pas pu être inscrit en présence, faute de fiche RH. On le NOTE :
  // sans ça, la journée de travail et la paie de cette personne disparaissent
  // en silence, puisque le service est marqué transféré et jamais rejoué.
  const ignores = equipe
    .map((e) => e.utilisateur_id)
    .filter((id): id is string => !!id && !fichesRH.has(id));

  // ── Inventaire ────────────────────────────────────────────────────────────
  // Bonus du shift, pas une condition : si rien n'a jamais été compté pour ce
  // service (cas théorique), on continue sans rien écrire côté inventaire.
  let nbLignesInventaire = 0;
  const inventaireDuService = await lireInventaireDuService(admin, service.id);
  if (inventaireDuService) {
    // Garde-fou (2026-08-21) : refuser d'écrire AVANT de toucher quoi que ce
    // soit. Si aucune des lignes comptées ne se traduit, le catalogue cloud est
    // vide ou porte d'autres uuid que le site — écrire l'en-tête quand même
    // produirait un inventaire « validé, 0 à déduire » sans une seule ligne,
    // qui lève la bannière « Inventaire du jour requis » en affirmant qu'il n'y
    // a rien à retenir. Mieux vaut un service en échec, visible et rejouable.
    const nbTraduisibles = inventaireDuService.lignes.filter((l) => l.produit_code).length;
    if (correspondanceRompue(inventaireDuService.lignes.length, nbTraduisibles)) {
      throw new ErreurSamtrackly(
        `Inventaire illisible : ${inventaireDuService.lignes.length} produits comptés, aucun ne `
        + `porte de snapshot produit. Ce site n'a pas encore la migration locale 0026. `
        + `Rien n'a été écrit.`,
      );
    }

    const ligneInventaireShift = construireInventaireShift(inventaireDuService.inventaire, {
      pointId,
      restaurantId: restaurantStId,
      caissierId: caissier.id,
      date: journee,
      heureDebut: ligneShift.heure_debut,
      heureFin: ligneShift.heure_fin,
      posServiceId: service.id,
    });

    // L'inventaire est de l'argent, comme le shift : un échec ici doit faire
    // échouer tout le transfert du service (voir le catch de l'appelant), pas
    // être avalé en silence.
    const [inventaireShiftSt] = await upsert(
      'inventaires_shifts',
      [ligneInventaireShift as unknown as Record<string, unknown>],
      'pos_service_id',
    );
    const invShiftId = (inventaireShiftSt as { id: string }).id;

    const serviceValideNormalement = inventaireDuService.inventaire.valide === true
      && !inventaireDuService.inventaire.debloque_par;
    const lignesDetail = construireLignesInventaire(
      inventaireDuService.lignes,
      invShiftId,
      serviceValideNormalement,
    );
    await supprimer(`inventaire_lignes?inventaire_id=eq.${invShiftId}`);
    await inserer('inventaire_lignes', lignesDetail as unknown as Record<string, unknown>[]);
    nbLignesInventaire = lignesDetail.length;

    // Les réceptions détaillées sont de la traçabilité, jamais un calcul
    // d'argent (voir samtrackly-inventaire.ts) : une panne ici ne doit jamais
    // annuler ce qui vient d'être écrit au-dessus — même principe que le
    // rattrapage journal plus bas dans ce fichier.
    try {
      const lignesEntrees = construireEntreesShift(inventaireDuService.entrees, invShiftId);
      await supprimer(`entrees_shift?inventaire_id=eq.${invShiftId}`);
      await inserer('entrees_shift', lignesEntrees as unknown as Record<string, unknown>[]);
    } catch {
      // Volontairement avalé : voir le commentaire ci-dessus. Ce sous-échec ne
      // doit pas remonter comme un échec du service.
    }
  }

  return {
    pointId,
    journee,
    vente: ligneShift.vente_shift,
    nbDep: lignesDepenses.length,
    nbPres: lignesPresences.length,
    nbInv: nbLignesInventaire,
    ignores,
  };
}

// ---------------------------------------------------------------------------
// Entrée
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  if (!samtracklyConfigure()) {
    return json({ erreur: 'SamerTrackly non configuré (secrets de la fonction)' }, 503);
  }

  const admin = clientAdmin();
  const bilan: Bilan = { transferes: 0, echecs: 0, ignores: 0, details: [] };

  // ── Rattrapage automatique des présences en attente d'une fiche RH ────────
  // Un service déjà transféré peut avoir des présences manquantes parce qu'un
  // employé créé sur la caisse n'avait pas encore de fiche RH. Dès que le
  // siège la crée, son `externe_id` se remplit côté POS (synchro équipe déjà
  // en place) — on le détecte ici et on rouvre le service pour qu'il soit
  // retraité par la boucle normale ci-dessous, sans qu'un humain lance
  // `rejouer_transferts()` à la main. Voir samtrackly-rattrapage.ts.
  //
  // Ceci reste dans son propre try/catch : un souci ici ne doit jamais
  // empêcher les VRAIS nouveaux shifts d'être transférés — c'est un bonus,
  // pas le cœur du pont.
  // Services DÉJÀ POSÉS sur une journée SamerTrackly.
  //
  // ⚠ On lit `journee`/`point_id`, PAS `transfere_le` — voir aDejaEtePlace.
  // `rejouer_transferts()` vide `transfere_le` avant que la fonction ne
  // tourne : s'en servir ici ferait passer chaque rejeu pour un premier
  // transfert, et relocaliserait les shifts (incident du 2026-08-20, commis
  // deux fois).
  const dejaAbouti = new Set<string>();
  try {
    const { data } = await admin
      .from('samtrackly_transferts')
      .select('service_id, journee, point_id');
    for (const t of data ?? []) {
      if (aDejaEtePlace(t)) dejaAbouti.add(t.service_id as string);
    }
  } catch { /* au pire on traite comme neuf : le comportement d'avant */ }

  const idsRattrapes = new Set<string>();
  const ignoresAvant = new Map<string, number>();
  // Rattrapages ET alertes d'échec : deux traces différentes, une seule
  // écriture groupée au journal en fin de passage.
  const journalRattrapages: (
    | ReturnType<typeof construireJournalRattrapage>
    | ReturnType<typeof construireAlerteEchec>
  )[] = [];
  try {
    const { data: enAttentePresences } = await admin
      .from('samtrackly_transferts')
      .select('service_id, restaurant_id, point_id, journee, presences_ignorees')
      .not('transfere_le', 'is', null)
      .not('presences_ignorees', 'is', null);

    const candidats: TransfertPresencesIgnorees[] = (enAttentePresences ?? [])
      .filter((t) => Array.isArray(t.presences_ignorees) && t.presences_ignorees.length > 0)
      .map((t) => ({
        service_id: t.service_id as string,
        restaurant_id: t.restaurant_id as string,
        point_id: t.point_id as string | null,
        journee: t.journee as string | null,
        presences_ignorees: t.presences_ignorees as string[],
      }));

    if (candidats.length > 0) {
      const idsIgnores = [...new Set(candidats.flatMap((c) => c.presences_ignorees || []))];
      const fichesFraiches = await resoudreEquipeRH(admin, idsIgnores);
      const maintenantResolues = new Set(fichesFraiches.keys());

      for (const c of servicesARattraper(candidats, maintenantResolues)) {
        idsRattrapes.add(c.service_id);
        ignoresAvant.set(c.service_id, (c.presences_ignorees || []).length);
      }

      if (idsRattrapes.size > 0) {
        // Réouvre les services : transfere_le repasse à NULL, ils tombent
        // naturellement dans `aTraiter` ci-dessous — aucune écriture n'a
        // besoin d'être doublée, tout ce que le pont écrit est idempotent.
        await admin.rpc('rejouer_transferts', { p_service_ids: [...idsRattrapes] });
      }
    }
  } catch (e) {
    bilan.details.push({
      service: 'rattrapage-presences',
      resultat: `rattrapage automatique non tenté — ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Les services clôturés dont aucun transfert n'a abouti. On relit la table de
  // suivi plutôt que de se fier à une colonne de `services_caisse`, qui est
  // réécrite par UPSERT à chaque montée du site. Les services rattrapés
  // ci-dessus ont transfere_le remis à NULL : ils apparaissent donc ici
  // naturellement, sans traitement à part.
  const { data: dejaFaits } = await admin
    .from('samtrackly_transferts')
    .select('service_id')
    .not('transfere_le', 'is', null);
  const faits = new Set((dejaFaits ?? []).map((t) => t.service_id as string));

  const { data: services, error } = await admin
    .from('services_caisse')
    .select('id, restaurant_id, caissier_id, ouvert_le, cloture_le, fond_de_caisse, especes_comptees, especes_theorique, ecart, explication_ecart, remis_le, rapport_z')
    .eq('statut', 'CLOTURE')
    .not('remis_le', 'is', null)
    .order('cloture_le', { ascending: true })
    .limit(LOT_MAX * 4);

  if (error) return json({ erreur: `Lecture des services impossible : ${error.message}` }, 500);

  // Reprise par site : depuis quand ce site transfère, et vers quel restaurant
  // SamerTrackly. Un site absent de cette table ne transfère RIEN — c'est ce qui
  // empêche de déverser des semaines d'historique sur des journées déjà saisies
  // à la main. Voir `doitTransferer` et la migration 20260817140000.
  const { data: configs } = await admin
    .from('samtrackly_pont_config')
    .select('restaurant_id, samtrackly_id, transferer_depuis, actif');
  const configParResto = new Map((configs ?? []).map((c) => [c.restaurant_id as string, c]));

  const aTraiter = (services ?? [])
    .filter((s) => !faits.has(s.id))
    .filter((s) => doitTransferer(s, configParResto.get(s.restaurant_id)))
    .slice(0, LOT_MAX);

  // Points dont un shift vient d'être écrit : leur `vente_total` doit être
  // recalculé une fois tous les shifts du passage traités, jamais avant —
  // deux shifts du même point dans un même passage ne doivent pas déclencher
  // deux recalculs successifs sur un total partiel.
  const pointsATotaliser = new Set<string>();

  for (const service of aTraiter) {
    const restaurantStId = configParResto.get(service.restaurant_id)?.samtrackly_id as string | undefined;

    // Site configuré pour transférer mais sans restaurant SamerTrackly en face :
    // configuration incomplète, pas une erreur du pont. On le note sans échec.
    if (!restaurantStId) {
      bilan.ignores++;
      bilan.details.push({ service: service.id, resultat: 'site sans samtrackly_id dans samtrackly_pont_config' });
      continue;
    }

    try {
      // Un service déjà abouti une fois est un REJEU : il retourne sur sa
      // propre journée, jamais relocalisé. Voir journeePourTransfert.
      const r = await transfererService(
        admin, service as never, restaurantStId, dejaAbouti.has(service.id),
      );
      await admin.from('samtrackly_transferts').upsert({
        service_id: service.id,
        restaurant_id: service.restaurant_id,
        transfere_le: new Date().toISOString(),
        point_id: r.pointId,
        journee: r.journee,
        vente_shift: r.vente,
        nb_depenses: r.nbDep,
        nb_presences: r.nbPres,
        // Remis à zéro : `tentatives` compte les échecs CONSÉCUTIFS. Sans ça,
        // une série d'échecs plus tard ne franchirait plus jamais le seuil
        // d'alerte, le compteur étant déjà au-dessus.
        tentatives: 0,
        // Vide plutôt que NULL : la vue de suivi distingue « aucune présence
        // écartée » d'un transfert antérieur à cette colonne.
        presences_ignorees: r.ignores,
        derniere_erreur: null,
        derniere_tentative: new Date().toISOString(),
      });
      bilan.transferes++;
      pointsATotaliser.add(r.pointId);

      // Ce service était en attente d'une fiche RH et vient d'être rejoué :
      // on note ce qui a été récupéré pour laisser une trace au journal.
      // « récupéré » = des personnes qui étaient dans l'ancienne liste
      // d'attente et qui, cette fois, ont bien leur présence écrite.
      if (idsRattrapes.has(service.id)) {
        const avant = ignoresAvant.get(service.id) ?? 0;
        journalRattrapages.push(
          construireJournalRattrapage(
            {
              service_id: service.id,
              restaurant_id: service.restaurant_id,
              point_id: r.pointId,
              journee: r.journee,
              presences_ignorees: [],
            },
            avant - r.ignores.length,
          ),
        );
      }

      bilan.details.push({
        service: service.id,
        resultat:
          `${r.journee} · ${r.vente} F` +
          (r.nbInv > 0 ? ` · inventaire (${r.nbInv} produits)` : '') +
          (r.ignores.length > 0 ? ` · ${r.ignores.length} présence(s) en attente de fiche RH` : ''),
      });
    } catch (e) {
      // Un service qui coince ne doit pas arrêter les autres.
      const message = e instanceof Error ? e.message : String(e);
      const { data: precedent } = await admin
        .from('samtrackly_transferts')
        .select('tentatives')
        .eq('service_id', service.id)
        .maybeSingle();

      const tentatives = (precedent?.tentatives ?? 0) + 1;
      await admin.from('samtrackly_transferts').upsert({
        service_id: service.id,
        restaurant_id: service.restaurant_id,
        transfere_le: null,
        tentatives,
        derniere_erreur: message.slice(0, 500),
        derniere_tentative: new Date().toISOString(),
      });

      // Une panne qui dure doit se voir sans que personne pense à consulter
      // `samtrackly_transferts` — c'est la leçon des 400 tentatives passées
      // inaperçues pendant trois jours (2026-08-21 au 24). Une seule ligne, au
      // franchissement du seuil.
      if (doitAlerterEchec(tentatives)) {
        journalRattrapages.push(
          construireAlerteEchec(service.id, restaurantStId, tentatives, message),
        );
      }

      bilan.echecs++;
      bilan.details.push({ service: service.id, resultat: `ÉCHEC — ${message.slice(0, 120)}` });
    }
  }

  // Recalcule le total affiché aux managers (dashboard, rapports, déductions
  // du vérificateur) pour chaque point touché dans ce passage — même formule
  // que recalculerVenteTotalePoint() côté SamerTrackly. Une erreur ici ne doit
  // pas annuler les transferts déjà écrits : le prochain passage retouchera
  // le même point de toute façon si un shift lui arrive encore.
  for (const pointId of pointsATotaliser) {
    try {
      const shifts = await lire<{ vente_shift: number; vente_systeme_pos: number | null }>(
        `points_shifts?point_id=eq.${pointId}&select=vente_shift,vente_systeme_pos`,
      );
      // Deux caches recalculés ensemble, à partir des lignes réelles :
      //   vente_total   = ce que les caissières ont justifié (théorique)
      //   vente_machine = ce que le système a réellement vendu
      // Leur écart est le contrôle historique du groupe. Le gérant ne tape
      // plus la vente machine : les 19 et 20 août, personne ne l'avait fait et
      // le contrôle avait disparu en silence.
      await patch('points', pointId, {
        vente_total: totalVentePoint(shifts),
        vente_machine: totalVenteMachinePoint(shifts),
      });
    } catch (e) {
      bilan.details.push({
        service: pointId,
        resultat: `vente_total non recalculé — ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Trace au journal Samtrackly : un vérificateur qui voit une ligne de
  // présence changer après coup doit pouvoir voir QUI l'a changée. Une
  // panne ici ne doit jamais annuler les transferts déjà écrits au-dessus.
  if (journalRattrapages.length > 0) {
    try {
      await inserer('journal_activite', journalRattrapages as unknown as Record<string, unknown>[]);
    } catch (e) {
      bilan.details.push({
        service: 'rattrapage-journal',
        resultat: `trace au journal non écrite — ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  return json(bilan);
});
