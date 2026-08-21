// ──────────────────────────────────────────────────────────────────────────────
// Détail d'un shift transféré : dépenses d'achat et présences.
//
// Le shift porte les totaux ; ces deux tables portent ce que le gérant ouvre
// quand un chiffre le surprend. Fonctions PURES, testées
// (`samtrackly-detail.test.ts`) — la paie est de l'argent versé à quelqu'un de
// nommé, une erreur d'attribution est pire qu'une erreur de total.
// ──────────────────────────────────────────────────────────────────────────────
import { ACHATS, SALAIRES, type DepenseCloud } from './samtrackly-shift.ts';

/** Catégorie POS → libellé exact attendu par SamerTrackly (`CATEGORIES_DEPENSES`). */
const LIBELLE_CATEGORIE: Record<string, string> = {
  MARCHE: 'Marché',
  LEGUMES: 'Légumes',
  FRUITS: 'Fruits',
  ANNEXES: 'Dépenses annexes',
};

export interface DepenseDetail extends DepenseCloud {
  id?: string | null;
  libelle?: string | null;
  agent_id?: string | null;
}

export interface EquipeService {
  utilisateur_id?: string | null;
  poste_jour?: string | null;
  pointe_le?: string | null;
  reste?: boolean | null;
}

export interface FicheRH {
  travailleurId: string;
  nom: string;
}

export interface ContexteDetail {
  pointId: string;
  restaurantId: string;
  caissierId: string | null;
  caissierNom: string | null;
  date: string | null;
  heureDebut: string | null;
  heureFin: string | null;
}

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function cat(d: DepenseDetail): string {
  return String(d?.categorie ?? '').toUpperCase();
}

/** Une ligne du registre est-elle vivante ? (l'outbox n'a pas de DELETE) */
function vivante(d: DepenseDetail): boolean {
  return !d?.supprime;
}

export interface LigneDepense {
  id: string | null;
  point_id: string;
  categorie: string;
  libelle: string;
  montant: number;
  saisi_par: string;
  caissier_nom: string | null;
}

/**
 * Les ACHATS du registre, traduits pour SamerTrackly.
 *
 * L'`id` du POS est réutilisé tel quel : le même UUID des deux côtés rend
 * l'écriture idempotente sans clé supplémentaire — rejouer un transfert écrase
 * la même ligne au lieu d'en créer une seconde.
 *
 * Les salaires et encouragements ne descendent PAS ici : ils partent dans les
 * présences, où ils sont attribués à quelqu'un.
 */
export function construireDepenses(
  depenses: DepenseDetail[] | null | undefined,
  ctx: ContexteDetail,
): LigneDepense[] {
  return (depenses || [])
    .filter((d) => vivante(d) && (ACHATS as readonly string[]).includes(cat(d)))
    .map((d) => ({
      id: d.id ?? null,
      point_id: ctx.pointId,
      categorie: LIBELLE_CATEGORIE[cat(d)] ?? cat(d),
      libelle: d.libelle ?? '',
      montant: n(d.montant),
      saisi_par: 'caissier',
      caissier_nom: ctx.caissierNom,
    }));
}

export interface LignePresence {
  point_id: string;
  restaurant_id: string;
  caissier_id: string | null;
  travailleur_id: string;
  travailleur_nom: string;
  statut: string;
  paye: number;
  shift_nom: string;
  heure_debut: string;
  heure_fin: string;
  date: string | null;
}

/**
 * Qui était en poste sur ce service, et ce qu'il a touché.
 *
 * `paye` = salaire + encouragement de la personne, pris dans le registre par
 * `agent_id` (le POS impose `agent_id` non nul sur ces deux catégories).
 *
 * Une personne que la RH ne connaît pas — un employé créé sur place, dont
 * l'`externe_id` est vide — est **ignorée**. Insérer sa présence ferait échouer
 * la clé étrangère `travailleur_id` et bloquerait le transfert du shift entier,
 * ventes comprises. Elle apparaîtra dès que le siège aura créé sa fiche.
 */
export function construirePresences(
  equipe: EquipeService[] | null | undefined,
  depenses: DepenseDetail[] | null | undefined,
  fichesRH: Map<string, FicheRH>,
  ctx: ContexteDetail,
): LignePresence[] {
  // Paie par utilisateur POS, lignes effacées exclues.
  const paieParAgent = new Map<string, number>();
  for (const d of depenses || []) {
    if (!vivante(d) || !(SALAIRES as readonly string[]).includes(cat(d))) continue;
    const agent = d.agent_id;
    if (!agent) continue;
    paieParAgent.set(agent, (paieParAgent.get(agent) ?? 0) + n(d.montant));
  }

  const lignes: LignePresence[] = [];
  for (const membre of equipe || []) {
    const posId = membre?.utilisateur_id;
    if (!posId) continue;
    const fiche = fichesRH.get(posId);
    if (!fiche) continue; // inconnu de la RH — voir le commentaire ci-dessus

    lignes.push({
      point_id: ctx.pointId,
      restaurant_id: ctx.restaurantId,
      caissier_id: ctx.caissierId,
      travailleur_id: fiche.travailleurId,
      travailleur_nom: fiche.nom,
      statut: 'Présent',
      paye: paieParAgent.get(posId) ?? 0,
      shift_nom: membre.poste_jour ?? '',
      heure_debut: ctx.heureDebut ?? '',
      heure_fin: ctx.heureFin ?? '',
      date: ctx.date,
    });
  }
  return lignes;
}
