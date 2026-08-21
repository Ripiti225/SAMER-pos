// ──────────────────────────────────────────────────────────────────────────────
// Conversion de l'inventaire d'un service POS clôturé en lignes Samtrackly.
//
// Deuxième partie du pont qui manipule de l'argent (après samtrackly-shift.ts) :
// une erreur ici ne plante pas — elle déduit un montant faux sur la paie d'un
// caissier. D'où sa séparation, ses tests, et l'absence de tout accès réseau.
//
// Spéc : samtrackly/docs/superpowers/specs/2026-08-20-pos-inventaire-vers-samtrackly-design.md
//
// ⚠ CE MODULE NE CONSULTE AUCUN CATALOGUE, ET C'EST VOULU (2026-08-21).
// `inventaire_lignes.produit_id` est un uuid GÉNÉRÉ SUR LE MINI-PC : chaque
// site sème `produits_inventaire` avec ses propres uuid (CATALOGUE_INVENTAIRE
// ne porte que des `code`). Le cloud ne peut donc traduire ces uuid avec rien.
// Le site fige désormais code/nom/prix sur chaque ligne (migration 0026) et ce
// module ne lit que ce snapshot — `produits_inventaire.code` (POS) reste égal à
// `inventaire_lignes.produit_id` (Samtrackly), mais c'est le site qui l'affirme,
// au moment du comptage, avec le prix qu'il a réellement appliqué.
// ──────────────────────────────────────────────────────────────────────────────

/** Nombre sûr : une donnée absente ou non numérique vaut 0, jamais NaN. */
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Nombre sûr ou null : distingue « pas de valeur » de « zéro » (ecart, stock_reel). */
function nOuNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

// ---------------------------------------------------------------------------
// Le créneau (matin/soir/nuit/double) le plus proche de l'heure réelle
// ---------------------------------------------------------------------------

const MINUTES_PAR_JOUR = 24 * 60;

/** Ordre volontaire : décide qui gagne une égalité exacte de distance. */
const CRENEAUX: { id: string; minutes: number }[] = [
  { id: 'nuit', minutes: 0 },
  { id: 'matin', minutes: 8 * 60 },
  { id: 'double', minutes: 12 * 60 },
  { id: 'soir', minutes: 16 * 60 },
];

function minutesDe(heure: string | null): number | null {
  if (!heure) return null;
  const m = /^(\d{2}):(\d{2})/.exec(heure);
  if (!m) return null;
  const h = Number(m[1]);
  const mn = Number(m[2]);
  if (h > 23 || mn > 59) return null;
  return h * 60 + mn;
}

/** Distance en minutes sur une horloge de 24h (23h50 est à 10 min de minuit, pas à 23h50). */
function distanceCirculaire(a: number, b: number): number {
  const d = Math.abs(a - b) % MINUTES_PAR_JOUR;
  return Math.min(d, MINUTES_PAR_JOUR - d);
}

/**
 * Le créneau `inventaires_shifts.type_shift` (matin/soir/nuit/double) le plus
 * proche de l'heure d'ouverture réelle du service POS. `points_shifts` n'a pas
 * besoin de cette notion (il garde l'heure réelle) ; `inventaires_shifts` si —
 * c'est une contrainte de Samtrackly, pas du POS.
 *
 * Heure absente ou mal formée → repli sur 'matin', jamais une exception : un
 * mauvais créneau affiché est un détail visuel, une inventaire qui ne part pas
 * du tout est une vente perdue.
 */
export function typeShiftDe(heureDebut: string | null): string {
  const minutes = minutesDe(heureDebut);
  if (minutes === null) return 'matin';

  let meilleur = CRENEAUX[0]!.id;
  let meilleureDistance = Infinity;
  for (const c of CRENEAUX) {
    const d = distanceCirculaire(minutes, c.minutes);
    if (d < meilleureDistance) {
      meilleureDistance = d;
      meilleur = c.id;
    }
  }
  return meilleur;
}

// ---------------------------------------------------------------------------
// L'en-tête : inventaires_shifts
// ---------------------------------------------------------------------------

export interface InventaireServiceCloud {
  id: string;
  valide: boolean;
  debloque_par: string | null;
  montant_manquant: number | null;
}

