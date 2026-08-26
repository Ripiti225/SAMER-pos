import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { IconAlertTriangle, IconPlugConnectedX } from '@tabler/icons-react';
import { appeler, bornes, fcfa, type RestoTableau, type TableauBord as Donnees } from '../api';

type Periode = 'jour' | 'semaine' | 'mois';

const LIBELLES: Record<Periode, string> = {
  jour: "Aujourd'hui",
  semaine: 'Cette semaine',
  mois: 'Ce mois',
};

const COULEUR_MARQUE: Record<string, string> = {
  SAMER: '#ef9f27',
  AL_KAYAN: '#2d7d46',
};

/** Chiffre mis en avant, en tête d'écran. */
function Bandeau({ libelle, valeur, precision }: { libelle: string; valeur: string; precision?: string }): JSX.Element {
  return (
    <div className="carte flex-1 p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-doux">{libelle}</div>
      <div className="mt-1.5 text-[30px] font-bold leading-none tracking-tight text-fort tabular-nums">{valeur}</div>
      {precision && <div className="mt-1.5 text-sm text-doux">{precision}</div>}
    </div>
  );
}

/**
 * Barre de comparaison entre restaurants.
 *
 * La longueur est relative au MEILLEUR du groupe, pas au total : on cherche à
 * voir d'un coup d'œil qui décroche, et sept parts d'un camembert à 14 % chacune
 * ne montrent rien.
 */
function Barre({ part, couleur }: { part: number; couleur: string }): JSX.Element {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--carte-douce)' }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.max(part * 100, part > 0 ? 2 : 0)}%`, background: couleur }}
      />
    </div>
  );
}

function LigneResto({ resto, maximum }: { resto: RestoTableau; maximum: number }): JSX.Element {
  const couleur = COULEUR_MARQUE[resto.marque] ?? COULEUR_MARQUE.SAMER!;
  return (
    <tr>
      <td>
        <div className="flex items-center gap-2.5">
          <span className="pastille" style={{ background: couleur }} />
          <span className="font-semibold text-fort">{resto.nom}</span>
          {!resto.enrole && (
            <span
              className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{ background: 'var(--attente-tint)', color: 'var(--attente-txt)' }}
              title="Le POS de ce restaurant ne synchronise pas encore avec le cloud."
            >
              non enrôlé
            </span>
          )}
        </div>
      </td>
      <td className="w-[26%]">
        <Barre part={maximum > 0 ? resto.ca / maximum : 0} couleur={couleur} />
      </td>
      <td className="num font-bold text-fort">{fcfa(resto.ca)}</td>
      <td className="num text-doux">{resto.nb_commandes.toLocaleString('fr-FR')}</td>
      <td className="num text-doux">{resto.panier_moyen > 0 ? fcfa(resto.panier_moyen) : '—'}</td>
      <td className="num">
        {resto.remises > 0 ? <span style={{ color: 'var(--attente-txt)' }}>{fcfa(resto.remises)}</span> : <span className="text-faible">—</span>}
      </td>
      <td className="num">
        {resto.nb_annulees > 0 ? (
          <span style={{ color: 'var(--alerte-txt)' }}>{resto.nb_annulees}</span>
        ) : (
          <span className="text-faible">—</span>
        )}
      </td>
    </tr>
  );
}

function Squelette(): JSX.Element {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <div key={i} className="squelette h-11 w-full" />
      ))}
    </div>
  );
}

export function TableauBord(): JSX.Element {
  const [periode, setPeriode] = useState<Periode>('jour');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tableau_bord', periode],
    queryFn: () => appeler<Donnees>('tableau_bord', bornes(periode)),
  });

  const restos = data?.restaurants ?? [];
  const classes = [...restos].sort((a, b) => b.ca - a.ca);
  const maximum = classes[0]?.ca ?? 0;
  const nbEnroles = restos.filter((r) => r.enrole).length;
  const totalCommandes = restos.reduce((s, r) => s + r.nb_commandes, 0);

  return (
    <div className="mx-auto max-w-[1180px] p-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight text-fort">Tableau de bord</h1>
          <p className="mt-1 text-doux">
            {restos.length} restaurants · {nbEnroles} synchronisent avec le cloud
          </p>
        </div>
        <div className="flex gap-2">
          {(Object.keys(LIBELLES) as Periode[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriode(p)}
              className={periode === p ? 'btn-accent' : 'btn-blanc'}
              style={{ minHeight: 42, fontSize: 14 }}
            >
              {LIBELLES[p]}
            </button>
          ))}
        </div>
      </header>

      {/* Aucun site enrôlé : le dire franchement. Un tableau à 0 F sans
          explication ferait croire à une journée blanche dans 7 restaurants. */}
      {data?.aucun_site_enrole && (
        <div
          className="mb-6 flex items-start gap-3 rounded-jeton p-4"
          style={{ background: 'var(--info-tint)', color: 'var(--info-txt)' }}
        >
          <IconPlugConnectedX size={22} style={{ flex: 'none', marginTop: 1 }} />
          <div className="text-sm leading-relaxed">
            <strong>Aucun restaurant ne synchronise encore.</strong> Les ventes affichées resteront à zéro tant
            qu'un site n'aura pas été enrôlé. Rien n'est perdu pendant ce temps : chaque caisse empile ses ventes
            en local et les remontera intégralement au premier enrôlement.
          </div>
        </div>
      )}

      {isError && (
        <div
          className="mb-6 flex items-start gap-3 rounded-jeton p-4"
          style={{ background: 'var(--alerte-tint)', color: 'var(--alerte-txt)' }}
        >
          <IconAlertTriangle size={22} style={{ flex: 'none', marginTop: 1 }} />
          <div className="text-sm">{(error as Error).message}</div>
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-4">
        <Bandeau
          libelle={`Chiffre d'affaires — ${LIBELLES[periode].toLowerCase()}`}
          valeur={fcfa(data?.total ?? 0)}
          precision={`${totalCommandes.toLocaleString('fr-FR')} commandes payées`}
        />
        <Bandeau
          libelle="Meilleur restaurant"
          valeur={classes[0] && classes[0].ca > 0 ? classes[0].nom : '—'}
          precision={classes[0] && classes[0].ca > 0 ? fcfa(classes[0].ca) : 'Pas encore de vente'}
        />
        <Bandeau
          libelle="Panier moyen du groupe"
          valeur={totalCommandes > 0 ? fcfa((data?.total ?? 0) / totalCommandes) : '—'}
          precision={totalCommandes > 0 ? 'Toutes marques confondues' : undefined}
        />
      </div>

      <div className="carte overflow-hidden">
        <div className="border-b border-bordure px-5 py-4">
          <h2 className="font-bold text-fort">Comparatif des restaurants</h2>
        </div>
        <div className="p-2">
          {isLoading ? (
            <div className="p-3">
              <Squelette />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl-siege">
                <thead>
                  <tr>
                    <th>Restaurant</th>
                    <th />
                    <th className="num">Chiffre d'affaires</th>
                    <th className="num">Commandes</th>
                    <th className="num">Panier moyen</th>
                    <th className="num">Remises</th>
                    <th className="num">Annulées</th>
                  </tr>
                </thead>
                <tbody>
                  {classes.map((r) => (
                    <LigneResto key={r.samtrackly_id} resto={r} maximum={maximum} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
