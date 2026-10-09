import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { appelSiege, ErreurSiege, type Bord, type RestoGroupe } from '../api';
import { nb, vueBord, type ContexteVue, type VueBord } from '../bord';
import { BarreComparaison, type ModeComparaison } from '../components/BarreComparaison';
import { Bloc, BlocsBord, TuilesBord, type Maxima } from '../components/BlocsBord';
import { Erreur, Info, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { SelecteurPeriode } from '../components/SelecteurPeriode';
import { Synthese } from '../components/Synthese';
import { BarresHorizontales, couleurSerie, type Serie } from '../components/Graphes';
import { jourCourt, periodes, type Periode } from '../periode';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';

const JOUR = 86_400_000;

/** La lettre, ce que la colonne montre, et sur quoi. Deux lignes, pas plus :
 *  l'en-tête se lit d'un coup d'œil ou elle ne sert à rien. */
function EnteteColonne({ lettre, titre, sous }: { lettre: 'A' | 'B'; titre: string; sous: string }) {
  return (
    <div className="border-b border-filet pb-2">
      <p className="text-[12px] font-bold uppercase tracking-wide text-faible">
        {lettre} · {titre}
      </p>
      <p className="chiffres text-sm text-doux">{sous}</p>
    </div>
  );
}

export function TableauBord({ filtre, onFiltre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const [periode, setPeriode] = useState<Periode>(() => periodes().jour);
  const [comparaison, setComparaison] = useState(false);
  const [mode, setMode] = useState<ModeComparaison>('restaurants');
  const [termeA, setTermeA] = useState('');
  const [termeB, setTermeB] = useState('');
  const { data: restos } = useRestaurants();
  const tous = useMemo(() => restos?.restaurants ?? [], [restos]);
  const choisi = restoChoisi(tous, filtre);

  const { data, error, isPending } = useQuery({
    queryKey: ['tableau_bord', periode.debut, periode.fin],
    queryFn: () => appelSiege<Bord>('tableau_bord', { debut: periode.debut, fin: periode.fin }),
    // Écran de veille : il doit se tenir à jour tout seul sans qu'on y touche.
    refetchInterval: 60_000,
  });

  /**
   * Les bornes de la période d'AVANT, de même durée. Elles viennent de la
   * réponse et ne sont jamais recalculées ici : c'est la fonction qui décide
   * de ce que « la période précédente » veut dire, et les deux doivent dire
   * la même chose.
   */
  const bornesB = data?.periode ? { debut: data.periode.debut_precedent, fin: data.periode.debut } : null;

  /**
   * La seule requête que la comparaison ajoute, et seulement en « 2 périodes » :
   * en « 2 restaurants » la réponse porte déjà les sept sites. Pas de
   * `refetchInterval` — elle porte sur du passé figé, qui ne bougera plus.
   */
  const { data: dataB, error: erreurB } = useQuery({
    queryKey: ['tableau_bord', bornesB?.debut, bornesB?.fin],
    queryFn: () => appelSiege<Bord>('tableau_bord', { debut: bornesB!.debut, fin: bornesB!.fin }),
    enabled: comparaison && mode === 'periodes' && !!bornesB,
  });

  /**
   * Une couleur par restaurant, prise sur la liste COMPLÈTE et stable des
   * restaurants — jamais sur la liste filtrée. Un filtre qui change le nombre
   * de séries ne doit pas repeindre les survivants.
   */
  const toutesSeries = useMemo<Serie[]>(
    () =>
      tous
        .filter((r): r is RestoGroupe & { restaurant_id: string } => !!r.restaurant_id)
        .map((r, i) => ({ cle: r.restaurant_id, libelle: r.nom, couleur: couleurSerie(i) })),
    [tous],
  );

  /**
   * Les séries d'UNE colonne : celles du restaurant qu'elle montre, toutes
   * pour le groupe. Donner à chaque colonne les séries du filtre global
   * laisserait son graphe jour par jour vide dès qu'elle montre un autre
   * restaurant que lui.
   */
  const seriesDe = (r: RestoGroupe | null): Serie[] => toutesSeries.filter((s) => !r || s.cle === r.restaurant_id);

  const nomResto = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of tous) if (r.restaurant_id) m.set(r.restaurant_id, r.nom);
    return m;
  }, [tous]);

  /**
   * Le contexte d'une vue.
   *
   * Un site non enrôlé n'a pas d'UUID POS. Lui laisser `null` le ferait passer
   * pour « tous les restaurants » et afficherait le groupe entier sous son
   * nom : on passe son identifiant SamerTrackly, qui ne correspond à aucune
   * ligne de vente et laisse donc la vue vide — ce qui est la vérité.
   */
  const ctxDe = (r: RestoGroupe | null, nom?: string): ContexteVue => ({
    restaurantId: r ? (r.restaurant_id ?? r.samtrackly_id) : null,
    nom: nom ?? r?.nom ?? 'Tous les restaurants',
    enrole: r ? r.enrole : true,
    noms: nomResto,
  });

  /**
   * La vue : tout ce que les blocs affichent, dérivé UNE FOIS et sans React.
   */
  const vue = useMemo(() => vueBord(data, ctxDe(choisi)), [data, choisi, nomResto]);

  const restoA = restoChoisi(tous, termeA);
  const restoB = restoChoisi(tous, termeB);
  const nomRestoCompare = restoA?.nom ?? 'Tous les restaurants';

  /** Le nombre de jours réellement couvert — écrit à l'écran, jamais deviné. */
  const nbJours = Math.round((new Date(periode.fin).getTime() - new Date(periode.debut).getTime()) / JOUR);

  /**
   * La période d'en face, écrite en dates réelles plutôt qu'en « période
   * précédente » : c'est la seule façon de voir qu'elle ne couvre pas le mois
   * entier quand la période en cours est partielle. Sur un seul jour, une
   * seule date — l'écrire deux fois ne dirait rien de plus.
   */
  const libelleB = (() => {
    if (mode !== 'periodes' || !bornesB) return periode.libelle;
    const premier = jourCourt(bornesB.debut);
    const dernier = jourCourt(new Date(new Date(bornesB.fin).getTime() - JOUR).toISOString());
    return premier === dernier ? premier : `${premier} → ${dernier}`;
  })();

  /**
   * En « 2 périodes », les deux colonnes portent le MÊME restaurant : le
   * nommer ferait écrire à la synthèse « Angré fait moins que Angré ». On
   * nomme donc chaque colonne par sa période. Sauf pour un site qui ne
   * synchronise pas : la seule phrase que la synthèse puisse alors écrire est
   * « … ne synchronise pas encore », et son sujet doit être le site, jamais
   * une période.
   */
  const nomDeColonne = (libellePeriode: string) => (restoA && !restoA.enrole ? restoA.nom : libellePeriode);

  const [vueA, vueB] = useMemo<[VueBord | null, VueBord | null]>(() => {
    if (!comparaison) return [null, null];
    if (mode === 'restaurants') return [vueBord(data, ctxDe(restoA)), vueBord(data, ctxDe(restoB))];
    // La période d'avant n'est pas encore là : montrer des zéros la ferait
    // passer pour une période sans la moindre vente.
    if (!dataB) return [null, null];
    return [vueBord(data, ctxDe(restoA, nomDeColonne(periode.libelle))), vueBord(dataB, ctxDe(restoA, nomDeColonne(libelleB)))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comparaison, mode, data, dataB, restoA, restoB, nomResto, periode.libelle, libelleB]);

  /**
   * Un site qui ne synchronise pas n'a pas « fait moins » : il ne remonte
   * rien. Confronter ses tuiles à celles d'en face écrirait « −100 % » sur
   * chaque ligne, qu'on lirait comme un effondrement. La colonne B montre
   * alors ses chiffres nus, et la synthèse dit pourquoi.
   */
  const muet = !!vueA && !!vueB && (!vueA.enrole || !vueB.enrole);

  /**
   * Les échelles partagées par les deux colonnes. Sans elles, chaque graphe
   * se met à la sienne : 980 000 monte aussi haut que 1 240 000 et l'œil
   * conclut à l'égalité.
   */
  const maxima = useMemo<Maxima | undefined>(() => {
    if (!vueA || !vueB) return undefined;
    const plus = (ns: number[]) => Math.max(...ns, 1);
    const totalJour = (v: VueBord) =>
      plus(v.pointsJour.map((p) => Object.values(p.valeurs).reduce((s, n) => s + n, 0)));
    const pic = (v: VueBord) => plus(v.heures.map((h) => h.ca));
    const haut = (l: { valeur: number }[]) => plus(l.map((x) => Math.abs(x.valeur)));

    return {
      jour: Math.max(totalJour(vueA), totalJour(vueB)),
      heures: Math.max(pic(vueA), pic(vueB)),
      plats: Math.max(haut(vueA.plats), haut(vueB.plats)),
      modes: Math.max(haut(vueA.modes), haut(vueB.modes)),
      tables: Math.max(haut(vueA.tables), haut(vueB.tables)),
      canaux: Math.max(haut(vueA.canaux), haut(vueB.canaux)),
      retours: Math.max(haut(vueA.retours), haut(vueB.retours)),
      depenses: Math.max(haut(vueA.depensesCategories), haut(vueB.depensesCategories)),
      ecarts: Math.max(haut(vueA.ecarts), haut(vueB.ecarts)),
      equipe: Math.max(haut(vueA.equipe), haut(vueB.equipe)),
    };
  }, [vueA, vueB]);

  /**
   * Le classement des 7 restaurants n'appartient à aucune vue : il les
   * COMPARE. Il reste donc ici, et ne s'affiche que sans filtre.
   */
  const classement = useMemo(() => (data?.restaurants ?? []).filter((r) => r.restaurant_id), [data?.restaurants]);

  const entetes =
    mode === 'restaurants'
      ? {
          a: { titre: restoA?.nom ?? 'Tous les restaurants', sous: periode.libelle },
          b: { titre: restoB?.nom ?? 'Tous les restaurants', sous: periode.libelle },
        }
      : {
          a: { titre: periode.libelle, sous: nomRestoCompare },
          b: { titre: libelleB, sous: nomRestoCompare },
        };

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {comparaison ? 'Comparaison' : choisi ? choisi.nom : 'Tableau de bord'}
          </h1>
          <p className="text-doux">
            {comparaison
              ? mode === 'restaurants'
                ? 'Deux restaurants, une même période'
                : 'Un restaurant, deux périodes de même durée'
              : choisi
                ? 'Un restaurant'
                : 'Les 7 restaurants en un seul endroit'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* Masqué en comparaison au profit des sélecteurs A et B — mais JAMAIS
              modifié : il est commun à tous les onglets et reprend sa valeur
              telle quelle à la sortie. */}
          {!comparaison && <FiltreRestaurant restaurants={tous} valeur={filtre} onChoisir={onFiltre} />}
          <button
            type="button"
            onClick={() => {
              if (!comparaison) {
                const premier = filtre || tous[0]?.samtrackly_id || '';
                setTermeA(premier);
                setTermeB(tous.find((r) => r.samtrackly_id !== premier)?.samtrackly_id ?? '');
                // Moins de deux restaurants : « 2 restaurants » est impossible,
                // on entre directement par les périodes plutôt que d'ouvrir sur
                // un mode désactivé.
                if (tous.length < 2) setMode('periodes');
              }
              setComparaison((c) => !c);
            }}
            className="min-h-[40px] rounded-btn border border-filet bg-carte px-4 text-sm font-semibold text-doux transition hover:border-marque hover:text-txt"
          >
            {comparaison ? 'Comparer ✕' : 'Comparer'}
          </button>
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
      ) : comparaison ? (
        <div className="space-y-4">
          <BarreComparaison
            mode={mode}
            onMode={setMode}
            restaurants={tous}
            a={termeA}
            b={termeB}
            onA={setTermeA}
            onB={setTermeB}
            libellePeriodeA={periode.libelle}
            libellePeriodeB={libelleB}
            nbJours={nbJours}
          />

          {erreurB && mode === 'periodes' ? (
            <Erreur
              texte={
                erreurB instanceof ErreurSiege ? erreurB.message : 'Lecture de la période précédente impossible'
              }
            />
          ) : vueA && vueB ? (
            <>
              <Synthese a={vueA} b={vueB} />
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <div className="space-y-4">
                  <EnteteColonne lettre="A" titre={entetes.a.titre} sous={entetes.a.sous} />
                  {/* Aucune flèche sur A : sa variation contre son propre passé
                      serait une troisième information en collision avec l'écart
                      entre les deux colonnes. */}
                  <TuilesBord vue={vueA} sansVariation />
                  <BlocsBord vue={vueA} series={seriesDe(restoA)} maxima={maxima} />
                </div>
                <div className="space-y-4">
                  <EnteteColonne lettre="B" titre={entetes.b.titre} sous={entetes.b.sous} />
                  <TuilesBord
                    vue={vueB}
                    reference={muet ? undefined : vueA}
                    ecartAbsolu={!muet}
                    sansVariation={muet}
                  />
                  <BlocsBord
                    vue={vueB}
                    series={seriesDe(mode === 'restaurants' ? restoB : restoA)}
                    maxima={maxima}
                  />
                </div>
              </div>
            </>
          ) : (
            <Squelette lignes={4} />
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* ---------- Couche 1 : lisible de loin ---------- */}
          <TuilesBord vue={vue} />

          <BlocsBord
            vue={vue}
            series={seriesDe(choisi)}
            repartition={
              !choisi && (
                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
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
                            ? couleurSerie(tous.filter((r) => r.restaurant_id).findIndex((r) => r.restaurant_id === l.restaurant_id))
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
