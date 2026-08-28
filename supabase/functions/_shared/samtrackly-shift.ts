// ──────────────────────────────────────────────────────────────────────────────
// Conversion d'un service de caisse clôturé en ligne `points_shifts` SamerTrackly.
//
// Fonction PURE, sans accès réseau : c'est la seule partie du pont qui manipule
// de l'argent, et une erreur ici ne plante pas — elle produit un chiffre faux
// qui part en production et se retrouve dans les rapports mensuels. D'où sa
// séparation du reste, et ses tests (`samtrackly-shift.test.ts`).
//
// Spéc : samtrackly/docs/superpowers/specs/2026-08-17-pos-samer-vers-samtrackly-design.md
//
// ⚠ RÈGLE INTANGIBLE — SamerTrackly ne REÇOIT jamais le fond de caisse du POS.
// Il garde sa propre logique : fond de veille + `espece` = fond restant. Le
// fond du POS sert ICI, dans le cloud, à retrouver la remise nette de la
// caissière ; il n'est transmis dans AUCUN champ (test dédié).
//
// ⚠ `espece` VIENT DU COMPTAGE À L'AVEUGLE (décision du boss, 2026-08-20).
// Auparavant je le calculais à partir des espèces enregistrées par le système.
// C'était une erreur : la vente théorique devenait une copie du système, donc
// l'écart théorique/machine ne pouvait PLUS JAMAIS révéler un manquant en
// espèces. Le contrôle historique du groupe était mort sans que ça se voie.
// ──────────────────────────────────────────────────────────────────────────────

/** Catégories du registre POS qui sont des ACHATS → colonne `depenses`. */
export const ACHATS = ['MARCHE', 'LEGUMES', 'FRUITS', 'ANNEXES'] as const;

/** Catégories qui sont de la PAIE → présences, jamais `depenses`. */
export const SALAIRES = ['SALAIRES', 'ENCOURAGEMENTS'] as const;

export interface DepenseCloud {
  categorie?: string | null;
  montant?: number | null;
  supprime?: boolean | null;
}

export interface ServiceCloud {
  id: string;
  ouvert_le?: string | null;
  cloture_le?: string | null;
  fond_de_caisse?: number | null;
  especes_comptees?: number | null;
  especes_theorique?: number | null;
  ecart?: number | null;
  explication_ecart?: string | null;
  rapport_z?: Record<string, unknown> | null;
  /** Journée choisie à la clôture, si le POS la demande un jour. Sinon dérivée. */
  journee_exploitation?: string | null;
}

export interface ContexteShift {
  restaurantId: string;
  pointId: string;
  caissierId: string | null;
  caissierNom: string | null;
}

/** Nombre sûr : une donnée absente vaut 0, jamais NaN. */
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Somme d'un dictionnaire de montants ({ YANGO: 40000, ... }). */
function somme(o: unknown): number {
  if (!o || typeof o !== 'object') return 0;
  return Object.values(o as Record<string, unknown>).reduce<number>((s, v) => s + n(v), 0);
}

/** `HH:MM` en UTC — Abidjan est à UTC+0, l'heure lue est l'heure réelle. */
function heure(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(11, 16);
}