export interface ContexteInventaire {
  pointId: string;
  restaurantId: string;
  caissierId: string | null;
  date: string | null;
  heureDebut: string | null;
  heureFin: string | null;
  posServiceId: string;
}

export interface LigneInventaireShift {
  point_id: string;
  caissier_id: string | null;
  restaurant_id: string;
  date: string | null;
  type_shift: string;
  heure_debut: string | null;
  heure_fin: string | null;
  valide: boolean;
  montant_a_deduire: number;
  pos_service_id: string;
}

/**
 * Un inventaire est « validé normalement » seulement si `valide` est vrai ET
 * qu'aucun manager ne l'a débloqué. Les deux ne devraient jamais être vrais en
 * même temps (l'API POS le refuse par 409 des deux côtés), mais rien ne
 * l'empêche en base — un double contrôle ici coûte une ligne, pas un incident.
 */
function valideNormalement(inv: InventaireServiceCloud): boolean {
  return inv.valide === true && !inv.debloque_par;
}

/**
 * La ligne d'en-tête `inventaires_shifts`. `valide` est toujours `true` à
 * l'arrivée : la clôture du service POS garantit déjà que l'inventaire est
 * validé OU débloqué (jamais entre les deux) — voir § 1 de la spec.
 */
export function construireInventaireShift(
  inventaire: InventaireServiceCloud,
  ctx: ContexteInventaire,
): LigneInventaireShift {
  return {
    point_id: ctx.pointId,
    caissier_id: ctx.caissierId,
    restaurant_id: ctx.restaurantId,
    date: ctx.date,
    type_shift: typeShiftDe(ctx.heureDebut),
    heure_debut: ctx.heureDebut,
    heure_fin: ctx.heureFin,
    valide: true,
    montant_a_deduire: valideNormalement(inventaire) ? n(inventaire.montant_manquant) : 0,
    pos_service_id: ctx.posServiceId,
  };
}

// ---------------------------------------------------------------------------
// Le détail : inventaire_lignes
// ---------------------------------------------------------------------------

export interface LigneInventairePosCloud {
  produit_id: string;
  /** Snapshot figé par le site (migration 0026). Null = site pas encore migré. */
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
}

export interface LigneInventaireDetail {
  inventaire_id: string;
  produit_id: string;
  stock_initial: number;
  entrees: number;
  sorties: number;
  stock_reel: number | null;
  ecart: number | null;
  nombre_explique: number | null;
  explication: string | null;
  montant_deduit: number;
  explication_statut?: 'en_attente';
}

/**
 * Le manquant non expliqué chiffré d'une ligne — MÊME FORMULE que
 * `manque_chiffre` dans `modules/inventaire/calcul.ts` côté POS (c'est celle
 * qui a produit le `montant_manquant` de l'en-tête, ligne par ligne cette
 * fois) : seul un écart négatif (manquant) coûte, l'expliqué s'en retire
 * avant l'arrondi, jamais sous zéro.
 */
function manqueChiffre(ecart: number | null, quantiteExpliquee: number, prix: number): number {
  if (ecart === null || ecart >= 0) return 0;
  const resteInexplique = Math.max(0, Math.abs(ecart) - quantiteExpliquee);
  return Math.round(resteInexplique * prix);
}

/** Même condition que `app/inventaire.js:631` côté Samtrackly. */
function aUneExplicationUtile(explication: string | null, quantiteExpliquee: number): boolean {
  return !!(explication && explication.trim()) || quantiteExpliquee > 0;
}

/**
 * Les lignes `inventaire_lignes`, une par produit compté côté POS.
 *
 * Un produit disparu du catalogue entre le comptage et le transfert (cas
 * limite, jamais vu) est écarté plutôt que de faire échouer tout le service —
 * une ligne de moins est visible et corrigeable, un service entier qui ne part
 * jamais ne l'est pas.
 */
