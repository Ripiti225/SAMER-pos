import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatFCFA } from '@pos/shared';
import { appelSiege, ErreurSiege, type TableauBord as Bord } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { SelecteurPeriode } from '../components/SelecteurPeriode';
import { Tendance } from '../components/Tendance';
import { periodes, type Periode } from '../periode';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';

export function TableauBord({ filtre, onFiltre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const [periode, setPeriode] = useState<Periode>(() => periodes().jour);
  const { data: restos } = useRestaurants();
  const choisi = restoChoisi(restos?.restaurants, filtre);

  const { data, error, isPending } = useQuery({
    queryKey: ['tableau_bord', periode.debut, periode.fin],
    queryFn: () => appelSiege<Bord>('tableau_bord', { debut: periode.debut, fin: periode.fin }),
  });

  /**
   * Tendance : les lignes arrivent par restaurant ET par jour, on les cumule.
   * Filtrée, la somme ne retient que le restaurant choisi — il faut donc son
   * UUID POS, qu'un site non enrôlé n'a pas : la tendance y est vide, ce qui
   * est la vérité (il ne remonte rien).
   */
  const tendanceGroupe = useMemo(() => {
    const parJour = new Map<string, number>();
    for (const t of data?.tendance ?? []) {
      if (choisi && t.restaurant_id !== choisi.restaurant_id) continue;
      parJour.set(t.jour, (parJour.get(t.jour) ?? 0) + Number(t.ca));
    }
    return [...parJour.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([jour, ca]) => ({ jour, ca }));
  }, [data?.tendance, choisi]);

  const lignes = useMemo(
    () =>
      (data?.restaurants ?? [])
        .filter((l) => !choisi || l.samtrackly_id === choisi.samtrackly_id)
        .sort((a, b) => b.ca - a.ca),
    [data?.restaurants, choisi],
  );
  const totalCommandes = lignes.reduce((s, l) => s + l.nb_commandes, 0);
  /** Filtré, `data.total` (le groupe entier) serait faux : on resomme. */
  const total = choisi ? lignes.reduce((s, l) => s + l.ca, 0) : (data?.total ?? 0);

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Tableau de bord</h1>
        <div className="flex flex-wrap items-center gap-3">
          <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
          <SelecteurPeriode valeur={periode} onChoisir={setPeriode} />
        </div>
      </div>

      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}

      {data?.aucun_site_enrole && (
        <Info>
          <b>Aucun restaurant ne synchronise encore.</b> Les ventes affichent zéro parce que le cloud ne reçoit
          rien — pas parce que la journée a été blanche. Rien n’est perdu : chaque caisse empile ses ventes
          dans <code>sync_outbox</code> et remonte tout au premier enrôlement.
        </Info>
      )}

      {isPending ? (
        <Squelette lignes={4} />
      ) : (
        data && (
          <>
            {/* Chiffre d'appel : le CA du groupe sur la période, en très grand. */}
            <div className="mb-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end rounded-jeton border border-filet bg-carte p-5 shadow-e1">
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-faible">
                  {choisi ? `Chiffre d’affaires — ${choisi.nom}` : 'Chiffre d’affaires du groupe'}
                </p>
                <p className="chiffres mt-1 text-[42px] font-bold leading-none text-marque-sur-plan">{formatFCFA(total)}</p>
              </div>
              <p className="chiffres text-doux">
                {totalCommandes.toLocaleString('fr-FR')} commande{totalCommandes > 1 ? 's' : ''} payée
                {totalCommandes > 1 ? 's' : ''}
              </p>
            </div>

            {choisi && !choisi.enrole && (
              <Info>
                <b>{choisi.nom} ne synchronise pas encore.</b> Ses ventes n’arrivent pas au cloud : tout est à
                zéro ici, mais la caisse du site les empile et les remontera à l’enrôlement.
              </Info>
            )}

            {tendanceGroupe.length >= 2 && (
              <div className="mb-4 rounded-jeton border border-filet bg-carte p-5 shadow-e1">
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-faible">Jour par jour</h2>
                <Tendance points={tendanceGroupe} />
              </div>
            )}

            {/* Détail par restaurant. Les sites non enrôlés RESTENT dans la liste :
                les masquer laisserait croire que le groupe fait 2 restaurants. */}
            <div className="overflow-x-auto rounded-jeton border border-filet bg-carte shadow-e1">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-filet text-[12px] uppercase tracking-wide text-faible">
                    <th className="px-4 py-3 font-semibold">Restaurant</th>
                    <th className="px-4 py-3 text-right font-semibold">CA</th>
                    <th className="px-4 py-3 text-right font-semibold">Commandes</th>
                    <th className="px-4 py-3 text-right font-semibold">Panier moyen</th>
                    <th className="px-4 py-3 text-right font-semibold">Remises</th>
                    <th className="px-4 py-3 text-right font-semibold">Annulées</th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((l) => (
                    <tr key={l.samtrackly_id} className="border-b border-filet last:border-0">
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2 font-semibold">
                          <PastilleMarque marque={l.marque} />
                          {l.nom}
                        </span>
                        {!l.enrole && <span className="mt-0.5 block text-xs text-attente-txt">Pas encore enrôlé — ne remonte rien</span>}
                      </td>
                      <td className="chiffres px-4 py-3 text-right font-bold">{formatFCFA(l.ca)}</td>
                      <td className="chiffres px-4 py-3 text-right text-doux">{l.nb_commandes.toLocaleString('fr-FR')}</td>
                      <td className="chiffres px-4 py-3 text-right text-doux">{formatFCFA(l.panier_moyen)}</td>
                      <td className="chiffres px-4 py-3 text-right text-doux">{formatFCFA(l.remises)}</td>
                      <td className="chiffres px-4 py-3 text-right text-doux">{l.nb_annulees.toLocaleString('fr-FR')}</td>
                    </tr>
                  ))}
                  {lignes.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-doux">
                        Aucun restaurant remonté par SamerTrackly.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
    </section>
  );
}