/** `YYYY-MM-DD` en UTC. */
function jour(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Journée d'exploitation d'un shift : **le jour où il a COMMENCÉ**.
 *
 * Cette règle donne la bonne réponse pour les trois shifts réels du groupe,
 * sans rien demander à la caissière :
 *   16h → 00h30  ouvert le 17 → journée du 17 (la veille, vu de la clôture)
 *   00h → 08h    ouvert le 18 → journée du 18 (surtout PAS la veille)
 *   08h → 16h    ouvert le 18 → journée du 18
 *
 * Si le POS se met un jour à poser la question à la clôture, la valeur choisie
 * (`journee_exploitation`) l'emporte sur ce calcul.
 */
export function journeeExploitation(service: ServiceCloud): string | null {
  return service.journee_exploitation || jour(service.ouvert_le);
}

/** Reprise d'un site : à partir de quand ses services partent vers SamerTrackly. */
export interface ConfigPont {
  transferer_depuis?: string | null;
  actif?: boolean | null;
}

/**
 * Ce service doit-il partir vers SamerTrackly ?
 *
 * ⚠ POURQUOI CETTE PORTE EXISTE
 * Le cloud POS garde tout l'historique des services clôturés. Sans journée de
 * reprise, le premier passage du pont déverserait des semaines de shifts sur
 * des journées qui ont DÉJÀ leurs shifts saisis à la main dans SamerTrackly —
 * et `pos_service_id` n'y peut rien : un shift manuel et un shift POS décrivant
 * la même période sont deux lignes différentes. La journée serait comptée deux
 * fois, ce qui est précisément ce qu'on veut éviter.
 *
 * ⚠ ON COMPARE LA JOURNÉE D'EXPLOITATION, PAS L'HEURE DE CLÔTURE
 * Le shift du soir se clôture après minuit. Filtrer sur l'heure de clôture le
 * ferait basculer dans la journée suivante : à Angré 7E, le 16h→00h du 16/08 se
 * clôture le 17 à 00:00 et aurait franchi n'importe quelle limite posée au 17.
 * On aurait recréé un shift du 16 — journée déjà saisie à la main, et déjà
 * VALIDÉE par le gérant. La journée d'exploitation est la seule unité qui
 * corresponde à la façon dont le groupe compte.
 *
 * ⚠ SENS DU DÉFAUT
 * Pas de configuration = on ne transfère RIEN. Un site dont la reprise n'a pas
 * été décidée reste muet, plutôt que de déverser son passé. Comme partout dans
 * ce chantier, la panne bénigne est du côté du silence.
 *
 * @param config.transferer_depuis  journée `YYYY-MM-DD`, incluse. C'est la
 *   première journée que le POS prend en charge — donc la première dont plus
 *   aucun shift n'est saisi à la main.
 */
export function doitTransferer(
  service: { ouvert_le?: string | null; cloture_le?: string | null },
  config: ConfigPont | null | undefined,
): boolean {
  if (!config || config.actif === false) return false;
  // Un shift en cours n'a pas de rapport Z : il n'y a rien à transférer.
  if (!service?.cloture_le) return false;

  const depuis = String(config.transferer_depuis ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(depuis)) return false;

  const journee = journeeExploitation(service as ServiceCloud);
  if (!journee) return false;

  // Comparaison lexicographique : `YYYY-MM-DD` s'ordonne comme une date.
  return journee >= depuis;
}

/** Nombre de jours au-delà duquel on cesse de chercher un point ouvert. */
const RECHERCHE_JOURS_MAX = 31;

/** Jour suivant, au format `YYYY-MM-DD`. */
function lendemain(jourIso: string): string {
  const d = new Date(`${jourIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Journée sur laquelle le shift peut réellement atterrir.
 *
 * Un point validé par le gérant ne se rouvre pas — c'est déjà la règle côté
 * SamerTrackly, où un jour validé disparaît du sélecteur. Le shift bascule donc
 * au jour suivant plutôt que de se perdre. Ça ne devrait pas arriver ; quand ça
 * arrive, la vente est visible sur le lendemain et corrigeable, ce qui vaut
 * infiniment mieux qu'un transfert refusé en silence.
 *
 * @param souhaitee  journée d'exploitation du shift
 * @param pointsValides  `YYYY-MM-DD` → point validé ? (absent = pas de point)
 */
export function journeeDisponible(souhaitee: string, pointsValides: Map<string, boolean>): string {
  let jourCourant = souhaitee;
  for (let i = 0; i < RECHERCHE_JOURS_MAX; i++) {
    if (pointsValides.get(jourCourant) !== true) return jourCourant;
    jourCourant = lendemain(jourCourant);
  }
  // Un mois entier de points validés : anormal. On rend la main plutôt que de
  // tourner, l'appelant journalisera l'échec.
  return jourCourant;
}

/** Total du registre par famille de catégories, hors lignes effacées sur le site. */
function totalCategories(depenses: DepenseCloud[], familles: readonly string[]): number {
  return (depenses || [])
    .filter((d) => !d?.supprime && familles.includes(String(d?.categorie ?? '').toUpperCase()))
    .reduce((s, d) => s + n(d?.montant), 0);
}

/** Ligne prête à insérer dans `points_shifts` de SamerTrackly. */
export interface LigneShift {
  point_id: string;
  restaurant_id: string;
  date: string | null;
  caissier_id: string | null;
  caissier_nom: string | null;
  heure_debut: string | null;
  heure_fin: string | null;
  depenses: number;
  fournisseurs: number;
  kdo: number;
  retour: number;
  retour_pos: number;
  yango_cse: number;
  glovo_cse: number;
  wave: number;
  djamo: number;
  om: number;
  espece: number;
  vente_shift: number;
  ecart_pos: number;
  /** Motif saisi par le caissier, affiché sous son écart. */
  explication_ecart: string | null;
  /** Vente système du POS pour ce shift — alimente `points.vente_machine`. */
  vente_systeme_pos: number;
  pos_service_id: string;
  valide: boolean;
  valide_at: string;
}

export function construireShift(
  service: ServiceCloud,
  depenses: DepenseCloud[],
  ctx: ContexteShift,
): LigneShift {
  const z = (service.rapport_z ?? {}) as Record<string, unknown>;
  const livraisons = (z.livraisons ?? {}) as Record<string, unknown>;
  const modes = (z.modes_declares ?? {}) as Record<string, unknown>;
  const parMode = (z.par_mode ?? {}) as Record<string, unknown>;
  const offerts = (z.offerts ?? {}) as Record<string, unknown>;

  // Le registre, séparé en deux : les achats vont dans `depenses`, la paie part
  // dans les présences (décision : taux journalier automatique + encouragement).
  const achats = totalCategories(depenses, ACHATS);
  const paies = totalCategories(depenses, SALAIRES);

  // Ce que la caissière remet réellement : ce qu'elle a COMPTÉ à l'aveugle,
  // moins le fond qu'elle avait au départ. Les dépenses sorties du tiroir sont
  // déjà absentes de ce qu'elle a compté, il ne faut donc pas les retrancher
  // une seconde fois — elles reviennent dans la vente via `achats + paies`.
  //
  // Conséquence voulue : un manquant au comptage fait baisser la vente
  // théorique d'autant, et devient donc visible dans l'écart avec la vente
  // machine. C'est le contrôle que le groupe a toujours eu, préservé.
  const espece = n(service.especes_comptees) - n(service.fond_de_caisse);

  const kdo = n(offerts.total);
  const yango = n(livraisons.YANGO);
  const glovo = n(livraisons.GLOVO);
  const wave = n(modes.WAVE);
  const om = n(modes.ORANGE_MONEY ?? modes.OM);
  const djamo = n(modes.DJAMO);

  // La formule de SamerTrackly, à l'identique — celle que `calculerVenteShift()`
  // rejoue quand un manager corrige un point. `paies` y entre parce que la
  // colonne `depenses` ne porte QUE les achats (voir la spec, § 4.1).
  const vente = achats + paies + kdo + yango + glovo + wave + djamo + om + espece;

  return {
    point_id: ctx.pointId,
    restaurant_id: ctx.restaurantId,
    date: journeeExploitation(service),
    caissier_id: ctx.caissierId,
    caissier_nom: ctx.caissierNom,
    heure_debut: heure(service.ouvert_le),
    heure_fin: heure(service.cloture_le),
    depenses: achats,
    // Le gérant paie les fournisseurs, dans Déductions gérant. Jamais la caisse.
    fournisseurs: 0,
    kdo,
    // `retour` reste neutre : `calculerVenteShift()` le somme, et le montant
    // rentrerait tout seul dans la vente à la première correction d'un manager.
    retour: 0,
    retour_pos: n(z.retours),
    yango_cse: yango,
    glovo_cse: glovo,
    wave,
    djamo,
    om,
    espece,
    vente_shift: vente,
    // Mesuré au comptage à l'aveugle. Négatif = manquant. Il voyage à part pour
    // rester imputable à une personne — et depuis le 2026-08-20 il se retrouve
    // AUSSI dans l'écart théorique/machine, puisque `espece` vient du comptage.
    // Les deux vues montrent le même fait : ne pas déduire deux fois.
    ecart_pos: n(service.ecart),
    explication_ecart: service.explication_ecart?.trim() || null,
    // La vente réelle du système, que le gérant tapait à la main jusqu'ici.
    vente_systeme_pos: n(z.total_ventes),
    pos_service_id: service.id,
    valide: true,
    valide_at: service.cloture_le || new Date().toISOString(),
  };
}

/**
 * Le total affiché aux managers sur `points.vente_total` — même formule que
 * `recalculerVenteTotalePoint()` côté SamerTrackly (app/modifier-point.js),
 * pour que le pont produise exactement le nombre qu'un manager obtiendrait en
 * rouvrant le point à la main.
 *
 * Ce cache est lu par dashboard.js, rapports.js, rapportMensuel.js,
 * rapportHebdo.js et verification.js (déductions du vérificateur) : un point
 * créé par le pont sans ce total affiche 0 F partout ailleurs, quels que
 * soient les vrais montants dans points_shifts.
 */
export function totalVentePoint(shifts: { vente_shift?: number | null }[] | null | undefined): number {
  return (shifts || []).reduce((somme, s) => somme + (Number(s?.vente_shift) || 0), 0);
}

/**
 * La vente machine du point : somme des ventes système des shifts du POS.
 *
 * Ce chiffre était tapé à la main par le gérant, lu sur l'écran de la caisse.
 * Les 19 et 20 août 2026, personne ne l'a saisi sur un site pourtant basculé —
 * et l'écart théorique/machine a disparu en silence ces deux jours-là. Le POS
 * connaît ce total exactement : il n'y a plus de raison de le faire retaper.
 *
 * Un shift saisi à la main n'a pas de `vente_systeme_pos` et compte pour 0 —
 * le jour de bascule, où les deux cohabitent, le total ne porte donc que la
 * part venue du POS.
 */
export function totalVenteMachinePoint(
  shifts: { vente_systeme_pos?: number | null }[] | null | undefined,
): number {
  return (shifts || []).reduce((somme, s) => somme + (Number(s?.vente_systeme_pos) || 0), 0);
}

/**
 * La journée sur laquelle écrire, selon que le service arrive pour la première
 * fois ou qu'on le rejoue.
 *
 * ⚠ INCIDENT DU 2026-08-20 — ce qu'il ne faut plus jamais reproduire.
 * Le gérant avait validé les points du 17 et du 18. Un rejeu, lancé pour
 * appliquer une nouvelle formule, a fait repasser ces shifts par
 * `journeeDisponible` : les 6 shifts du 17 et du 18 ont été relocalisés sur le
 * 19, le premier jour ouvert. De l'argent réel a changé de journée, et les
 * deux journées validées se sont retrouvées vides mais avec leurs anciens
 * totaux figés.
 *
 * La règle du boss — « un point validé ne se rouvre pas, le shift va au jour
 * suivant » — reste vraie pour un shift QUI ARRIVE POUR LA PREMIÈRE FOIS.
 * Elle n'a aucun sens pour un shift déjà placé : celui-là appartient à sa
 * journée, validée ou non. Un rejeu doit être une réécriture au même endroit,
 * jamais un déménagement.
 *
 * @param dejaTransfere  ce service a déjà abouti au moins une fois
 */
export function journeePourTransfert(
  souhaitee: string,
  pointsValides: Map<string, boolean>,
  dejaTransfere: boolean,
): string {
  if (dejaTransfere) return souhaitee;
  return journeeDisponible(souhaitee, pointsValides);
}

/**
 * Ce service a-t-il DÉJÀ été posé sur une journée SamerTrackly ?
 *
 * ⚠ NE PAS UTILISER `transfere_le` POUR CETTE QUESTION.
 * `rejouer_transferts()` remet `transfere_le` à NULL, et il le fait AVANT que
 * la fonction ne tourne. Un rejeu ferait donc passer tous les services pour
 * neufs, et ils seraient relocalisés — c'est exactement l'erreur commise le
 * 2026-08-20, deux fois de suite.
 *
 * `journee` et `point_id`, eux, survivent au rejeu : ce sont les seuls
 * marqueurs fiables du fait qu'un service a déjà atterri quelque part. Leur
 * VALEUR peut être fausse (le mauvais rejeu les a écrasés) — on ne s'en sert
 * que comme drapeau, jamais comme cible : la vraie journée est toujours
 * recalculée depuis `ouvert_le`.
 */
export function aDejaEtePlace(
  transfert: { journee?: string | null; point_id?: string | null } | null | undefined,
): boolean {
  return !!(transfert?.journee || transfert?.point_id);
}
