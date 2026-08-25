import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatFCFA, LIBELLES_DISPONIBILITE, LIBELLES_MODES, LIBELLES_TYPES_COMMANDE, libellePartenaire, type Disponibilite, type ModePaiement, type TypeCommande } from '@pos/shared';
import { appelSiege, ErreurSiege, type Bord, type RestoGroupe } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { SelecteurPeriode } from '../components/SelecteurPeriode';
import { TuileChiffre } from '../components/Chiffre';
import { BarresEcarts, BarresEmpilees, BarresHeures, BarresHorizontales, couleurSerie, type Serie } from '../components/Graphes';
import { jourCourt, periodes, type Periode } from '../periode';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';

/** Couleur d'opérateur, déjà définie par le thème — jamais réinventée ici. */
const COULEUR_MODE: Record<string, string> = {
  ESPECES: 'var(--pay-especes)',
  WAVE: 'var(--pay-wave)',
  ORANGE_MONEY: 'var(--pay-orange)',
  MTN_MOMO: 'var(--pay-mtn)',
  MOOV_MONEY: 'var(--pay-moov)',
  CARTE: 'var(--pay-carte)',
  DJAMO: 'var(--pay-djamo)',
};

const nb = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Encart de section : un titre, un sous-titre facultatif, du contenu. */
function Bloc({ titre, note, children, large }: { titre: string; note?: string; children: React.ReactNode; large?: boolean }) {
  return (
    <section className={`rounded-jeton border border-filet bg-carte p-4 shadow-e1 ${large ? 'xl:col-span-2' : ''}`}>
      <h2 className="text-[12px] font-bold uppercase tracking-wide text-faible">{titre}</h2>
      {note && <p className="mb-2 mt-0.5 text-xs text-faible">{note}</p>}
      <div className={note ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}

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

  /** Filtre commun : toutes les lignes portent `restaurant_id`. */
  const mien = useMemo(
    () =>
      <T extends { restaurant_id: string }>(lignes: T[] | undefined): T[] =>
        (lignes ?? []).filter((l) => !choisi || l.restaurant_id === choisi.restaurant_id),
    [choisi],
  );

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

  const lignes = useMemo(
    () => mien(data?.restaurants.filter((r) => r.restaurant_id) as { restaurant_id: string }[] | undefined) as Bord['restaurants'],
    [data?.restaurants, mien],
  );

  // --- Couche 1 : les chiffres d'appel ------------------------------------
  const total = lignes.reduce((s, l) => s + nb(l.ca), 0);
  const totalPrec = lignes.reduce((s, l) => s + nb(l.ca_precedent), 0);
  const commandes = lignes.reduce((s, l) => s + nb(l.nb_commandes), 0);
  const commandesPrec = lignes.reduce((s, l) => s + nb(l.nb_commandes_precedent), 0);
  const panier = commandes > 0 ? Math.round(total / commandes) : 0;
  const depenses = mien(data?.depenses).reduce((s, d) => s + nb(d.montant), 0);
  const retours = mien(data?.retours);
  const retoursMontant = retours.reduce((s, r) => s + nb(r.montant), 0);
  const retoursNb = retours.reduce((s, r) => s + nb(r.quantite), 0);
  const ecartCumule = mien(data?.ecarts).reduce((s, e) => s + nb(e.ecart), 0);

  // --- Couche 2 : les deux graphes ----------------------------------------
  const pointsJour = useMemo(() => {
    const parJour = new Map<string, Record<string, number>>();
    for (const t of mien(data?.tendance)) {
      const j = String(t.jour);
      if (!parJour.has(j)) parJour.set(j, {});
      const seau = parJour.get(j)!;
      seau[t.restaurant_id] = (seau[t.restaurant_id] ?? 0) + nb(t.ca);
    }
    return [...parJour.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([jour, valeurs]) => ({ cle: jour, libelle: jourCourt(jour), valeurs }));
  }, [data?.tendance, mien]);

  const heures = useMemo(() => {
    const parHeure = new Map<number, { heure: number; ca: number; nb: number }>();
    for (const h of mien(data?.heures)) {
      const k = nb(h.heure);
      const vu = parHeure.get(k) ?? { heure: k, ca: 0, nb: 0 };
      parHeure.set(k, { heure: k, ca: vu.ca + nb(h.ca), nb: vu.nb + nb(h.nb) });
    }
    return [...parHeure.values()].sort((a, b) => a.heure - b.heure);
  }, [data?.heures, mien]);

  /** Cumule des lignes par clé texte, puis trie et coupe. */
  const cumul = <T,>(
    source: T[],
    cle: (l: T) => string,
    valeur: (l: T) => number,
    detail?: (l: T, cumule: number) => string,
    limite = 10,
  ) => {
    const m = new Map<string, number>();
    for (const l of source) {
      const k = cle(l);
      if (!k) continue;
      m.set(k, (m.get(k) ?? 0) + valeur(l));
    }
    const secondaire = new Map<string, number>();
    if (detail) for (const l of source) secondaire.set(cle(l), (secondaire.get(cle(l)) ?? 0) + 1);
    return [...m.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, limite)
      .map(([k, v]) => ({ cle: k, libelle: k, valeur: v }));
  };

  const plats = useMemo(() => {
    const m = new Map<string, { q: number; t: number }>();
    for (const p of mien(data?.plats)) {
      const vu = m.get(p.nom) ?? { q: 0, t: 0 };
      m.set(p.nom, { q: vu.q + nb(p.quantite), t: vu.t + nb(p.total) });
    }
    return [...m.entries()]
      .sort(([, a], [, b]) => b.q - a.q)
      .slice(0, 10)
      .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.t, detail: `× ${v.q}` }));
  }, [data?.plats, mien]);

  const modes = useMemo(
    () =>
      cumul(mien(data?.modes), (m) => m.mode, (m) => nb(m.montant), undefined, 8).map((l) => ({
        ...l,
        libelle: LIBELLES_MODES[l.cle as ModePaiement] ?? l.cle,
        couleur: COULEUR_MODE[l.cle] ?? 'var(--pay-carte)',
      })),
    [data?.modes, mien],
  );

  const tables = useMemo(() => {
    const m = new Map<string, { nb: number; total: number }>();
    for (const t of mien(data?.tables)) {
      const nom = t.numero ? `${t.numero}${t.zone ? ` — ${t.zone}` : ''}` : 'Table inconnue';
      const vu = m.get(nom) ?? { nb: 0, total: 0 };
      m.set(nom, { nb: vu.nb + nb(t.nb), total: vu.total + nb(t.total) });
    }
    return [...m.entries()]
      .sort(([, a], [, b]) => b.nb - a.nb)
      .slice(0, 10)
      .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.total, detail: `${v.nb} commande(s)` }));
  }, [data?.tables, mien]);

  const canaux = useMemo(() => {
    const m = new Map<string, { nb: number; total: number }>();
    for (const t of mien(data?.types)) {
      const nom = t.partenaire
        ? libellePartenaire(t.partenaire)
        : (LIBELLES_TYPES_COMMANDE[t.type as TypeCommande] ?? t.type);
      const vu = m.get(nom) ?? { nb: 0, total: 0 };
      m.set(nom, { nb: vu.nb + nb(t.nb), total: vu.total + nb(t.total) });
    }
    return [...m.entries()]
      .sort(([, a], [, b]) => b.total - a.total)
      .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.total, detail: `${v.nb} commande(s)` }));
  }, [data?.types, mien]);

  const equipe = useMemo(
    () =>
      mien(data?.equipe)
        .map((e) => ({ ...e, heures: nb(e.minutes) / 60 }))
        .sort((a, b) => b.heures - a.heures),
    [data?.equipe, mien],
  );
  const heuresTotal = equipe.reduce((s, e) => s + e.heures, 0);
  const salaires = equipe.reduce((s, e) => s + nb(e.salaire), 0);

  /** Absents : état COURANT, pas un historique. Dit tel quel à l'écran. */
  const absents = useMemo(
    () => (data?.absents ?? []).filter((a) => !choisi || a.restaurant_id === choisi.restaurant_id),
    [data?.absents, choisi],
  );

  const nomResto = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of restos?.restaurants ?? []) if (r.restaurant_id) m.set(r.restaurant_id, r.nom);
    return m;
  }, [restos]);

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
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            <TuileChiffre libelle="Chiffre d’affaires" valeur={total} precedent={totalPrec} format={formatFCFA} ton="marque" />
            <TuileChiffre libelle="Commandes payées" valeur={commandes} precedent={commandesPrec} format={(n) => n.toLocaleString('fr-FR')} />
            <TuileChiffre libelle="Panier moyen" valeur={panier} format={formatFCFA} />
            <TuileChiffre libelle="Dépenses de caisse" valeur={depenses} format={formatFCFA} ton="alerte" detail="sorties du tiroir" />
            <TuileChiffre libelle="Retours" valeur={retoursMontant} format={formatFCFA} ton="alerte" detail={`${retoursNb} article(s) refait(s)`} />
            <TuileChiffre libelle="Écart de caisse" valeur={ecartCumule} format={formatFCFA} ton="alerte" detail="cumulé sur la période" />
          </div>

          {/* ---------- Couche 2 : les deux graphes qui parlent ---------- */}
          <Bloc titre="Chiffre d’affaires, jour par jour" note={series.length > 1 ? 'Une couleur par restaurant ; survolez une journée pour le détail.' : undefined}>
            <BarresEmpilees points={pointsJour} series={series} />
          </Bloc>

          <Bloc titre="Heures de pic" note="Quand renforcer l’équipe — l’heure de pointe est en aplat plein.">
            <BarresHeures heures={heures} />
          </Bloc>

          {/* ---------- Couche 3 : comparer les restaurants ---------- */}
          {!choisi && (
            <div className="grid gap-4 xl:grid-cols-2">
              <Bloc titre="Chiffre d’affaires par restaurant">
                <BarresHorizontales
                  lignes={[...lignes]
                    .sort((a, b) => nb(b.ca) - nb(a.ca))
                    .map((l, i) => ({
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
                  lignes={[...lignes]
                    .sort((a, b) => nb(b.panier_moyen) - nb(a.panier_moyen))
                    .map((l) => ({ cle: l.samtrackly_id, libelle: l.nom, valeur: nb(l.panier_moyen) }))}
                />
              </Bloc>
            </div>
          )}

          {/* ---------- Couche 4 : ce que seul le POS possède ---------- */}
          <div className="grid gap-4 xl:grid-cols-2">
            <Bloc titre="Top des plats" note="Libellé figé au moment de la vente — aucun catalogue n’est nécessaire.">
              <BarresHorizontales lignes={plats} vide="Aucun plat vendu sur cette période." />
            </Bloc>

            <Bloc titre="Modes de paiement" note="Chaque opérateur porte sa couleur, celle de la caisse.">
              <BarresHorizontales lignes={modes} vide="Aucun encaissement sur cette période." />
            </Bloc>

            <Bloc titre="Tables les plus utilisées">
              <BarresHorizontales lignes={tables} vide="Aucune commande sur table." />
            </Bloc>

            <Bloc titre="Canaux de vente" note="Sur place, à emporter, et le détail par partenaire de livraison.">
              <BarresHorizontales lignes={canaux} vide="Aucune commande sur cette période." />
            </Bloc>

            <Bloc titre="Retours" note="Plats lancés en cuisine puis annulés — hors vente et hors tiroir. C’est le chiffre qui dit si un restaurant refait souvent ses plats.">
              <BarresHorizontales
                lignes={[...retours]
                  .sort((a, b) => nb(b.quantite) - nb(a.quantite))
                  .slice(0, 8)
                  .map((r) => ({ cle: r.nom, libelle: r.nom, valeur: nb(r.montant), detail: `× ${nb(r.quantite)}` }))}
                couleur="var(--attente)"
                vide="Aucun retour — rien n’a été refait."
              />
            </Bloc>

            <Bloc titre="Écarts de caisse par caissier" note="Comptage à l’aveugle : le caissier n’a jamais vu le théorique.">
              <BarresEcarts
                lignes={mien(data?.ecarts)
                  .sort((a, b) => Math.abs(nb(b.ecart)) - Math.abs(nb(a.ecart)))
                  .slice(0, 10)
                  .map((e) => ({
                    cle: `${e.restaurant_id}:${e.caissier}`,
                    libelle: e.caissier,
                    valeur: nb(e.ecart),
                    detail: `${nb(e.nb_services)} service(s)${choisi ? '' : ` · ${nomResto.get(e.restaurant_id) ?? ''}`}`,
                  }))}
              />
            </Bloc>

            <Bloc titre="Dépenses par catégorie" note="Sorties de caisse uniquement — ni loyer, ni facture payée hors caisse. Jamais soustraites du chiffre d’affaires.">
              <BarresHorizontales
                lignes={cumul(mien(data?.depenses), (d) => d.categorie, (d) => nb(d.montant))}
                couleur="var(--alerte)"
                vide="Aucune dépense enregistrée."
              />
            </Bloc>

            <Bloc titre="Remises et annulations">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="chiffres text-2xl font-bold">{formatFCFA(mien(data?.remises).reduce((s, r) => s + nb(r.montant), 0))}</p>
                  <p className="text-xs text-doux">{mien(data?.remises).length} remise(s) accordée(s)</p>
                  <div className="mt-1.5 space-y-0.5">
                    {mien(data?.remises).slice(0, 4).map((r) => (
                      <div key={`${r.restaurant_id}-${r.numero_ticket}`} className="flex justify-between gap-2 text-xs">
                        <span className="min-w-0 truncate text-doux">
                          <span className="chiffres font-semibold">#{r.numero_ticket}</span> {r.motif ?? 'sans motif'}
                        </span>
                        <span className="chiffres flex-none">{formatFCFA(nb(r.montant))}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="chiffres text-2xl font-bold">{mien(data?.annulations).length}</p>
                  <p className="text-xs text-doux">
                    commande(s) annulée(s) ·{' '}
                    {formatFCFA(mien(data?.annulations).reduce((s, a) => s + nb(a.total), 0))}
                  </p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {mien(data?.annulations).slice(0, 8).map((a) => (
                      <span key={`${a.restaurant_id}-${a.numero_ticket}`} className="chiffres rounded-sm bg-carte-douce px-1.5 py-0.5 text-[11px] font-semibold">
                        #{a.numero_ticket}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </Bloc>

            <Bloc titre="Inventaire" note="Information manager — sans effet sur la vente ni sur l’écart de caisse.">
              {mien(data?.inventaire).length === 0 ? (
                <p className="py-4 text-center text-faible">Aucun inventaire validé sur cette période.</p>
              ) : (
                <div className="space-y-1.5">
                  {mien(data?.inventaire).map((i) => (
                    <div key={i.restaurant_id} className="flex items-baseline justify-between gap-3 border-b border-filet py-1.5 text-sm last:border-0">
                      <span className="truncate font-semibold">{nomResto.get(i.restaurant_id) ?? 'Site'}</span>
                      <span className="flex-none">
                        <span className={`chiffres font-semibold ${nb(i.montant_manquant) > 0 ? 'text-attente-txt' : 'text-ok-txt'}`}>
                          {formatFCFA(nb(i.montant_manquant))}
                        </span>
                        <span className="ml-2 text-xs text-faible">
                          {nb(i.nb_inventaires)} comptage(s)
                          {nb(i.nb_debloques) > 0 ? ` · ${nb(i.nb_debloques)} débloqué(s)` : ''}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Bloc>
          </div>

          {/* ---------- Couche 5 : l'équipe ---------- */}
          <Bloc titre="Équipe" note="Arrivée = l’heure du clic sur « Pointer ». Fin = heure de paie pour qui est payé à la journée, heure de clôture sinon.">
            <div className="mb-3 grid gap-3 sm:grid-cols-3">
              <div>
                <p className="chiffres text-2xl font-bold">{equipe.length}</p>
                <p className="text-xs text-doux">personne(s) en poste sur la période</p>
              </div>
              <div>
                <p className="chiffres text-2xl font-bold">{Math.round(heuresTotal)} h</p>
                <p className="text-xs text-doux">travaillées au total</p>
              </div>
              <div>
                <p className="chiffres text-2xl font-bold">{formatFCFA(salaires)}</p>
                <p className="text-xs text-doux">de salaires payés en caisse</p>
              </div>
            </div>

            <BarresHorizontales
              lignes={equipe.slice(0, 12).map((e) => ({
                cle: `${e.restaurant_id}:${e.utilisateur_id}`,
                libelle: e.nom,
                valeur: Math.round(e.heures * 10) / 10,
                detail: `${e.poste ?? 'poste non renseigné'} · ${nb(e.nb_services)} service(s)`,
              }))}
              format={(n) => `${n} h`}
              vide="Personne n’a pointé sur cette période."
            />

            {absents.length > 0 && (
              <div className="mt-3 border-t border-filet pt-3">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faible">
                  Absents aujourd’hui
                  <span className="ml-2 font-normal normal-case tracking-normal">
                    état du jour, pas un historique
                  </span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {absents.map((a) => (
                    <span key={a.id} className="rounded-sm bg-info-tint px-2 py-1 text-xs font-semibold text-info-txt">
                      {a.nom_complet} — {LIBELLES_DISPONIBILITE[a.disponibilite as Disponibilite] ?? a.disponibilite}
                      {!choisi && nomResto.get(a.restaurant_id) ? ` · ${nomResto.get(a.restaurant_id)}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Bloc>
        </div>
      )}
    </section>
  );
}
