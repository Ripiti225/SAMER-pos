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
  inversee: 'Le début est après la fin.',
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

/** 'HH:MM' valide : deux chiffres, 00–23 puis 00–59. */
const HEURE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Plage horaire optionnelle d'une période saisie à la main. */
export interface HeuresPlage {
  /** Heure de début 'HH:MM' le jour `du` ; vide : dès minuit. */
  de: string;
  /** Dernière minute incluse 'HH:MM' le jour `au` ; vide : jusqu'à minuit. */
  a: string;
}

const minute = 60_000;

/** Vrai si `iso` tombe pile à minuit UTC. */
function aMinuit(iso: string): boolean {
  return new Date(iso).getTime() % jour === 0;
}

/**
 * Une plage saisie à la main. `du` et `au` sont des 'YYYY-MM-DD' INCLUSIFS :
 * « du 1er au 31 octobre » contient le 31 octobre en entier. `fin` étant
 * EXCLUE côté cloud, on va jusqu'à minuit le lendemain.
 *
 * Les heures resserrent la plage : « de 08:24 à 16:18 » compte la vente de
 * 16:18:40, comme on le lit — `fin` est donc posée à 16:19:00, exclue.
 */
export function personnalisee(
  du: string,
  au: string,
  maintenant = new Date(),
  heures: HeuresPlage = { de: '', a: '' },
): ResultatPeriode {
  if (!du || !au) return { ok: false, refus: 'incomplete' };
  if (du > au) return { ok: false, refus: 'inversee' };
  // Une heure à moitié tapée n'est pas une faute : on attend la frappe suivante.
  if ((heures.de && !HEURE.test(heures.de)) || (heures.a && !HEURE.test(heures.a))) {
    return { ok: false, refus: 'incomplete' };
  }

  const premiereJournee = new Date(`${du}T00:00:00.000Z`);
  const derniereJournee = new Date(`${au}T00:00:00.000Z`);
  const jours = Math.round((derniereJournee.getTime() - premiereJournee.getTime()) / jour) + 1;
  if (jours > DUREE_MAX_JOURS) return { ok: false, refus: 'trop_longue' };

  const debut = heures.de ? new Date(`${du}T${heures.de}:00.000Z`) : premiereJournee;
  const fin = heures.a
    ? new Date(new Date(`${au}T${heures.a}:00.000Z`).getTime() + minute)
    : new Date(derniereJournee.getTime() + jour);
  if (debut.getTime() >= fin.getTime()) return { ok: false, refus: 'inversee' };

  const debutIso = debut.toISOString();
  const finIso = fin.toISOString();
  const horaire = !aMinuit(debutIso) || !aMinuit(finIso);

  return {
    ok: true,
    periode: {
      cle: 'perso',
      libelle: horaire ? libelleHoraire(debutIso, finIso, maintenant) : libellePlage(du, au, maintenant),
      debut: debutIso,
      fin: finIso,
    },
  };
}

/**
 * « 18 oct. · 08:24 → 16:18 » sur un seul jour, « 17 oct. 08:24 → 18 oct. 16:18 »
 * sinon. L'heure de fin écrite est la dernière minute INCLUSE, celle qu'on a
 * tapée — pas la borne exclue envoyée au cloud.
 */
function libelleHoraire(debutIso: string, finIso: string, maintenant: Date): string {
  const derniere = new Date(new Date(finIso).getTime() - minute).toISOString();
  const ecrireAnnee = new Date(debutIso).getUTCFullYear() !== maintenant.getUTCFullYear()
    || new Date(derniere).getUTCFullYear() !== maintenant.getUTCFullYear();
  const j1 = jourMois(debutIso, ecrireAnnee);
  const j2 = jourMois(derniere, ecrireAnnee);
  if (j1 === j2) return `${j1} · ${heure(debutIso)} → ${heure(derniere)}`;
  return `${j1} ${heure(debutIso)} → ${j2} ${heure(derniere)}`;
}

/**
 * Le libellé de bornes reçues du cloud (la période d'en face d'une
 * comparaison). Des jours entiers s'écrivent en jours ; une plage horaire
 * garde ses heures, sans quoi « 08:24 → 16:18 hier » se lirait « hier ».
 */
export function libelleBornes(debutIso: string, finIso: string): string {
  if (aMinuit(debutIso) && aMinuit(finIso)) {
    const premier = jourCourt(debutIso);
    const dernier = jourCourt(new Date(new Date(finIso).getTime() - jour).toISOString());
    return premier === dernier ? premier : `${premier} → ${dernier}`;
  }
  const derniere = new Date(new Date(finIso).getTime() - minute).toISOString();
  const premier = jourCourt(debutIso);
  const dernier = jourCourt(derniere);
  if (premier === dernier) return `${premier} · ${heure(debutIso)} → ${heure(derniere)}`;
  return `${premier} ${heure(debutIso)} → ${dernier} ${heure(derniere)}`;
}
