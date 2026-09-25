import { formatFCFA } from '@pos/shared';
import type { VueBord } from './bord';

/**
 * Le sens de la variation. Elle décide de la COULEUR et de rien d'autre :
 * la flèche et le signe redisent toujours l'information, pour qui ne
 * distingue pas le vert du rouge.
 */
export type Polarite = 'bon' | 'mauvais' | 'neutre';

export interface Indicateur {
  cle: string;
  libelle: string;
  polarite: Polarite;
  valeur: (v: VueBord) => number;
  format: (n: number) => string;
}

/**
 * Les indicateurs confrontés, dans l'ordre des tuiles de l'écran.
 *
 * L'écart de caisse se compare en VALEUR ABSOLUE : un manquant de 8 000 est
 * pire qu'un manquant de 2 500, alors que −8 000 < −2 500. Comparer les
 * signés dirait l'inverse.
 *
 * Les heures et les salaires sont `neutre` : travailler plus n'est ni bon ni
 * mauvais en soi, et les colorer ferait dire à l'écran ce qu'il ne sait pas.
 */
export const INDICATEURS: Indicateur[] = [
  { cle: 'ca', libelle: 'Chiffre d’affaires', polarite: 'bon', valeur: (v) => v.ca, format: formatFCFA },
  { cle: 'commandes', libelle: 'Commandes payées', polarite: 'bon', valeur: (v) => v.commandes, format: (n) => n.toLocaleString('fr-FR') },
  { cle: 'panier', libelle: 'Panier moyen', polarite: 'bon', valeur: (v) => v.panier, format: formatFCFA },
  { cle: 'depenses', libelle: 'Dépenses de caisse', polarite: 'mauvais', valeur: (v) => v.depenses, format: formatFCFA },
  { cle: 'retours', libelle: 'Retours', polarite: 'mauvais', valeur: (v) => v.retoursMontant, format: formatFCFA },
  { cle: 'ecart', libelle: 'Écart réconcilié', polarite: 'mauvais', valeur: (v) => Math.abs(v.ecartCumule), format: formatFCFA },
  { cle: 'heures', libelle: 'Heures travaillées', polarite: 'neutre', valeur: (v) => Math.round(v.heuresTravaillees), format: (n) => `${n} h` },
  { cle: 'salaires', libelle: 'Salaires payés en caisse', polarite: 'neutre', valeur: (v) => v.salaires, format: formatFCFA },
];

export interface Ecart {
  cle: string;
  libelle: string;
  valeurA: number;
  valeurB: number;
  /** B − A. Toujours vrai, même quand le pourcentage ne se calcule pas. */
  absolu: number;
  /** `null` quand A vaut zéro, ou qu'un des deux sites ne synchronise pas. */
  pourcentage: number | null;
  /** Pourquoi il n'y a pas de pourcentage, en français courant. */
  raison: string | null;
  polarite: Polarite;
  /** La variation joue-t-elle dans le bon sens ? Faux pour un neutre. */
  favorable: boolean;
  format: (n: number) => string;
}

export function ecarts(a: VueBord, b: VueBord): Ecart[] {
  // Un site non enrôlé n'a pas fait zéro de vente : il ne remonte rien. Le
  // comparer produirait un « −100 % » qu'on lirait comme un effondrement.
  const muet = !a.enrole ? a.nom : !b.enrole ? b.nom : null;

  return INDICATEURS.map((ind) => {
    const valeurA = ind.valeur(a);
    const valeurB = ind.valeur(b);
    const absolu = valeurB - valeurA;

    let pourcentage: number | null = null;
    let raison: string | null = null;

    if (muet) {
      raison = `${muet} ne synchronise pas encore : il n’y a rien à comparer.`;
    } else if (valeurA === 0) {
      raison =
        valeurB === 0
          ? 'Rien des deux côtés sur cette ligne.'
          : `${a.nom} est à zéro sur cette ligne : la variation ne se calcule pas.`;
    } else {
      pourcentage = Math.round((absolu / valeurA) * 100);
    }

    return {
      cle: ind.cle,
      libelle: ind.libelle,
      valeurA,
      valeurB,
      absolu,
      pourcentage,
      raison,
      polarite: ind.polarite,
      favorable: ind.polarite === 'bon' ? absolu > 0 : ind.polarite === 'mauvais' ? absolu < 0 : false,
      format: ind.format,
    };
  });
}

/**
 * Ce qu'on lit en premier : une phrase sur le chiffre d'affaires, puis les
 * trois plus gros écarts RELATIFS. Relatifs et non absolus : sur un groupe
 * de sept restaurants, l'absolu ne désignerait jamais que le plus gros.
 */
export function synthese(a: VueBord, b: VueBord): { phrase: string; lignes: Ecart[] } {
  const tous = ecarts(a, b);
  const principal = tous.find((e) => e.cle === 'ca');

  const lignes = tous
    .filter((e) => e.cle !== 'ca' && e.polarite !== 'neutre' && e.pourcentage !== null && e.pourcentage !== 0)
    .sort((x, y) => Math.abs(y.pourcentage ?? 0) - Math.abs(x.pourcentage ?? 0))
    .slice(0, 3);

  if (!principal) return { phrase: '', lignes };

  if (principal.raison) {
    // Un site qui ne synchronise pas n’a PAS « rien vendu » : on ne sait rien
    // de ses ventes. Réécrire sa raison en constat commercial produirait
    // exactement la conclusion fausse que la règle interdit — et comme un site
    // non enrôlé a toujours un CA à zéro, un test sur la valeur seule mord
    // systématiquement sur lui.
    const muet = !a.enrole || !b.enrole;
    const phrase =
      !muet && principal.valeurA === 0 && principal.valeurB > 0
        ? `${a.nom} n’a rien vendu sur cette période — ${b.nom} a fait ${formatFCFA(principal.valeurB)}.`
        : principal.raison;
    return { phrase, lignes };
  }

  if (principal.absolu === 0) {
    return { phrase: `${b.nom} fait exactement autant que ${a.nom}.`, lignes };
  }

  const sens = principal.absolu < 0 ? 'de moins' : 'de plus';
  const pct = principal.pourcentage ?? 0;
  return {
    phrase: `${b.nom} fait ${formatFCFA(Math.abs(principal.absolu))} ${sens} que ${a.nom} (${pct > 0 ? '+' : ''}${pct} %).`,
    lignes,
  };
}
