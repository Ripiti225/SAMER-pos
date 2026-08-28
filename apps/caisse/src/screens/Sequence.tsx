import { Fragment, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowLeft } from '@tabler/icons-react';
import type { RapportSequence, RecapSequence, SequenceCourante, ShiftSequence } from '@pos/shared';
import { formatFCFA, libellePartenaire, LIBELLES_MODES, type ModePaiement } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { useCaisse } from '../stores/session';

/**
 * Shifts pré-cochés : ceux de la PREMIÈRE journée présente dans la séquence,
 * et clôturés. C'est la logique SamerTrackly (une séquence = une journée, un
 * point appartient au jour où il a COMMENCÉ) ramenée à une simple proposition :
 * si le gérant rase tard et que la journée suivante a déjà tourné, ces
 * shifts-là ne partent pas avec la veille. Le gérant reste libre de cocher
 * autrement — le créneau d'une journée n'est jamais figé.
 */
function preSelection(shifts: ShiftSequence[]): Set<string> {
  const clotures = shifts.filter((s) => s.statut === 'CLOTURE');
  if (clotures.length === 0) return new Set();
  const premiereJournee = clotures.reduce((min, s) => (s.journee < min ? s.journee : min), clotures[0]!.journee);
  return new Set(clotures.filter((s) => s.journee === premiereJournee).map((s) => s.service_id));
}

/**
 * Aperçu vide, le temps que le serveur réponde. AUCUN montant n'est additionné
 * dans cet écran : les totaux de la sélection sont calculés par le serveur
 * (`/api/sequences/apercu`), comme le rapport figé au rasage — même règle que
 * l'addition d'une commande (§ CLAUDE.md).
 */
const RECAP_VIDE: RecapSequence = {
  vente_totale: 0,
  total_systeme: 0,
  diff: 0,
  especes_comptees: 0,
  depenses: 0,
  ecart_especes: 0,
  livraisons: {},
  offerts: { nb: 0, total: 0 },
  monnaie_rendue: 0,
  nb_rendus: 0,
  modes: {},
};

function libelleJournee(journee: string): string {
  const [a, m, j] = journee.split('-');
  return `${j}/${m}/${a}`;
}

/**
 * Fermeture de séquence (journée) — réservé aux porteurs de la permission
 * `caisse.fermer_sequence` (le gérant par défaut). Détail par caissier de tous
 * les shifts depuis la dernière fermeture, puis « rasage » définitif.
 *
 * Le gérant COCHE les shifts qui composent la journée : un shift encore ouvert
 * n'empêche plus de raser, et un shift qui appartient déjà au lendemain se
 * décoche. Tout ce qui n'est pas coché repart dans la séquence suivante.
 */
