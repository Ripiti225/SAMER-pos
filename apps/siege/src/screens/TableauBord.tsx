import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { appelSiege, ErreurSiege, type Bord, type RestoGroupe } from '../api';
import { nb, vueBord } from '../bord';
import { Bloc, BlocsBord, TuilesBord } from '../components/BlocsBord';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { SelecteurPeriode } from '../components/SelecteurPeriode';
import { BarresHorizontales, couleurSerie, type Serie } from '../components/Graphes';
import { periodes, type Periode } from '../periode';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';

export function TableauBord({ filtre, onFiltre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const [periode, setPeriode] = useState<Periode>(() => periodes().jour);
  const { data: restos } = useRestaurants();
  const choisi = restoChoisi(restos?.restaurants, filtre);

  const { data, error, isPending } = useQuery({
    queryKey: ['tableau_bord', periode.debut, periode.fin],
    queryFn: () => appelSiege<Bord>('tableau_bord', { debut: periode.debut, fin: periode.fin }),
    // Écran de veille : il doit se tenir à jour tout seul sans qu'on y touche.
    refetchInterval: 60_000,
  });

  /**
   * Les séries : une couleur par restaurant, prise sur la liste COMPLÈTE et
   * stable des restaurants — jamais sur la liste filtrée. Un filtre qui change
   * le nombre de séries ne doit pas repeindre les survivants.
   */
  const series = useMemo<Serie[]>(() => {
    const tous = (restos?.restaurants ?? []).filter((r): r is RestoGroupe & { restaurant_id: string } => !!r.restaurant_id);
    return tous
      .map((r, i) => ({ cle: r.restaurant_id, libelle: r.nom, couleur: couleurSerie(i) }))
      .filter((s) => !choisi || s.cle === choisi.restaurant_id);
  }, [restos, choisi]);

  const nomResto = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of restos?.restaurants ?? []) if (r.restaurant_id) m.set(r.restaurant_id, r.nom);
    return m;
  }, [restos]);

  /**
   * La vue : tout ce que les blocs affichent, dérivé UNE FOIS et sans React.
   *
   * Un site non enrôlé n'a pas d'UUID POS. Lui laisser `null` le ferait passer
   * pour « tous les restaurants » et afficherait le groupe entier sous son
   * nom : on passe son identifiant SamerTrackly, qui ne correspond à aucune
   * ligne de vente et laisse donc la vue vide — ce qui est la vérité.
   */
  const vue = useMemo(
    () =>
      vueBord(data, {
        restaurantId: choisi ? (choisi.restaurant_id ?? choisi.samtrackly_id) : null,
        nom: choisi?.nom ?? 'Tous les restaurants',
        enrole: choisi ? choisi.enrole : true,
        noms: nomResto,
      }),
    [data, choisi, nomResto],
  );

  /**
   * Le classement des 7 restaurants n'appartient à aucune vue : il les
   * COMPARE. Il reste donc ici, et ne s'affiche que sans filtre.
   */
  const classement = useMemo(() => (data?.restaurants ?? []).filter((r) => r.restaurant_id), [data?.restaurants]);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{choisi ? choisi.nom : 'Tableau de bord'}</h1>
          <p className="text-doux">{choisi ? 'Un restaurant' : 'Les 7 restaurants en un seul endroit'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
          <SelecteurPeriode valeur={periode} onChoisir={setPeriode} />
        </div>
      </div>

      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}

      {data?.aucun_site_enrole && (
        <Info>
          <b>Aucun restaurant ne synchronise encore.</b> Tout affiche zéro parce que le cloud ne reçoit rien — pas
          parce que la journée a été blanche. Chaque caisse empile ses ventes et remontera tout au premier enrôlement.
        </Info>
      )}
      {data?.salle_non_publiee && (
        <Info>
          Les tables remontent sous leur identifiant, sans nom. Lancez <code>pnpm salle:republier</code> sur le
          restaurant : le plan de salle ne monte pas tout seul, la synchro n’enregistre que les changements.
        </Info>
      )}

      {isPending ? (
        <Squelette lignes={5} />
      ) : (
        <div className="space-y-4">
          {/* ---------- Couche 1 : lisible de loin ---------- */}
          <TuilesBord vue={vue} />

          <BlocsBord
            vue={vue}
            series={series}
            repartition={
              !choisi && (
                <div className="grid gap-4 xl:grid-cols-2">
                  <Bloc titre="Chiffre d’affaires par restaurant">
                    <BarresHorizontales
                      lignes={[...classement]
                        .sort((a, b) => nb(b.ca) - nb(a.ca))
                        .map((l) => ({
                          cle: l.samtrackly_id,
                          libelle: l.nom,
                          valeur: nb(l.ca),
                          detail: l.enrole ? `${nb(l.nb_commandes)} commande(s)` : 'non enrôlé',
                          couleur: l.restaurant_id
                            ? couleurSerie((restos?.restaurants ?? []).filter((r) => r.restaurant_id).findIndex((r) => r.restaurant_id === l.restaurant_id))
                            : 'var(--filet-fort)',
                        }))}
                    />
                  </Bloc>
                  <Bloc titre="Panier moyen par restaurant">
                    <BarresHorizontales
                      lignes={[...classement]
                        .sort((a, b) => nb(b.panier_moyen) - nb(a.panier_moyen))
                        .map((l) => ({ cle: l.samtrackly_id, libelle: l.nom, valeur: nb(l.panier_moyen) }))}
                    />
                  </Bloc>
                </div>
              )
            }
          />
        </div>
      )}
    </section>
  );
}
