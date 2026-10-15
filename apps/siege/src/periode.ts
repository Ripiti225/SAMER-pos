/**
 * Bornes de période, envoyées telles quelles à la fonction (`debut`, `fin`).
 *
 * Abidjan est à UTC+0 toute l'année : aucun décalage à gérer, un jour civil est
 * un jour UTC. C'est déjà l'hypothèse des RPC côté cloud (`AT TIME ZONE
 * 'Africa/Abidjan'`), on ne la contredit pas ici.
 */
export interface Periode {
  cle: string;
  libelle: string;
  debut: string;
  fin: string;
}

const jour = 86_400_000;

/** Minuit du jour de `d`, en UTC. */
function minuit(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Ordre d'affichage des chips. */
export const CLES_PERIODE = ['jour', 'hier', '7j', '30j', 'mois'] as const;
export type ClePeriode = (typeof CLES_PERIODE)[number];

/**
 * `fin` est EXCLUE côté cloud (`< p_fin`) : on va donc jusqu'à minuit demain.
 *
 * Rendu en Record et non en tableau : `tsconfig` a `noUncheckedIndexedAccess`,
 * et un `periodes()[0]` obligerait chaque appelant à traiter un `undefined`
 * qui ne peut pas arriver.
 */
export function periodes(maintenant = new Date()): Record<ClePeriode, Periode> {
  const debutJour = minuit(maintenant);
  const demain = new Date(debutJour.getTime() + jour);
  const moisCourant = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), 1));

  return {
    jour: { cle: 'jour', libelle: "Aujourd'hui", debut: debutJour.toISOString(), fin: demain.toISOString() },
    hier: { cle: 'hier', libelle: 'Hier', debut: new Date(debutJour.getTime() - jour).toISOString(), fin: debutJour.toISOString() },
    '7j': { cle: '7j', libelle: '7 derniers jours', debut: new Date(debutJour.getTime() - 6 * jour).toISOString(), fin: demain.toISOString() },
    '30j': { cle: '30j', libelle: '30 derniers jours', debut: new Date(debutJour.getTime() - 29 * jour).toISOString(), fin: demain.toISOString() },
    mois: { cle: 'mois', libelle: 'Ce mois-ci', debut: moisCourant.toISOString(), fin: demain.toISOString() },
  };
}

/** La liste, dans l'ordre des chips. */
export function listePeriodes(maintenant = new Date()): Periode[] {
  const p = periodes(maintenant);
  return CLES_PERIODE.map((c) => p[c]);
}

/** « lun. 24 août » — court, sans l'année, pour un axe ou une ligne de liste. */
export function jourCourt(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** « 24/08 à 21:05 » — pour une clôture, où l'heure compte. */
export function dateHeure(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/** « 21:05 » — quand la date est déjà donnée par le contexte (un service). */
export function heure(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

/**
 * Plage maximale d'une période saisie à la main.
 *
 * La console agrège ligne à ligne côté navigateur : au-delà d'un an, la
 * requête devient longue pour une lecture que personne ne fait. 366 et non
 * 365, pour qu'une année bissextile entière passe.
 */
export const DUREE_MAX_JOURS = 366;

/** Ce qui cloche dans une plage saisie. */
export type RefusPeriode = 'incomplete' | 'inversee' | 'trop_longue';

/** Le message montré sous les champs — français courant, jamais un code. */
export const MESSAGES_REFUS: Record<RefusPeriode, string> = {
  incomplete: 'Choisissez une date de début et une date de fin.',
  inversee: 'La date de début est après la date de fin.',
  trop_longue: 'Choisissez une plage d\'un an au maximum.',
};

/**
 * Un refus n'est pas une exception : l'appelant est un champ de formulaire,
 * il affiche le message et attend la frappe suivante. Rien à rattraper.
 */
export type ResultatPeriode = { ok: true; periode: Periode } | { ok: false; refus: RefusPeriode };

/** « 31 oct. » ou « 31 oct. 2024 » — l'année seulement si ce n'est pas celle en cours. */
function jourMois(iso: string, avecAnnee: boolean): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    ...(avecAnnee ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

/**
 * Libellé d'une plage, écrit comme on le dirait : « 1 → 31 oct. » quand le
 * mois est le même, « 1 oct. → 15 nov. » sinon. L'année n'apparaît que si
 * elle n'est pas l'année en cours — sinon elle encombre chaque bandeau.
 */
function libellePlage(du: string, au: string, maintenant: Date): string {
  const d = new Date(`${du}T00:00:00.000Z`);
  const a = new Date(`${au}T00:00:00.000Z`);
  const anneeCourante = maintenant.getUTCFullYear();
  const memeAnnee = d.getUTCFullYear() === a.getUTCFullYear();
  const ecrireAnnee = !memeAnnee || d.getUTCFullYear() !== anneeCourante;

  if (memeAnnee && d.getUTCMonth() === a.getUTCMonth()) {
    return `${d.getUTCDate()} → ${jourMois(a.toISOString(), ecrireAnnee)}`;
  }
  return `${jourMois(d.toISOString(), !memeAnnee)} → ${jourMois(a.toISOString(), ecrireAnnee)}`;
}

/**
 * Une plage saisie à la main. `du` et `au` sont des 'YYYY-MM-DD' INCLUSIFS :
 * « du 1er au 31 octobre » contient le 31 octobre en entier. `fin` étant
 * EXCLUE côté cloud, on va jusqu'à minuit le lendemain.
 */
export function personnalisee(du: string, au: string, maintenant = new Date()): ResultatPeriode {
  if (!du || !au) return { ok: false, refus: 'incomplete' };
  if (du > au) return { ok: false, refus: 'inversee' };

  const debut = new Date(`${du}T00:00:00.000Z`);
  const derniereJournee = new Date(`${au}T00:00:00.000Z`);
  const jours = Math.round((derniereJournee.getTime() - debut.getTime()) / jour) + 1;
  if (jours > DUREE_MAX_JOURS) return { ok: false, refus: 'trop_longue' };

  return {
    ok: true,
    periode: {
      cle: 'perso',
      libelle: libellePlage(du, au, maintenant),
      debut: debut.toISOString(),
      fin: new Date(derniereJournee.getTime() + jour).toISOString(),
    },
  };
}