export function construireLignesInventaire(
  lignes: LigneInventairePosCloud[],
  invShiftId: string,
  serviceValideNormalement: boolean,
): LigneInventaireDetail[] {
  const resultat: LigneInventaireDetail[] = [];

  for (const l of lignes) {
    // Sans snapshot, la ligne vient d'un site antérieur à la migration 0026 :
    // son uuid n'est traduisible nulle part. L'écarter isolément est sans
    // gravité ; les écarter TOUTES est détecté par `correspondanceRompue`.
    if (!l.produit_code) continue;

    const ecart = nOuNull(l.ecart);
    const quantiteExpliquee = n(l.quantite_expliquee);
    const montantDeduit = serviceValideNormalement
      ? manqueChiffre(ecart, quantiteExpliquee, n(l.produit_prix))
      : 0;

    const ligne: LigneInventaireDetail = {
      inventaire_id: invShiftId,
      produit_id: l.produit_code,
      stock_initial: n(l.stock_initial),
      entrees: n(l.entrees),
      sorties: n(l.sorties),
      stock_reel: nOuNull(l.stock_compte),
      ecart,
      nombre_explique: nOuNull(l.quantite_expliquee),
      explication: l.explication ?? null,
      montant_deduit: montantDeduit,
    };

    // Le déblocage manager évite la retenue automatique (ci-dessus), il ne
    // dispense pas de la revue du vérificateur — une explication écrite dans
    // le POS repasse par la même file d'attente qu'une explication manuelle.
    if (aUneExplicationUtile(ligne.explication, quantiteExpliquee) && ecart !== null && Math.abs(ecart) > 0.01) {
      ligne.explication_statut = 'en_attente';
    }

    resultat.push(ligne);
  }

  return resultat;
}

/**
 * La correspondance uuid POS → code produit est-elle rompue ?
 *
 * Vrai quand le POS a compté des lignes mais qu'AUCUNE ne porte de snapshot :
 * le site n'a pas encore la migration 0026, ou sa montée filtre encore les
 * colonnes `produit_*` (listes blanches de `tables.ts`).
 *
 * Constaté en production le 2026-08-21 : 4 services ont écrit un en-tête
 * « validé, 0 à déduire » alors que leurs 34 lignes avaient toutes été
 * écartées une par une. Un inventaire vide d'apparence saine est PIRE qu'un
 * inventaire absent — il lève la bannière « Inventaire du jour requis » et
 * affirme qu'il n'y a rien à retenir. L'appelant doit échouer bruyamment.
 *
 * Écarter QUELQUES lignes reste normal (un produit retiré du catalogue) : seul
 * le tout-ou-rien signale une correspondance rompue.
 */
export function correspondanceRompue(nbLignesPos: number, nbLignesConstruites: number): boolean {
  return nbLignesPos > 0 && nbLignesConstruites === 0;
}

// ---------------------------------------------------------------------------
// Les réceptions : entrees_shift
// ---------------------------------------------------------------------------

/** Le produit dont l'entrée vit dans `inventaire_lignes.entrees` plutôt qu'ici. */
const CODE_DARINA = 'b7';

export interface EntreeStockCloud {
  produit_id: string;
  produit_code: string | null;
  produit_nom: string | null;
  quantite: string | number;
  fournisseur: string | null;
}

export interface LigneEntreeShift {
  inventaire_id: string;
  fournisseur_id: null;
  fournisseur_nom: string | null;
  produit_id: string;
  produit_nom: string;
  quantite: number;
  source: 'reception';
}

/**
 * Les réceptions détaillées, pour la traçabilité manager (« 20 pains reçus de
 * Boulangerie Awa ») — n'entrent dans AUCUN calcul d'argent, `ecart` et
 * `entrees` sont déjà figés côté POS et repris tels quels dans
 * `construireLignesInventaire`. `fournisseur_id` reste toujours `null` : le
 * POS ne connaît qu'un texte libre, jamais l'id structuré des fournisseurs
 * Samtrackly.
 */
export function construireEntreesShift(
  entrees: EntreeStockCloud[],
  invShiftId: string,
): LigneEntreeShift[] {
  const resultat: LigneEntreeShift[] = [];

  for (const e of entrees) {
    if (!e.produit_code || e.produit_code === CODE_DARINA) continue;

    resultat.push({
      inventaire_id: invShiftId,
      fournisseur_id: null,
      fournisseur_nom: e.fournisseur && e.fournisseur.trim() ? e.fournisseur : null,
      produit_id: e.produit_code,
      produit_nom: e.produit_nom ?? e.produit_code,
      quantite: n(e.quantite),
      source: 'reception',
    });
  }

  return resultat;
}
