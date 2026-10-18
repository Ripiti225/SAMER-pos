import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatFCFA } from '@pos/shared';
import { appelSiege, ErreurSiege, type Cloture, type RestoGroupe } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { SelecteurPeriode } from '../components/SelecteurPeriode';
import { dateHeure, periodes, type Periode } from '../periode';
import { TicketZ, type RapportZLu } from '../components/TicketZ';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';

/** Seuil d'alerte par défaut du POS (`parametres_locaux.seuil_alerte_ecart_caisse`). */
const SEUIL_ECART = 2000;

export function Clotures({ filtre, onFiltre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const [periode, setPeriode] = useState<Periode>(() => periodes()['7j']);
  const [ouverte, setOuverte] = useState<Cloture | null>(null);

  const { data: restos } = useRestaurants();
  const choisi = restoChoisi(restos?.restaurants, filtre);
  const { data, error, isPending } = useQuery({
    queryKey: ['clotures', periode.debut, periode.fin],
    queryFn: () => appelSiege<{ clotures: Cloture[] }>('clotures', { debut: periode.debut, fin: periode.fin }),
  });

  const nomResto = useMemo(() => {
    const m = new Map<string, RestoGroupe>();
    for (const r of restos?.restaurants ?? []) if (r.restaurant_id) m.set(r.restaurant_id, r);
    return m;
  }, [restos]);

  /**
   * Une clôture est identifiée par l'UUID POS du site. Un restaurant non enrôlé
   * n'en a pas : il n'a donc aucune clôture ici, et ce n'est pas une liste vide
   * à expliquer par un « aucune clôture » qui laisserait croire à un oubli.
   */
  const lignes = useMemo(
    () => (data?.clotures ?? []).filter((c) => !choisi || c.restaurant_id === choisi.restaurant_id),
    [data?.clotures, choisi],
  );

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Clôtures</h1>
        <div className="flex flex-wrap items-center gap-3">
          <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
          <SelecteurPeriode valeur={periode} onChoisir={setPeriode} />
        </div>
      </div>

      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}

      {choisi && !choisi.enrole && (
        <Info>
          <b>{choisi.nom} ne synchronise pas encore.</b> Aucune de ses clôtures n’est remontée au cloud — ce
          n’est pas qu’il n’en fait pas.
        </Info>
      )}

      {isPending ? (
        <Squelette lignes={5} />
      ) : (
        <div className="overflow-x-auto rounded-jeton border border-filet bg-carte shadow-e1">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr className="border-b border-filet text-[12px] uppercase tracking-wide text-faible">
                <th className="px-4 py-3 font-semibold">Restaurant</th>
                <th className="px-4 py-3 font-semibold">Ouvert</th>
                <th className="px-4 py-3 font-semibold">Clôturé</th>
                <th className="px-4 py-3 text-right font-semibold">Fond</th>
                <th className="px-4 py-3 text-right font-semibold">Compté</th>
                <th className="px-4 py-3 text-right font-semibold">Théorique</th>
                <th className="px-4 py-3 text-right font-semibold">Écart espèces</th>
                <th className="px-4 py-3 text-right font-semibold">Écart réconc.</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {lignes.map((c) => {
                const r = nomResto.get(c.restaurant_id);
                // Repli temporaire tant que la migration cloud n'est pas
                // encore appliquée sur un environnement ancien.
                const ecart = c.ecart_reconciliation ?? c.ecart;
                // Au-delà du seuil, le POS écrit déjà une entrée d'audit
                // ECART_CAISSE : la console montre le même seuil, pas un autre.
                const grave = ecart !== null && Math.abs(ecart) > SEUIL_ECART;
                const note = noteEcart(c, ecart);
                return (
                  <Fragment key={c.service_id}>
                  <tr className={note ? '' : 'border-b border-filet last:border-0'}>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-semibold">
                        {r && <PastilleMarque marque={r.marque} />}
                        {r?.nom ?? 'Site inconnu'}
                      </span>
                      {c.caissier && <span className="mt-0.5 block text-sm text-doux">{c.caissier}</span>}
                    </td>
                    <td className="chiffres px-4 py-3 text-doux">{dateHeure(c.ouvert_le)}</td>
                    <td className="chiffres px-4 py-3 text-doux">
                      {c.cloture_le ? (
                        dateHeure(c.cloture_le)
                      ) : (
                        <span className="rounded-sm bg-attente-tint px-2 py-1 text-xs font-semibold text-attente-txt">
                          Service en cours
                        </span>
                      )}
                    </td>
                    <td className="chiffres px-4 py-3 text-right text-doux">{formatFCFA(c.fond_de_caisse)}</td>
                    <td className="chiffres px-4 py-3 text-right text-doux">
                      {c.especes_comptees === null ? '—' : formatFCFA(c.especes_comptees)}
                    </td>
                    <td className="chiffres px-4 py-3 text-right text-doux">
                      {c.especes_theorique === null ? '—' : formatFCFA(c.especes_theorique)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {c.ecart === null ? (
                        <span className="text-doux">—</span>
                      ) : (
                        <span className="chiffres text-doux">
                          {c.ecart > 0 ? '+' : ''}{formatFCFA(c.ecart)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {ecart === null ? (
                        <span className="text-doux">—</span>
                      ) : (
                        <span
                          className={`chiffres rounded-sm px-2 py-1 font-bold ${
                            grave ? 'bg-alerte-tint text-alerte-txt' : 'bg-ok-tint text-ok-txt'
                          }`}
                        >
                          {ecart > 0 ? '+' : ''}
                          {formatFCFA(ecart)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {c.cloture_le && (
                        <button type="button" className="btn-blanc !min-h-[38px] !px-3 !text-sm" onClick={() => setOuverte(c)}>
                          Ticket Z
                        </button>
                      )}
                    </td>
                  </tr>
                  {note && (
                    <tr className="border-b border-filet last:border-0">
                      <td colSpan={9} className="px-4 pb-3 pt-0">
                        <NoteEcart note={note} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              {lignes.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-doux">
                    {choisi ? `Aucune clôture pour ${choisi.nom} sur cette période.` : 'Aucune clôture sur cette période.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {ouverte && <ModaleTicketZ cloture={ouverte} nom={nomResto.get(ouverte.restaurant_id)?.nom ?? 'Site'} onFermer={() => setOuverte(null)} />}
    </section>
  );
}

type Note =
  | { genre: 'explication'; texte: string; remis_le: string | null }
  | { genre: 'attente' }
  | { genre: 'absente' };

/**
 * Ce que la ligne doit dire sous l'écart. L'explication est saisie par le
 * caissier quand il valide son ticket (« Terminer ») ; le POS l'exige dès que
 * l'écart RÉCONCILIÉ n'est pas nul. Un écart sans `remis_le` n'est donc pas
 * un silence : le caissier n'a pas encore terminé.
 *
 * Champs `undefined` : la RPC cloud n'a pas encore la migration du
 * 2026-10-17 — on n'affiche alors rien plutôt qu'un faux « sans explication ».
 */
function noteEcart(c: Cloture, ecart: number | null): Note | null {
  if (c.explication_ecart) return { genre: 'explication', texte: c.explication_ecart, remis_le: c.remis_le ?? null };
  if (c.remis_le === undefined || !c.cloture_le || !ecart) return null;
  return c.remis_le === null ? { genre: 'attente' } : { genre: 'absente' };
}

function NoteEcart({ note }: { note: Note }) {
  if (note.genre === 'attente') {
    return (
      <p className="rounded-sm bg-attente-tint px-3 py-2 text-sm text-attente-txt">
        Le caissier n’a pas encore validé son ticket : son explication de l’écart n’est pas encore arrivée.
      </p>
    );
  }
  if (note.genre === 'absente') {
    return <p className="px-3 text-sm text-faible">Aucune explication saisie pour cet écart.</p>;
  }
  return (
    <div className="rounded-btn border-l-4 border-alerte bg-carte-douce px-3 py-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-faible">
        Explication du caissier
        {note.remis_le && <span className="chiffres normal-case tracking-normal"> · {dateHeure(note.remis_le)}</span>}
      </div>
      <p className="mt-1 whitespace-pre-wrap font-medium">{note.texte}</p>
    </div>
  );
}

/**
 * Le rapport Z complet, chargé À LA DEMANDE : il pèse lourd (tout le point de
 * caisse en JSONB) et la liste n'en a pas besoin — c'est pourquoi la RPC
 * `siege_clotures` l'exclut volontairement.
 */
function ModaleTicketZ({ cloture, nom, onFermer }: { cloture: Cloture; nom: string; onFermer: () => void }) {
  const { data, error, isPending } = useQuery({
    queryKey: ['rapport_z', cloture.service_id],
    queryFn: () =>
      appelSiege<{ cloture: Record<string, unknown> }>('rapport_z', {
        service_id: cloture.service_id,
        restaurant_id: cloture.restaurant_id,
      }),
  });

  const rapport = (data?.cloture?.rapport_z ?? null) as RapportZLu | null;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onFermer}>
      <div
        className="my-auto w-full max-w-4xl rounded-jeton border border-filet bg-plan p-5 shadow-e2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-end">
          <button type="button" className="btn-blanc !min-h-[38px] !px-3 !text-sm" onClick={onFermer}>
            Fermer
          </button>
        </div>

        {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Rapport illisible'} />}
        {isPending && <Squelette lignes={3} />}

        {rapport ? (
          <TicketZ
            rapport={rapport}
            restaurant={nom}
            serviceId={cloture.service_id}
            restaurantId={cloture.restaurant_id}
            explication={(data?.cloture?.explication_ecart as string | null | undefined) ?? cloture.explication_ecart}
            remisLe={(data?.cloture?.remis_le as string | null | undefined) ?? cloture.remis_le}
          />
        ) : (
          !isPending && !error && <p className="text-doux">Ce service n’a pas de rapport Z figé.</p>
        )}
      </div>
    </div>
  );
}
