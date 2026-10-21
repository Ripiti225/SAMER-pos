import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatFCFA } from '@pos/shared';
import { appelSiege, ErreurSiege, type ClientsMois as ReponseClientsMois, type ParticipantTirage, type Siege, type TirageClients } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';
import { libelleClient, libelleMois, moisDeDate, moisParDefaut, moisRecents } from '../tirage';

/** « 01/11/2026 à 09:12 » — un procès-verbal se date à l'année près. */
function horodatage(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/** Le top 20 : rang, client, téléphone, montant, visites. Le gagnant ressort. */
function TableParticipants({ participants, gagnantId }: { participants: ParticipantTirage[]; gagnantId?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-filet text-[11px] uppercase tracking-wide text-faible">
            <th className="py-1.5 pr-3 font-semibold">Rang</th>
            <th className="px-3 py-1.5 font-semibold">Client</th>
            <th className="px-3 py-1.5 font-semibold">Téléphone</th>
            <th className="px-3 py-1.5 text-right font-semibold">Dépensé</th>
            <th className="py-1.5 pl-3 text-right font-semibold">Visites</th>
          </tr>
        </thead>
        <tbody>
          {participants.map((p) => {
            const gagnant = p.client_id === gagnantId;
            return (
              <tr key={p.client_id} className={`border-b border-filet last:border-0 ${gagnant ? 'bg-ok-tint font-semibold text-ok-txt' : ''}`}>
                <td className="chiffres py-2 pr-3">{p.rang}</td>
                <td className="px-3 py-2">
                  {p.nom ?? <span className="italic text-doux">Sans nom</span>}
                  {gagnant && <span className="ml-2 rounded-sm bg-ok px-2 py-0.5 text-xs text-white">Gagnant</span>}
                </td>
                <td className="chiffres px-3 py-2">{p.telephone}</td>
                <td className="chiffres px-3 py-2 text-right">{formatFCFA(p.montant)}</td>
                <td className="chiffres py-2 pl-3 text-right">{p.nb_visites}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Onglet « Clients du mois » — programme de fidélité.
 *
 * Chaque mois, dans chaque restaurant, un gagnant est tiré au sort parmi les
 * 20 clients qui y ont le plus dépensé, à chances égales. La console ne fait
 * qu'AFFICHER et DEMANDER : le classement, l'aléa et l'enregistrement sont faits
 * par la fonction `siege`, et la base refuse un second tirage pour le même
 * restaurant et le même mois — il n'y a donc pas de bouton « relancer ».
 *
 * Sans restaurant choisi, l'écran montre où en sont les tirages du mois dans
 * tout le groupe (un gagnant par restaurant) ; un clic ouvre le restaurant.
 */
export function ClientsMois({ filtre, onFiltre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const qc = useQueryClient();
  const { data: restos } = useRestaurants();
  const { data: moi } = useQuery({ queryKey: ['moi'], queryFn: () => appelSiege<Siege>('moi'), staleTime: 5 * 60_000 });
  const choisi = restoChoisi(restos?.restaurants, filtre);
  const restaurantId = choisi?.restaurant_id ?? null;

  const listeMois = useMemo(() => moisRecents(new Date(), 12), []);
  const [mois, setMois] = useState(() => moisParDefaut(new Date()));
  const [confirme, setConfirme] = useState(false);
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);

  const classement = useQuery({
    queryKey: ['clients_mois', restaurantId, mois],
    queryFn: () => appelSiege<ReponseClientsMois>('clients_mois', { restaurant_id: restaurantId, mois }),
    enabled: !!restaurantId,
  });

  // Historique de TOUT le groupe : il sert aussi au récapitulatif du mois
  // (quel restaurant a déjà son gagnant), et ne fait que quelques lignes par mois.
  const historique = useQuery({
    queryKey: ['tirages_clients'],
    queryFn: () => appelSiege<{ tirages: TirageClients[] }>('tirages_clients'),
  });

  const nomResto = useMemo(() => {
    const m = new Map<string, { nom: string; marque: 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE'; samtrackly_id: string }>();
    for (const r of restos?.restaurants ?? []) {
      if (r.restaurant_id) m.set(r.restaurant_id, { nom: r.nom, marque: r.marque, samtrackly_id: r.samtrackly_id });
    }
    return m;
  }, [restos]);

  const tirer = useMutation({
    mutationFn: () => appelSiege<{ tirage: TirageClients }>('tirage_clients', { restaurant_id: restaurantId, mois }),
    onSuccess: ({ tirage }) => {
      setConfirme(false);
      const gagnant = tirage.participants.find((p) => p.client_id === tirage.gagnant_client_id);
      setMsg({ texte: `Tirage enregistré. Gagnant : ${gagnant ? libelleClient(gagnant) : '—'}.`, ok: true });
      void qc.invalidateQueries({ queryKey: ['clients_mois'] });
      void qc.invalidateQueries({ queryKey: ['tirages_clients'] });
    },
    onError: (e: Error) => {
      setConfirme(false);
      setMsg({ texte: e instanceof ErreurSiege ? e.message : 'Tirage impossible' });
      // Un 409 « déjà tiré » veut dire qu'un autre poste a été plus rapide :
      // on recharge pour montrer SON gagnant.
      void qc.invalidateQueries({ queryKey: ['clients_mois'] });
      void qc.invalidateQueries({ queryKey: ['tirages_clients'] });
    },
  });

  const lectureSeule = moi?.niveau === 'LECTURE';
  const tirages = historique.data?.tirages ?? [];
  const tiragesAffiches = restaurantId ? tirages.filter((t) => t.restaurant_id === restaurantId) : tirages;
  const tiragesDuMois = new Map(tirages.filter((t) => moisDeDate(t.mois) === mois).map((t) => [t.restaurant_id, t]));

  const donnees = classement.data;
  const tirage = donnees?.tirage ?? null;
  const participants = tirage ? tirage.participants : (donnees?.participants ?? []);
  const gagnant = tirage ? tirage.participants.find((p) => p.client_id === tirage.gagnant_client_id) : undefined;

  const raisonBlocage = lectureSeule
    ? 'Votre compte est en lecture seule'
    : donnees && !donnees.mois_termine
      ? 'Le mois n’est pas terminé : le tirage se fait à partir du 1er du mois suivant'
      : participants.length === 0
        ? 'Aucun client fidélité ce mois-ci'
        : null;

  const changerMois = (m: string) => {
    setMois(m);
    setMsg(null);
  };

  return (
    <section className="max-w-5xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Clients du mois</h1>
          <p className="text-doux">
            Les 20 clients qui ont le plus dépensé dans chaque restaurant, et le tirage au sort de leur gagnant.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-doux">
            Mois
            <select
              className="champ !min-h-[40px] !w-auto !py-0 !text-[15px]"
              value={mois}
              onChange={(e) => changerMois(e.target.value)}
            >
              {listeMois.map((m) => (
                <option key={m} value={m}>
                  {libelleMois(m)}
                </option>
              ))}
            </select>
          </label>
          <FiltreRestaurant
            restaurants={restos?.restaurants ?? []}
            valeur={filtre}
            onChoisir={(v) => {
              setMsg(null);
              onFiltre(v);
            }}
          />
        </div>
      </div>

      {lectureSeule && <Info>Votre compte est en <b>lecture seule</b> : vous voyez les classements, vous ne tirez pas au sort.</Info>}
      {msg && (msg.ok ? <Info>{msg.texte}</Info> : <Erreur texte={msg.texte} />)}

      {/* ---------- Un restaurant : son top 20 et son tirage ---------- */}
      {choisi && !restaurantId && (
        <Info>
          <b>{choisi.nom}</b> ne synchronise pas encore avec le siège : aucune vente, donc aucun classement.
        </Info>
      )}

      {restaurantId && (
        <article className="mb-6 rounded-jeton border border-filet bg-carte p-4">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <span className="flex items-center gap-2 text-lg font-bold">
              {choisi && <PastilleMarque marque={choisi.marque} />}
              {choisi?.nom} · {libelleMois(mois)}
            </span>
            {donnees && !tirage && !donnees.mois_termine && (
              <span className="rounded-sm bg-attente-tint px-2 py-0.5 text-xs font-semibold text-attente-txt">
                mois en cours : classement provisoire
              </span>
            )}
          </div>

          {classement.error && (
            <Erreur texte={classement.error instanceof ErreurSiege ? classement.error.message : 'Lecture impossible'} />
          )}

          {classement.isPending ? (
            <Squelette lignes={2} />
          ) : (
            <>
              {tirage && gagnant && (
                <div className="mb-4 rounded-jeton bg-ok-tint px-4 py-3 text-ok-txt">
                  <div className="text-[12px] font-bold uppercase tracking-wide">Gagnant de {libelleMois(mois)}</div>
                  <div className="mt-1 text-xl font-bold">
                    {libelleClient(gagnant)}
                    {gagnant.nom && <span className="chiffres ml-2 text-base font-semibold">{gagnant.telephone}</span>}
                  </div>
                  <div className="mt-1 text-sm">
                    Rang {gagnant.rang} sur {tirage.participants.length} · {formatFCFA(gagnant.montant)} sur{' '}
                    {gagnant.nb_visites} visite{gagnant.nb_visites > 1 ? 's' : ''} · tiré le {horodatage(tirage.tire_le)} par{' '}
                    {tirage.tire_par_nom}
                  </div>
                  {!gagnant.nom && (
                    <div className="mt-1 text-sm">Ce client n’a pas donné son nom à la caisse : appelez-le au numéro ci-dessus.</div>
                  )}
                </div>
              )}

              {participants.length === 0 ? (
                <p className="text-doux">
                  Aucun client fidélité n’a acheté dans ce restaurant en {libelleMois(mois)} — ou ses ventes ne sont pas encore
                  remontées.
                </p>
              ) : (
                <TableParticipants participants={participants} gagnantId={tirage?.gagnant_client_id} />
              )}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-filet pt-3">
                <p className="max-w-xl text-sm text-doux">
                  {tirage
                    ? 'Liste figée au moment du tirage. Le tirage est définitif : il ne peut pas être refait.'
                    : 'Commandes payées du mois, hors Kdo et hors livraisons Yango/Glovo. Chaque participant a exactement la même chance, quel que soit son rang.'}
                </p>
                {!tirage && (
                  <button
                    type="button"
                    className="btn-accent !min-h-[44px] !px-5"
                    disabled={!!raisonBlocage || !donnees}
                    title={raisonBlocage ?? undefined}
                    onClick={() => setConfirme(true)}
                  >
                    Tirer au sort
                  </button>
                )}
              </div>
              {!tirage && raisonBlocage && !lectureSeule && participants.length > 0 && (
                <p className="mt-2 text-right text-sm text-attente-txt">{raisonBlocage}</p>
              )}
            </>
          )}
        </article>
      )}

      {/* ---------- Tout le groupe : où en sont les tirages du mois ---------- */}
      {!choisi && (
        <article className="mb-6 rounded-jeton border border-filet bg-carte p-4">
          <h2 className="mb-1 text-lg font-bold">Tirages de {libelleMois(mois)}</h2>
          <p className="mb-3 text-sm text-doux">Un gagnant par restaurant. Choisissez un restaurant pour voir son top 20 et tirer au sort.</p>
          {historique.isPending ? (
            <Squelette lignes={2} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                <tbody>
                  {(restos?.restaurants ?? []).map((r) => {
                    const t = r.restaurant_id ? tiragesDuMois.get(r.restaurant_id) : undefined;
                    const g = t?.participants.find((p) => p.client_id === t.gagnant_client_id);
                    return (
                      <tr key={r.samtrackly_id} className="border-b border-filet last:border-0">
                        <td className="py-2 pr-3 font-semibold">
                          <span className="flex items-center gap-2">
                            <PastilleMarque marque={r.marque} />
                            {r.nom}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {!r.enrole ? (
                            <span className="text-faible">non enrôlé</span>
                          ) : g ? (
                            <span className="font-semibold text-ok-txt">
                              {libelleClient(g)}
                              {g.nom && <span className="chiffres ml-2 font-normal text-doux">{g.telephone}</span>}
                            </span>
                          ) : (
                            <span className="text-doux">pas encore tiré</span>
                          )}
                        </td>
                        <td className="py-2 pl-3 text-right">
                          {r.enrole && (
                            <button type="button" className="btn-blanc !min-h-[36px] !px-3 !text-sm" onClick={() => onFiltre(r.samtrackly_id)}>
                              Ouvrir
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </article>
      )}

      {/* ---------- Historique des tirages ---------- */}
      <div className="rounded-jeton border border-filet bg-carte p-4">
        <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">Historique des tirages</h2>
        {historique.error && (
          <Erreur texte={historique.error instanceof ErreurSiege ? historique.error.message : 'Lecture impossible'} />
        )}
        {historique.isPending ? (
          <Squelette lignes={1} />
        ) : tiragesAffiches.length === 0 ? (
          <p className="text-doux">Aucun tirage enregistré pour l’instant.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-filet text-[11px] uppercase tracking-wide text-faible">
                  <th className="py-1.5 pr-3 font-semibold">Mois</th>
                  <th className="px-3 py-1.5 font-semibold">Restaurant</th>
                  <th className="px-3 py-1.5 font-semibold">Gagnant</th>
                  <th className="px-3 py-1.5 font-semibold">Téléphone</th>
                  <th className="px-3 py-1.5 font-semibold">Tiré le</th>
                  <th className="py-1.5 pl-3 font-semibold">Par</th>
                </tr>
              </thead>
              <tbody>
                {tiragesAffiches.map((t) => {
                  const g = t.participants.find((p) => p.client_id === t.gagnant_client_id);
                  const r = nomResto.get(t.restaurant_id);
                  return (
                    <tr
                      key={t.id}
                      className="cursor-pointer border-b border-filet last:border-0 hover:bg-carte-douce"
                      title="Voir les participants de ce tirage"
                      onClick={() => {
                        setMsg(null);
                        setMois(moisDeDate(t.mois));
                        if (r) onFiltre(r.samtrackly_id);
                      }}
                    >
                      <td className="py-2 pr-3 font-semibold">{libelleMois(moisDeDate(t.mois))}</td>
                      <td className="px-3 py-2">{r?.nom ?? 'Site inconnu'}</td>
                      <td className="px-3 py-2">{g ? (g.nom ?? <span className="italic text-doux">Sans nom</span>) : '—'}</td>
                      <td className="chiffres px-3 py-2">{g?.telephone ?? '—'}</td>
                      <td className="chiffres px-3 py-2 text-doux">{horodatage(t.tire_le)}</td>
                      <td className="py-2 pl-3 text-doux">{t.tire_par_nom}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Confirmation explicite : le tirage est définitif, et la base refusera
          d'en enregistrer un second pour ce restaurant et ce mois. */}
      {confirme && choisi && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirme(false)}>
          <div className="w-full max-w-lg rounded-jeton border border-filet bg-carte p-5 shadow-e2" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-2 text-xl font-bold">
              Tirer au sort le gagnant de {libelleMois(mois)} pour {choisi.nom} ?
            </h2>
            <p className="mb-3 text-doux">
              {participants.length} participant{participants.length > 1 ? 's' : ''}, chances égales. Le tirage est fait par le
              serveur du siège et enregistré avec votre nom.
            </p>
            <p className="mb-4 rounded-sm bg-attente-tint px-3 py-2 text-sm text-attente-txt">
              Il est <b>définitif</b> : il ne pourra être ni refait ni annulé pour ce restaurant et ce mois.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-blanc" onClick={() => setConfirme(false)}>
                Annuler
              </button>
              <button type="button" className="btn-accent" disabled={tirer.isPending} onClick={() => tirer.mutate()}>
                {tirer.isPending ? 'Tirage…' : 'Tirer au sort'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
