import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatFCFA } from '@pos/shared';
import { appelSiege, ErreurSiege, type Siege } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { dateHeure } from '../periode';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';
import { FiltreRestaurant } from '../components/FiltreRestaurant';

interface Shift {
  service_id: string;
  caissier: string | null;
  ouvert_le: string;
  cloture_le: string | null;
  statut: string;
  ecart: number | null;
  vente_totale: number | null;
}

interface SequenceOuverte {
  restaurant_id: string;
  sequence_id: string;
  ouverte_le: string;
  shifts: Shift[];
}

interface Ordre {
  id: string;
  restaurant_id: string;
  type: string;
  params: Record<string, unknown>;
  demandeur: string;
  statut: 'EN_ATTENTE' | 'EXECUTE' | 'ECHEC' | 'EXPIRE';
  cree_le: string;
  execute_le: string | null;
  erreur: string | null;
}

const LIBELLE_STATUT: Record<Ordre['statut'], { texte: string; classe: string }> = {
  EN_ATTENTE: { texte: 'En attente', classe: 'bg-attente-tint text-attente-txt' },
  EXECUTE: { texte: 'Exécuté', classe: 'bg-ok-tint text-ok-txt' },
  ECHEC: { texte: 'Refusé', classe: 'bg-alerte-tint text-alerte-txt' },
  EXPIRE: { texte: 'Périmé', classe: 'bg-carte-douce text-doux' },
};

/** Depuis combien de temps la séquence est ouverte, en clair. */
function depuis(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `${Math.round(h)} h`;
  return `${Math.floor(h / 24)} j`;
}

/**
 * Onglet Séquences — voir où en est la journée de chaque restaurant, et raser
 * à distance celle qu'on a oubliée.
 *
 * **Un ordre, pas une exécution.** Le siège ne peut pas joindre un mini-PC
 * derrière la box d'un restaurant : la demande est posée dans une file, le site
 * vient la chercher à son prochain cycle (30 s), l'exécute et rend compte. Le
 * statut de l'ordre est donc une information à part entière — l'écran le suit.
 *
 * **Ce qu'on rase est montré avant.** Raser fige la journée d'un restaurant :
 * l'écran liste les shifts de la séquence, leur caissier, leur vente et leur
 * écart. Les shifts encore OUVERTS sont affichés mais ne seront pas rasés — ils
 * repartent dans la séquence suivante, exactement comme sur la caisse.
 */
