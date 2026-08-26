import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { IconAlertTriangle, IconPlugConnectedX } from '@tabler/icons-react';
import { appeler, bornes, fcfa, type TableauBord as Donnees } from '../api';

interface Cloture {
  restaurant_id: string;
  service_id: string;
  caissier_id: string | null;
  ouvert_le: string;
  cloture_le: string | null;
  statut: string | null;
  fond_de_caisse: number | null;
  especes_comptees: number | null;
  especes_theorique: number | null;
  ecart: number | null;
}

type Periode = 'jour' | 'semaine' | 'mois';

const LIBELLES: Record<Periode, string> = {
  jour: "Aujourd'hui",
  semaine: 'Cette semaine',
  mois: 'Ce mois',
};

/**
 * Seuil d'alerte par défaut du POS (`parametres_locaux.seuil_alerte_ecart_caisse`).
 * Il est réglable par restaurant ; la console ne descend pas encore ces réglages,
 * on prend donc la valeur par défaut du cahier des charges.
 */
const SEUIL_ECART = 2000;

function dateCourte(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Un écart n'est pas qu'un chiffre : son SIGNE change la lecture.
 * Un manque (négatif) est le cas qui doit sauter aux yeux ; un excédent
 * signale plutôt une erreur de saisie ou de rendu de monnaie.
 */
function Ecart({ valeur }: { valeur: number | null }): JSX.Element {
  if (valeur === null) return <span className="text-faible">—</span>;
  if (valeur === 0) return <span style={{ color: 'var(--ok-txt)' }}>juste</span>;

  const grave = Math.abs(valeur) >= SEUIL_ECART;
  const couleur = valeur < 0 ? 'var(--alerte-txt)' : 'var(--attente-txt)';
  const fond = valeur < 0 ? 'var(--alerte-tint)' : 'var(--attente-tint)';

  return (
    <span
      className="inline-block rounded-full px-2.5 py-1 font-semibold"
      style={grave ? { background: fond, color: couleur } : { color: couleur }}
      title={grave ? `Au-delà du seuil d'alerte de ${fcfa(SEUIL_ECART)}` : undefined}
    >
      {valeur > 0 ? '+' : ''}
      {fcfa(valeur)}
    </span>
  );
}

export function Clotures(): JSX.Element {
  const [periode, setPeriode] = useState<Periode>('semaine');

  const restos = useQuery({
    queryKey: ['tableau_bord', 'jour'],
    queryFn: () => appeler<Donnees>('tableau_bord', bornes('jour')),
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['clotures', periode],
    queryFn: () => appeler<{ clotures: Cloture[] }>('clotures', bornes(periode)),
  });

  // Le cloud ne connaît les restaurants que par leur UUID : on rapatrie les
  // noms depuis la même source que le tableau de bord.
  const nomParId = new Map(
    (restos.data?.restaurants ?? []).filter((r) => r.restaurant_id).map((r) => [r.restaurant_id!, r.nom]),
  );

  const lignes = data?.clotures ?? [];
  const horsSeuil = lignes.filter((c) => c.ecart !== null && Math.abs(c.ecart) >= SEUIL_ECART);
  const manquant = lignes.reduce((s, c) => s + (c.ecart && c.ecart < 0 ? c.ecart : 0), 0);

  return (
    <div className="mx-auto max-w-[1180px] p-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight text-fort">Clôtures & écarts</h1>
          <p className="mt-1 text-doux">
            Chaque service fermé par un caissier, avec son comptage à l'aveugle et son écart.
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

      {isError && (
        <div
          className="mb-6 flex items-start gap-3 rounded-jeton p-4"
          style={{ background: 'var(--alerte-tint)', color: 'var(--alerte-txt)' }}
        >
          <IconAlertTriangle size={22} style={{ flex: 'none', marginTop: 1 }} />
          <div className="text-sm">{(error as Error).message}</div>
        </div>
      )}

      {!isLoading && lignes.length === 0 && !isError && (
        <div
          className="flex items-start gap-3 rounded-jeton p-4"
          style={{ background: 'var(--info-tint)', color: 'var(--info-txt)' }}
        >
          <IconPlugConnectedX size={22} style={{ flex: 'none', marginTop: 1 }} />
          <div className="text-sm leading-relaxed">
            Aucune clôture sur cette période. Tant qu'aucun restaurant n'est enrôlé, les services fermés restent
            dans la base locale de chaque caisse et ne remontent pas ici.
          </div>
        </div>
      )}

      {lignes.length > 0 && (
        <>
          <div className="mb-6 flex flex-wrap gap-4">
            <div className="carte flex-1 p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-doux">Services clôturés</div>
              <div className="mt-1.5 text-[30px] font-bold leading-none text-fort tabular-nums">{lignes.length}</div>
            </div>
            <div className="carte flex-1 p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-doux">Au-delà du seuil</div>
              <div
                className="mt-1.5 text-[30px] font-bold leading-none tabular-nums"
                style={{ color: horsSeuil.length > 0 ? 'var(--alerte-txt)' : 'var(--txt)' }}
              >
                {horsSeuil.length}
              </div>
              <div className="mt-1.5 text-sm text-doux">Écart supérieur à {fcfa(SEUIL_ECART)}</div>
            </div>
            <div className="carte flex-1 p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-doux">Total manquant</div>
              <div
                className="mt-1.5 text-[30px] font-bold leading-none tabular-nums"
                style={{ color: manquant < 0 ? 'var(--alerte-txt)' : 'var(--txt)' }}
              >
                {fcfa(manquant)}
              </div>
              <div className="mt-1.5 text-sm text-doux">Excédents non déduits</div>
            </div>
          </div>

          <div className="carte overflow-hidden">
            <div className="overflow-x-auto p-2">
              <table className="tbl-siege">
                <thead>
                  <tr>
                    <th>Restaurant</th>
                    <th>Ouvert</th>
                    <th>Clôturé</th>
                    <th className="num">Fond</th>
                    <th className="num">Théorique</th>
                    <th className="num">Compté</th>
                    <th className="num">Écart</th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((c) => (
                    <tr key={`${c.restaurant_id}-${c.service_id}`}>
                      <td className="font-semibold text-fort">
                        {nomParId.get(c.restaurant_id) ?? 'Restaurant inconnu'}
                      </td>
                      <td className="text-doux">{dateCourte(c.ouvert_le)}</td>
                      <td className="text-doux">
                        {c.statut === 'OUVERT' ? (
                          <span style={{ color: 'var(--ok-txt)' }}>en cours</span>
                        ) : (
                          dateCourte(c.cloture_le)
                        )}
                      </td>
                      <td className="num text-doux">{c.fond_de_caisse !== null ? fcfa(c.fond_de_caisse) : '—'}</td>
                      <td className="num text-doux">
                        {c.especes_theorique !== null ? fcfa(c.especes_theorique) : '—'}
                      </td>
                      <td className="num text-fort">
                        {c.especes_comptees !== null ? fcfa(c.especes_comptees) : '—'}
                      </td>
                      <td className="num">
                        <Ecart valeur={c.ecart} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
