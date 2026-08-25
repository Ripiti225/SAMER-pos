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