export function Sequence() {
  const { rentrer, afficherToast } = useCaisse();
  const qc = useQueryClient();
  const [confirmer, setConfirmer] = useState(false);
  const [rapport, setRapport] = useState<RapportSequence | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [choisis, setChoisis] = useState<Set<string> | null>(null);

  const { data: seq, isLoading } = useQuery({
    queryKey: ['sequence-courante'],
    queryFn: () => api<SequenceCourante | null>('/api/sequences/courante'),
    enabled: !rapport,
  });

  // Proposition initiale, refaite si la séquence change (un shift qui se ferme
  // pendant que le gérant regarde l'écran doit apparaître coché).
  const signature = seq ? `${seq.id}|${seq.shifts.map((s) => `${s.service_id}:${s.statut}`).join(',')}` : '';
  useEffect(() => {
    setChoisis(seq ? preSelection(seq.shifts) : null);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const selection = choisis ?? new Set<string>();
  /** Rase exactement cette journée : ses shifts clôturés, et rien d'autre. */
  const choisirJournee = (journee: string) => {
    setChoisis(
      new Set(
        (seq?.shifts ?? [])
          .filter((s) => s.journee === journee && s.statut === 'CLOTURE')
          .map((s) => s.service_id),
      ),
    );
  };
  const basculer = (serviceId: string) => {
    setChoisis((prec) => {
      const copie = new Set(prec ?? []);
      if (copie.has(serviceId)) copie.delete(serviceId);
      else copie.add(serviceId);
      return copie;
    });
  };

  const shiftsRetenus = (seq?.shifts ?? []).filter((s) => selection.has(s.service_id));
  const shiftsReportes = (seq?.shifts ?? []).filter((s) => !selection.has(s.service_id));
  const journeesRetenues = [...new Set(shiftsRetenus.map((s) => s.journee))];

  // Les totaux affichés suivent les cases cochées — c'est le chiffre du rasage,
  // pas celui de la séquence entière. Ils sont demandés AU SERVEUR à chaque
  // changement de coche : la caisse n'additionne aucun montant.
  const cleSelection = [...selection].sort().join(',');
  const { data: apercu } = useQuery({
    queryKey: ['sequence-apercu', seq?.id ?? '', cleSelection],
    queryFn: () =>
      api<RecapSequence>('/api/sequences/apercu', { method: 'POST', corps: { service_ids: [...selection] } }),
    enabled: !!seq && choisis !== null,
    // Garde le chiffre précédent pendant l'aller-retour : le gérant ne voit pas
    // le total retomber à 0 F entre deux clics.
    placeholderData: (precedent) => precedent,
  });
  const totauxRetenus = apercu ?? RECAP_VIDE;

  const raser = async () => {
    setEnCours(true);
    try {
      const r = await api<RapportSequence>('/api/sequences/cloturer', {
        method: 'POST',
        corps: { service_ids: [...selection] },
      });
      setRapport(r);
      setConfirmer(false);
      void qc.invalidateQueries({ queryKey: ['sequence-courante'] });
      void qc.invalidateQueries({ queryKey: ['sequence-apercu'] });
    } catch (e) {
      afficherToast((e as Error).message);
      setConfirmer(false);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-fond p-4 sm:p-6">
      <header className="mb-4 flex items-center gap-3">
        <button type="button" className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-douce text-doux hover:bg-marque-tint hover:text-marque-fonce" onClick={rentrer}>
          <IconArrowLeft size={20} />
        </button>
        <h1 className="text-xl font-bold">Fermeture de séquence</h1>
      </header>

      {rapport ? (
        <RapportSequenceVue rapport={rapport} onQuitter={rentrer} />
      ) : isLoading ? (
        <div className="text-doux">Chargement…</div>
      ) : !seq ? (
        <div className="carte p-8 text-center text-doux">
          Aucune séquence en cours. Elle démarrera à l’ouverture du prochain shift.
        </div>
      ) : (
        <div className="mx-auto w-full max-w-4xl space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-doux">
            <span>Séquence ouverte le {new Date(seq.ouverte_le).toLocaleString('fr-FR')}</span>
            <span>{seq.shifts.length} shift(s){seq.nb_shifts_ouverts > 0 ? ` · ${seq.nb_shifts_ouverts} encore ouvert(s)` : ''}</span>
          </div>

          {/* Total des shifts COCHÉS — c'est le chiffre du rasage */}
          <div className="carte grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
            <Tuile libelle="Vente totale" valeur={formatFCFA(totauxRetenus.vente_totale)} accent />
            <Tuile libelle="Total système" valeur={formatFCFA(totauxRetenus.total_systeme)} />
            <Tuile libelle="Écart réconc." valeur={`${totauxRetenus.diff > 0 ? '+' : ''}${formatFCFA(totauxRetenus.diff)}`} rouge={totauxRetenus.diff < 0} />
            <Tuile libelle="Écart espèces" valeur={`${totauxRetenus.ecart_especes > 0 ? '+' : ''}${formatFCFA(totauxRetenus.ecart_especes)}`} rouge={totauxRetenus.ecart_especes < 0} />
          </div>

          {/* Détail par caissier, groupé par journée de travail. Le gérant coche
              les shifts qui composent la journée qu'il rase. */}
          <div className="carte overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="text-doux">
                <tr className="border-b border-bordure">
                  <th className="p-3">Raser</th>
                  <th className="p-3">Caissier</th><th className="p-3">Statut</th>
                  <th className="p-3 text-right">Vente</th><th className="p-3 text-right">Espèces</th>
                  <th className="p-3 text-right">Écart</th>
                </tr>
              </thead>
              <tbody>
                {[...new Set(seq.shifts.map((s) => s.journee))].map((journee) => (
                  <Fragment key={journee}>
                    <tr className="bg-surface-douce">
                      <td className="px-3 py-2" colSpan={6}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-doux">Journée du {libelleJournee(journee)}</span>
                          {/* Le cas courant : la journée est complète, on la rase
                              d'un geste. Les cases ne servent qu'aux exceptions. */}
                          <button
                            type="button"
                            className="rounded-btn bg-marque-tint px-3 py-1 text-xs font-semibold text-marque-fonce"
                            onClick={() => choisirJournee(journee)}
                          >
                            Raser la journée du {libelleJournee(journee)}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {seq.shifts.filter((s) => s.journee === journee).map((s) => (
                      <tr key={s.service_id} className="border-b border-bordure last:border-0">
                        <td className="p-3">
                          <input
                            type="checkbox"
                            className="h-6 w-6 accent-marque"
                            checked={selection.has(s.service_id)}
                            // Un shift ouvert n'a ni comptage aveugle ni rapport Z :
                            // il ne peut pas être rasé, seulement reporté.
                            disabled={s.statut !== 'CLOTURE'}
                            onChange={() => basculer(s.service_id)}
                            aria-label={`Raser le shift de ${s.caissier}`}
                          />
                        </td>
                        <td className="p-3 font-semibold">{s.caissier}</td>
                        <td className="p-3">
                          {s.statut === 'CLOTURE'
                            ? <span className="text-ok">Clôturé</span>
                            : <span className="text-alerte">Ouvert — reporté</span>}
                        </td>
                        <td className="p-3 text-right tabular-nums">{s.vente_totale != null ? formatFCFA(s.vente_totale) : '—'}</td>
                        <td className="p-3 text-right tabular-nums">{s.especes_comptees != null ? formatFCFA(s.especes_comptees) : '—'}</td>
                        <td className={`p-3 text-right tabular-nums ${(s.ecart ?? 0) < 0 ? 'text-alerte' : ''}`}>{s.ecart != null ? formatFCFA(s.ecart) : '—'}</td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Répartition */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Bloc titre="Encaissements" lignes={Object.entries(totauxRetenus.modes).filter(([, v]) => v > 0).map(([m, v]) => [LIBELLES_MODES[m as ModePaiement] ?? m, v])} />
            <Bloc titre="Livraisons, Kdo & dépenses" lignes={[
              ...Object.entries(totauxRetenus.livraisons).filter(([, v]) => v > 0).map(([p, v]) => [libellePartenaire(p), v] as [string, number]),
              ...(totauxRetenus.offerts.total > 0
                ? [[`Kdo offerts (${totauxRetenus.offerts.nb})`, totauxRetenus.offerts.total] as [string, number]]
                : []),
              ['Dépenses', totauxRetenus.depenses] as [string, number],
              ...(totauxRetenus.monnaie_rendue > 0
                ? [[
                    `Monnaie rendue (${totauxRetenus.nb_rendus})`,
                    totauxRetenus.monnaie_rendue,
                  ] as [string, number]]
                : []),
            ]} />
          </div>

          {shiftsReportes.length > 0 && (
            <div className="rounded-xl bg-alerte-tint p-4 text-sm text-alerte">
              {shiftsReportes.length} shift(s) non coché(s) — {shiftsReportes.map((s) => s.caissier).join(', ')} — ne sont
              pas rasés : ils repartent dans la séquence suivante.
            </div>
          )}

          <button
            type="button"
            className="btn-alerte w-full py-4 text-lg"
            disabled={shiftsRetenus.length === 0}
            onClick={() => setConfirmer(true)}
          >
            {shiftsRetenus.length === 0
              ? 'Cochez au moins un shift clôturé'
              : `Raser la séquence (${shiftsRetenus.length} shift${shiftsRetenus.length > 1 ? 's' : ''})`}
          </button>
        </div>
      )}

      {confirmer && (
        <Modale titre="Raser la séquence ?" onFermer={() => setConfirmer(false)} enfants={
          <div className="grid gap-3">
            <p className="text-doux">
              Action définitive : {shiftsRetenus.length} shift(s) sont figés dans cette séquence
              {journeesRetenues.length === 1 ? ` (journée du ${libelleJournee(journeesRetenues[0]!)})` : ''}.
            </p>
            {shiftsReportes.length > 0 && (
              <p className="text-alerte">
                {shiftsReportes.map((s) => s.caissier).join(', ')} : non rasé(s), reporté(s) sur la séquence suivante,
                qui démarre tout de suite.
              </p>
            )}
            <div className="rounded-xl bg-marque-tint p-3 text-center">
              <div className="text-sm text-marque-fonce">Vente totale rasée</div>
              <div className="text-3xl font-black text-marque-fonce">{formatFCFA(totauxRetenus.vente_totale)}</div>
            </div>
            <button type="button" className="btn-alerte py-4 text-lg" disabled={enCours} onClick={raser}>
              {enCours ? 'Fermeture…' : 'Confirmer — raser la séquence'}
            </button>
            <button type="button" className="btn-blanc py-4 text-lg" disabled={enCours} onClick={() => setConfirmer(false)}>Annuler</button>
          </div>
        } />
      )}
    </div>
  );
}

function RapportSequenceVue({ rapport, onQuitter }: { rapport: RapportSequence; onQuitter: () => void }) {
  const { afficherToast } = useCaisse();
  const [reimpression, setReimpression] = useState(false);

  // Le récap papier part à l'imprimante dès le rasage ; ce bouton couvre le
  // papier perdu, le bourrage ou l'imprimante hors ligne au mauvais moment.
  const reimprimer = async () => {
    setReimpression(true);
    try {
      await api(`/api/sequences/${rapport.sequence_id}/reimprimer`, { method: 'POST' });
      afficherToast('Récap renvoyé à l’imprimante');
    } catch (e) {
      afficherToast((e as Error).message);
    } finally {
      setReimpression(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-lg space-y-3">
      <div className="carte space-y-3 p-6">
        <h2 className="text-center text-2xl font-bold">Séquence clôturée</h2>
        <div className="text-center text-sm text-doux">
          Par {rapport.cloturee_par} · {new Date(rapport.cloturee_le).toLocaleString('fr-FR')} · {rapport.nb_shifts} shift(s)
          {rapport.shifts_reportes > 0 ? ` · ${rapport.shifts_reportes} reporté(s)` : ''}
        </div>
        <div className="rounded-xl bg-marque-tint p-4 text-center">
          <div className="text-sm text-marque-fonce">Vente totale de la séquence</div>
          <div className="text-4xl font-black text-marque-fonce">{formatFCFA(rapport.vente_totale)}</div>
        </div>
        <div className="space-y-1 text-sm">
          <L libelle="Total système" valeur={formatFCFA(rapport.total_systeme)} />
          <div className={`flex justify-between font-bold ${rapport.diff < 0 ? 'text-alerte' : 'text-ok'}`}>
            <span>Écart réconciliation</span>
            <span className="tabular-nums">{rapport.diff > 0 ? '+' : ''}{formatFCFA(rapport.diff)}</span>
          </div>
          <L libelle="Espèces comptées" valeur={formatFCFA(rapport.especes_comptees)} />
          <L libelle="Écart espèces cumulé" valeur={`${rapport.ecart_especes > 0 ? '+' : ''}${formatFCFA(rapport.ecart_especes)}`} />
          <L libelle="Dépenses" valeur={formatFCFA(rapport.depenses)} />
          {/* Ni une vente ni une dépense : le billet entre dans le tiroir quand
              la monnaie en sort. C'est le fond de monnaie à prévoir demain. */}
          <L libelle="Monnaie rendue" valeur={formatFCFA(rapport.monnaie_rendue ?? 0)} />
        </div>
        <p className="text-center text-sm text-doux">
          Le récap détaillé (chaque shift + totaux du jour) a été envoyé à l’imprimante de la caisse.
        </p>
        <button type="button" className="btn-blanc w-full py-3" disabled={reimpression} onClick={reimprimer}>
          {reimpression ? 'Envoi…' : 'Réimprimer le récap'}
        </button>
        <button type="button" className="btn-accent w-full py-4 text-lg" onClick={onQuitter}>Terminé</button>
      </div>
    </div>
  );
}

function Tuile({ libelle, valeur, accent, rouge }: { libelle: string; valeur: string; accent?: boolean; rouge?: boolean }) {
  return (
    <div className="text-center">
      <div className="text-xs text-doux">{libelle}</div>
      <div className={`text-lg font-black tabular-nums ${rouge ? 'text-alerte' : accent ? 'text-marque-fonce' : 'text-fort'}`}>{valeur}</div>
    </div>
  );
}

function Bloc({ titre, lignes }: { titre: string; lignes: [string, number][] }) {
  return (
    <div className="carte p-4">
      <div className="mb-2 text-sm font-semibold text-doux">{titre}</div>
      {lignes.length === 0 ? (
        <div className="text-sm text-doux">—</div>
      ) : (
        <div className="space-y-1 text-sm">
          {lignes.map(([lib, v]) => <L key={lib} libelle={lib} valeur={formatFCFA(v)} />)}
        </div>
      )}
    </div>
  );
}

function L({ libelle, valeur }: { libelle: string; valeur: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-doux">{libelle}</span>
      <span className="font-semibold tabular-nums">{valeur}</span>
    </div>
  );
}