export function Sequences({ filtre, onFiltre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const qc = useQueryClient();
  const { data: restos } = useRestaurants();
  const { data: moi } = useQuery({ queryKey: ['moi'], queryFn: () => appelSiege<Siege>('moi'), staleTime: 5 * 60_000 });
  const choisi = restoChoisi(restos?.restaurants, filtre);

  const { data, isPending, error } = useQuery({
    queryKey: ['sequences_groupe'],
    queryFn: () => appelSiege<{ sequences: SequenceOuverte[]; ordres: Ordre[] }>('sequences_groupe'),
    // Un ordre en attente change d'état tout seul quand le site le traite :
    // sans rafraîchissement, l'écran resterait bloqué sur « En attente ».
    refetchInterval: 15_000,
  });

  const [confirme, setConfirme] = useState<SequenceOuverte | null>(null);
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);

  const nomResto = useMemo(() => {
    const m = new Map<string, { nom: string; marque: 'SAMER' | 'AL_KAYAN' }>();
    for (const r of restos?.restaurants ?? []) if (r.restaurant_id) m.set(r.restaurant_id, { nom: r.nom, marque: r.marque });
    return m;
  }, [restos]);

  const sequences = (data?.sequences ?? []).filter((s) => !choisi || s.restaurant_id === choisi.restaurant_id);
  const ordres = (data?.ordres ?? []).filter((o) => !choisi || o.restaurant_id === choisi.restaurant_id);

  const raser = useMutation({
    mutationFn: (seq: SequenceOuverte) =>
      appelSiege<{ ordre_id: string }>('ordre_creer', {
        restaurant_id: seq.restaurant_id,
        type: 'RASER_SEQUENCE',
        params: { sequence_id: seq.sequence_id },
      }),
    onSuccess: () => {
      setConfirme(null);
      setMsg({
        texte: 'Demande envoyée. Le restaurant l’exécutera à son prochain cycle de synchro — suivez son état dans « Ordres envoyés » ci-dessous.',
        ok: true,
      });
      void qc.invalidateQueries({ queryKey: ['sequences_groupe'] });
    },
    onError: (e: Error) => {
      setConfirme(null);
      setMsg({ texte: e instanceof ErreurSiege ? e.message : 'Demande impossible' });
    },
  });

  const lectureSeule = moi?.niveau === 'LECTURE';

  return (
    <section className="max-w-4xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Séquences</h1>
          <p className="text-doux">La journée en cours de chaque restaurant.</p>
        </div>
        <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
      </div>

      {lectureSeule && <Info>Votre compte est en <b>lecture seule</b> : vous voyez les séquences, vous n’en rasez pas.</Info>}
      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}
      {msg && (msg.ok ? <Info>{msg.texte}</Info> : <Erreur texte={msg.texte} />)}

      {isPending ? (
        <Squelette lignes={3} />
      ) : (
        <div className="space-y-4">
          {sequences.length === 0 && (
            <p className="rounded-jeton border border-filet bg-carte p-4 text-doux">
              Aucune séquence ouverte. Soit tout a été rasé, soit aucun site ne remonte encore.
            </p>
          )}

          {sequences.map((seq) => {
            const r = nomResto.get(seq.restaurant_id);
            const clotures = seq.shifts.filter((s) => s.statut === 'CLOTURE');
            const ouverts = seq.shifts.filter((s) => s.statut !== 'CLOTURE');
            const total = clotures.reduce((t, s) => t + (s.vente_totale ?? 0), 0);
            const enAttente = ordres.some((o) => o.restaurant_id === seq.restaurant_id && o.statut === 'EN_ATTENTE');
            const vieille = (Date.now() - new Date(seq.ouverte_le).getTime()) / 3_600_000 > 18;

            return (
              <article key={seq.sequence_id} className="rounded-jeton border border-filet bg-carte p-4">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="flex items-center gap-2 text-lg font-bold">
                    {r && <PastilleMarque marque={r.marque} />}
                    {r?.nom ?? 'Site inconnu'}
                  </span>
                  <span className={`text-sm ${vieille ? 'font-semibold text-attente-txt' : 'text-doux'}`}>
                    ouverte depuis {depuis(seq.ouverte_le)} · {dateHeure(seq.ouverte_le)}
                  </span>
                </div>

                {seq.shifts.length === 0 ? (
                  <p className="text-doux">Aucun shift dans cette séquence pour l’instant.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b border-filet text-[11px] uppercase tracking-wide text-faible">
                          <th className="py-1.5 pr-3 font-semibold">Caissier</th>
                          <th className="px-3 py-1.5 font-semibold">Ouvert</th>
                          <th className="px-3 py-1.5 font-semibold">Clôturé</th>
                          <th className="px-3 py-1.5 text-right font-semibold">Vente</th>
                          <th className="py-1.5 pl-3 text-right font-semibold">Écart</th>
                        </tr>
                      </thead>
                      <tbody>
                        {seq.shifts.map((s) => (
                          <tr key={s.service_id} className="border-b border-filet last:border-0">
                            <td className="py-2 pr-3 font-semibold">{s.caissier ?? '—'}</td>
                            <td className="chiffres px-3 py-2 text-doux">{dateHeure(s.ouvert_le)}</td>
                            <td className="px-3 py-2">
                              {s.cloture_le ? (
                                <span className="chiffres text-doux">{dateHeure(s.cloture_le)}</span>
                              ) : (
                                <span className="rounded-sm bg-attente-tint px-2 py-0.5 text-xs font-semibold text-attente-txt">
                                  encore ouvert
                                </span>
                              )}
                            </td>
                            <td className="chiffres px-3 py-2 text-right">
                              {s.vente_totale === null ? '—' : formatFCFA(s.vente_totale)}
                            </td>
                            <td className="chiffres py-2 pl-3 text-right text-doux">
                              {s.ecart === null ? '—' : `${s.ecart > 0 ? '+' : ''}${formatFCFA(s.ecart)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-filet pt-3">
                  <div className="text-sm text-doux">
                    <b className="chiffres text-txt">{formatFCFA(total)}</b> sur {clotures.length} shift
                    {clotures.length > 1 ? 's' : ''} clôturé{clotures.length > 1 ? 's' : ''}
                    {ouverts.length > 0 && (
                      <>
                        {' · '}
                        <span className="text-attente-txt">
                          {ouverts.length} encore ouvert{ouverts.length > 1 ? 's' : ''}, reporté
                          {ouverts.length > 1 ? 's' : ''} sur la séquence suivante
                        </span>
                      </>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn-blanc !min-h-[40px] !px-4 !text-sm"
                    disabled={lectureSeule || clotures.length === 0 || enAttente}
                    onClick={() => setConfirme(seq)}
                    title={
                      clotures.length === 0
                        ? 'Aucun shift clôturé : la séquence serait vide'
                        : enAttente
                          ? 'Un rasage est déjà en attente pour ce restaurant'
                          : undefined
                    }
                  >
                    {enAttente ? 'Rasage demandé…' : 'Raser à distance'}
                  </button>
                </div>
              </article>
            );
          })}

          {/* Le suivi des ordres : sans lui, on ne saurait pas si le site a
              obéi, refusé, ou n'est jamais venu chercher la demande. */}
          {ordres.length > 0 && (
            <div className="rounded-jeton border border-filet bg-carte p-4">
              <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">Ordres envoyés</h2>
              <div className="space-y-1.5">
                {ordres.map((o) => {
                  const st = LIBELLE_STATUT[o.statut];
                  return (
                    <div key={o.id} className="border-b border-filet py-1.5 last:border-0">
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="font-semibold">
                          {nomResto.get(o.restaurant_id)?.nom ?? 'Site inconnu'}
                          <span className="ml-2 font-normal text-doux">par {o.demandeur}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="chiffres text-xs text-faible">{dateHeure(o.cree_le)}</span>
                          <span className={`rounded-sm px-2 py-0.5 text-xs font-semibold ${st.classe}`}>{st.texte}</span>
                        </span>
                      </div>
                      {o.erreur && <p className="mt-0.5 text-xs text-alerte-txt">{o.erreur}</p>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Confirmation explicite : raser fige la journée, et le geste part vers
          un restaurant où personne ne l'a demandé. */}
      {confirme && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirme(null)}>
          <div className="w-full max-w-lg rounded-jeton border border-filet bg-carte p-5 shadow-e2" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-2 text-xl font-bold">
              Raser la séquence de {nomResto.get(confirme.restaurant_id)?.nom ?? 'ce restaurant'} ?
            </h2>
            <p className="mb-3 text-doux">
              La journée sera <b>figée</b> :{' '}
              {confirme.shifts.filter((s) => s.statut === 'CLOTURE').length} shift(s) clôturé(s) agrégé(s), récap
              imprimé sur place. Cette opération ne se défait pas.
            </p>
            {confirme.shifts.some((s) => s.statut !== 'CLOTURE') && (
              <p className="mb-3 rounded-sm bg-attente-tint px-3 py-2 text-sm text-attente-txt">
                {confirme.shifts.filter((s) => s.statut !== 'CLOTURE').length} shift(s) encore ouvert(s) ne seront
                <b> pas</b> rasés : ils repartent sur la séquence suivante, comme sur la caisse.
              </p>
            )}
            <p className="mb-4 text-sm text-faible">
              La demande part dans une file ; le restaurant l’exécutera à son prochain cycle de synchro. S’il a rasé
              entre-temps, il refusera plutôt que de raser la journée suivante.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-blanc" onClick={() => setConfirme(null)}>
                Annuler
              </button>
              <button type="button" className="btn-alerte" disabled={raser.isPending} onClick={() => raser.mutate(confirme)}>
                {raser.isPending ? 'Envoi…' : 'Envoyer la demande'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
