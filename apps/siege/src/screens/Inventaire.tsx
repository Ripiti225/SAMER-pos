import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatFCFA } from '@pos/shared';
import {
  appelSiege,
  ErreurSiege,
  type ExplicationInventaireSiege,
  type Siege,
  type StatutExplicationInventaire,
} from '../api';
import { Erreur, Info, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { SelecteurPeriode } from '../components/SelecteurPeriode';
import { dateHeure, periodes, type Periode } from '../periode';
import { useRestaurants, type FiltreResto } from '../restaurants';

const ETATS: { cle: StatutExplicationInventaire; libelle: string }[] = [
  { cle: 'en_attente', libelle: 'En attente' },
  { cle: 'validee', libelle: 'Validées' },
  { cle: 'refusee', libelle: 'Refusées' },
];

const STYLE_ETAT: Record<StatutExplicationInventaire, string> = {
  en_attente: 'bg-attente-tint text-attente-txt',
  validee: 'bg-ok-tint text-ok-txt',
  refusee: 'bg-alerte-tint text-alerte-txt',
};

function dateFr(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function quantite(valeur: number | null): string {
  return valeur === null ? '—' : valeur.toLocaleString('fr-FR', { maximumFractionDigits: 3 });
}

export function Inventaire({
  siege,
  filtre,
  onFiltre,
}: {
  siege: Siege;
  filtre: FiltreResto;
  onFiltre: (v: FiltreResto) => void;
}) {
  const qc = useQueryClient();
  const { data: restos } = useRestaurants();
  const [periode, setPeriode] = useState<Periode>(() => periodes()['7j']);
  const [etat, setEtat] = useState<StatutExplicationInventaire>('en_attente');
  const [message, setMessage] = useState<{ texte: string; erreur?: boolean } | null>(null);

  const cleRequete = ['inventaire_explications', periode.debut, periode.fin, filtre] as const;
  const { data, error, isPending } = useQuery({
    queryKey: cleRequete,
    queryFn: () => appelSiege<{ lignes: ExplicationInventaireSiege[] }>('inventaire_explications', {
      debut: periode.debut,
      fin: periode.fin,
      restaurant_id: filtre || undefined,
    }),
  });

  const compteurs = useMemo(() => {
    const resultat: Record<StatutExplicationInventaire, number> = { en_attente: 0, validee: 0, refusee: 0 };
    for (const ligne of data?.lignes ?? []) resultat[ligne.statut]++;
    return resultat;
  }, [data?.lignes]);

  const lignes = useMemo(
    () => (data?.lignes ?? []).filter((ligne) => ligne.statut === etat),
    [data?.lignes, etat],
  );

  const decision = useMutation({
    mutationFn: ({ ligne, statut }: { ligne: ExplicationInventaireSiege; statut: 'validee' | 'refusee' }) =>
      appelSiege<{ decision: unknown }>('decider_explication_inventaire', {
        ligne_id: ligne.ligne_id,
        statut,
      }),
    onSuccess: (_resultat, variables) => {
      setMessage({ texte: variables.statut === 'validee' ? 'Explication acceptée.' : 'Explication refusée.' });
      void qc.invalidateQueries({ queryKey: ['inventaire_explications'] });
    },
    onError: (e: Error) => {
      setMessage({
        texte: e instanceof ErreurSiege ? e.message : 'La décision n’a pas pu être enregistrée',
        erreur: true,
      });
      void qc.invalidateQueries({ queryKey: ['inventaire_explications'] });
    },
  });

  const decider = (ligne: ExplicationInventaireSiege, statut: 'validee' | 'refusee') => {
    const verbe = statut === 'validee' ? 'Accepter' : 'Refuser';
    const precision = statut === 'validee'
      ? `La quantité expliquée (${quantite(ligne.quantite_expliquee)}) sera acceptée.`
      : 'La déduction pleine sera rétablie.';
    if (!window.confirm(`${verbe} l’explication pour « ${ligne.produit_nom} » ?\n\n${precision}`)) return;
    setMessage(null);
    decision.mutate({ ligne, statut });
  };

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Inventaire</h1>
          <p className="text-doux">Explications d’écart transmises au contrôle SamerTrackly.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
          <SelecteurPeriode valeur={periode} onChoisir={setPeriode} />
        </div>
      </div>

      <Info>
        Le transfert reste automatique. Une décision prise ici est la même que dans SamerTrackly : la première enregistrée est conservée.
      </Info>
      {siege.niveau === 'LECTURE' && (
        <Info>Votre compte est en <b>lecture seule</b> : vous pouvez consulter les explications, sans les traiter.</Info>
      )}
      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture de l’inventaire impossible'} />}
      {message && (message.erreur ? <Erreur texte={message.texte} /> : <Info>{message.texte}</Info>)}

      <div className="mb-4 flex flex-wrap gap-2">
        {ETATS.map((option) => (
          <button
            key={option.cle}
            type="button"
            onClick={() => setEtat(option.cle)}
            className={`min-h-[42px] rounded-btn border px-4 text-sm font-semibold transition ${
              etat === option.cle
                ? 'border-marque bg-marque text-sur-marque'
                : 'border-filet bg-carte text-doux hover:border-marque hover:text-txt'
            }`}
          >
            {option.libelle} · {compteurs[option.cle]}
          </button>
        ))}
      </div>

      {isPending ? (
        <Squelette lignes={5} />
      ) : lignes.length === 0 ? (
        <div className="rounded-jeton border border-filet bg-carte px-5 py-8 text-center text-doux">
          Aucune explication {etat === 'en_attente' ? 'en attente' : etat === 'validee' ? 'validée' : 'refusée'} sur cette période.
        </div>
      ) : (
        <div className="space-y-3">
          {lignes.map((ligne) => {
            const enCours = decision.isPending && decision.variables?.ligne.ligne_id === ligne.ligne_id;
            return (
              <article key={ligne.ligne_id} className="rounded-jeton border border-filet bg-carte p-4 shadow-e1">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-bold">{ligne.produit_nom}</div>
                    <div className="text-sm text-doux">
                      {ligne.restaurant_nom} · {dateFr(ligne.date)} · {ligne.caissier_nom} · shift {ligne.type_shift}
                    </div>
                  </div>
                  <span className={`rounded-sm px-2.5 py-1 text-xs font-bold ${STYLE_ETAT[ligne.statut]}`}>
                    {ligne.statut === 'en_attente' ? 'En attente' : ligne.statut === 'validee' ? 'Validée' : 'Refusée'}
                  </span>
                </div>

                <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                  {[
                    ['Stock théorique', quantite(ligne.stock_theorique)],
                    ['Stock compté', quantite(ligne.stock_compte)],
                    ['Écart', quantite(ligne.ecart)],
                    ['Quantité expliquée', quantite(ligne.quantite_expliquee)],
                    ['Déduction actuelle', formatFCFA(ligne.montant_deduit)],
                  ].map(([libelle, valeur]) => (
                    <div key={libelle} className="rounded-btn bg-carte-douce px-3 py-2">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-faible">{libelle}</div>
                      <div className="chiffres mt-1 font-bold">{valeur}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 rounded-btn border border-filet px-3 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-faible">Explication du restaurant</div>
                  <p className="mt-1 whitespace-pre-wrap font-medium">{ligne.explication || 'Quantité expliquée sans commentaire'}</p>
                </div>

                {ligne.statut !== 'en_attente' && (
                  <div className="mt-3 text-sm text-doux">
                    Décidée par <b>{ligne.decidee_par ?? 'Manager'}</b>
                    {ligne.decidee_le ? ` · ${dateHeure(ligne.decidee_le)}` : ''}
                    {ligne.statut === 'validee' && ligne.quantite_acceptee !== null
                      ? ` · ${quantite(ligne.quantite_acceptee)} accepté`
                      : ''}
                  </div>
                )}

                {ligne.statut === 'en_attente' && siege.niveau === 'ADMIN' && (
                  <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-filet pt-3">
                    <button
                      type="button"
                      className="btn-blanc !min-h-[42px] !px-4 !text-sm"
                      disabled={decision.isPending}
                      onClick={() => decider(ligne, 'refusee')}
                    >
                      {enCours ? 'Enregistrement…' : 'Refuser'}
                    </button>
                    <button
                      type="button"
                      className="btn-primaire !min-h-[42px] !px-4 !text-sm"
                      disabled={decision.isPending}
                      onClick={() => decider(ligne, 'validee')}
                    >
                      {enCours ? 'Enregistrement…' : 'Accepter'}
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
