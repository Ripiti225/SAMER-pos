import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowLeft } from '@tabler/icons-react';
import type { RapportSequence, SequenceCourante } from '@pos/shared';
import { formatFCFA, LIBELLES_MODES, type ModePaiement } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { useCaisse } from '../stores/session';

const LIBELLES_LIVRAISON: Record<string, string> = { YANGO: 'Yango', GLOVO: 'Glovo', SAMER_DELIV: 'Samer Deliv' };

/**
 * Fermeture de séquence (journée) — réservé aux porteurs de la permission
 * `caisse.fermer_sequence` (le gérant par défaut). Détail par caissier de tous
 * les shifts depuis la dernière fermeture, puis « rasage » définitif.
 */
export function Sequence() {
  const { rentrer, afficherToast } = useCaisse();
  const qc = useQueryClient();
  const [confirmer, setConfirmer] = useState(false);
  const [rapport, setRapport] = useState<RapportSequence | null>(null);
  const [enCours, setEnCours] = useState(false);

  const { data: seq, isLoading } = useQuery({
    queryKey: ['sequence-courante'],
    queryFn: () => api<SequenceCourante | null>('/api/sequences/courante'),
    enabled: !rapport,
  });

  const raser = async () => {
    setEnCours(true);
    try {
      const r = await api<RapportSequence>('/api/sequences/cloturer', { method: 'POST' });
      setRapport(r);
      setConfirmer(false);
      void qc.invalidateQueries({ queryKey: ['sequence-courante'] });
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

          {/* Total de la séquence */}
          <div className="carte grid grid-cols-2 gap-3 p-5 sm:grid-cols-4">
            <Tuile libelle="Vente totale" valeur={formatFCFA(seq.totaux.vente_totale)} accent />
            <Tuile libelle="Total système" valeur={formatFCFA(seq.totaux.total_systeme)} />
            <Tuile libelle="Écart réconc." valeur={`${seq.totaux.diff > 0 ? '+' : ''}${formatFCFA(seq.totaux.diff)}`} rouge={seq.totaux.diff < 0} />
            <Tuile libelle="Écart espèces" valeur={`${seq.totaux.ecart_especes > 0 ? '+' : ''}${formatFCFA(seq.totaux.ecart_especes)}`} rouge={seq.totaux.ecart_especes < 0} />
          </div>

          {/* Détail par caissier */}
          <div className="carte overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="text-doux">
                <tr className="border-b border-bordure">
                  <th className="p-3">Caissier</th><th className="p-3">Statut</th>
                  <th className="p-3 text-right">Vente</th><th className="p-3 text-right">Espèces</th>
                  <th className="p-3 text-right">Écart</th>
                </tr>
              </thead>
              <tbody>
                {seq.shifts.map((s) => (
                  <tr key={s.service_id} className="border-b border-bordure last:border-0">
                    <td className="p-3 font-semibold">{s.caissier}</td>
                    <td className="p-3">
                      {s.statut === 'CLOTURE'
                        ? <span className="text-ok">Clôturé</span>
                        : <span className="text-alerte">Ouvert</span>}
                    </td>
                    <td className="p-3 text-right tabular-nums">{s.vente_totale != null ? formatFCFA(s.vente_totale) : '—'}</td>
                    <td className="p-3 text-right tabular-nums">{s.especes_comptees != null ? formatFCFA(s.especes_comptees) : '—'}</td>
                    <td className={`p-3 text-right tabular-nums ${(s.ecart ?? 0) < 0 ? 'text-alerte' : ''}`}>{s.ecart != null ? formatFCFA(s.ecart) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Répartition */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Bloc titre="Encaissements" lignes={Object.entries(seq.totaux.modes).filter(([, v]) => v > 0).map(([m, v]) => [LIBELLES_MODES[m as ModePaiement] ?? m, v])} />
            <Bloc titre="Livraisons & dépenses" lignes={[
              ...Object.entries(seq.totaux.livraisons).filter(([, v]) => v > 0).map(([p, v]) => [LIBELLES_LIVRAISON[p] ?? p, v] as [string, number]),
              ['Dépenses', seq.totaux.depenses] as [string, number],
            ]} />
          </div>

          {seq.nb_shifts_ouverts > 0 ? (
            <div className="rounded-xl bg-alerte-tint p-4 text-sm text-alerte">
              Des shifts sont encore ouverts. Attendez que chaque caissier ferme le sien avant de raser la séquence.
            </div>
          ) : (
            <button type="button" className="btn-alerte w-full py-4 text-lg" onClick={() => setConfirmer(true)}>
              Raser la séquence (fin de journée)
            </button>
          )}
        </div>
      )}

      {confirmer && (
        <Modale titre="Raser la séquence ?" onFermer={() => setConfirmer(false)} enfants={
          <div className="grid gap-3">
            <p className="text-doux">Action définitive : la séquence est figée et une nouvelle démarrera au prochain shift.</p>
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
  return (
    <div className="mx-auto w-full max-w-lg space-y-3">
      <div className="carte space-y-3 p-6">
        <h2 className="text-center text-2xl font-bold">Séquence clôturée</h2>
        <div className="text-center text-sm text-doux">
          Par {rapport.cloturee_par} · {new Date(rapport.cloturee_le).toLocaleString('fr-FR')} · {rapport.nb_shifts} shift(s)
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
        </div>
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
