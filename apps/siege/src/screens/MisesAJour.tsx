import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appelSiege, ErreurSiege, type Siege } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { dateHeure } from '../periode';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';
import {
  actionsPossibles,
  libelleEvenement,
  LIBELLE_STATUT,
  resumeDetail,
  taille,
  versionsEpinglables,
  type ReglagesMaj,
  type ReponseHistorique,
  type SiteMaj,
  type VersionMaj,
} from '../maj';
import { versionDeNumero } from '../sante';

/**
 * Onglet Mises à jour — les versions publiées des postes, leur cycle de vie
 * (brouillon → pilote → générale), les réglages de chaque site et ce que les
 * sites en ont fait.
 *
 * **Publier ne se fait pas ici.** Une version naît sur le poste de publication
 * (`scripts/maj/publier.mjs`), signée avec la clé privée hors ligne du
 * propriétaire ; elle arrive ici en BROUILLON. La console ne fait que choisir
 * QUELLE version déjà signée chaque site doit avoir : un compte siège volé ne
 * peut pas fabriquer de version.
 *
 * Droits : promouvoir et retirer sont réservés au propriétaire ; les réglages
 * des sites (heure, type, anneau, pause, épinglage, installer maintenant,
 * réessayer) sont ouverts aux ADMIN ; LECTURE voit tout.
 */
export function MisesAJour({ siege, filtre, onFiltre }: { siege: Siege; filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const qc = useQueryClient();
  const { data: restos } = useRestaurants();
  const choisi = restoChoisi(restos?.restaurants, filtre);
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: ['maj_historique', choisi?.restaurant_id ?? ''],
    queryFn: () => appelSiege<ReponseHistorique>('maj_historique', { restaurant_id: choisi?.restaurant_id ?? '' }),
    // Les comptes rendus arrivent pendant une installation : on suit sans recharger.
    refetchInterval: 30_000,
  });

  const nomResto = useMemo(() => {
    const m = new Map<string, { nom: string; marque: 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE' }>();
    for (const r of restos?.restaurants ?? []) if (r.restaurant_id) m.set(r.restaurant_id, { nom: r.nom, marque: r.marque });
    return m;
  }, [restos]);

  const rafraichir = () => void qc.invalidateQueries({ queryKey: ['maj_historique'] });
  const surErreur = (e: Error) => setMsg({ texte: e instanceof ErreurSiege ? e.message : 'Action impossible' });

  const promouvoir = useMutation({
    mutationFn: (p: { numero: number; vers: 'PILOTE' | 'GENERALE'; forcer?: boolean }) => appelSiege('maj_promouvoir', p),
    onSuccess: (_d, p) => {
      setMsg({ texte: p.vers === 'PILOTE' ? 'Version envoyée à l’anneau pilote.' : 'Version générale : tous les sites vont la recevoir.', ok: true });
      rafraichir();
    },
    onError: surErreur,
  });

  const retirer = useMutation({
    mutationFn: (p: { numero: number; motif: string }) => appelSiege('maj_retirer', p),
    onSuccess: () => {
      setMsg({ texte: 'Version retirée : plus aucun site ne la recevra. Pour revenir en arrière, republiez l’ancien code sous un nouveau numéro.', ok: true });
      rafraichir();
    },
    onError: surErreur,
  });

  const regler = useMutation({
    mutationFn: (p: { restaurant_id: string; modifications?: Partial<ReglagesMaj>; installer_maintenant?: boolean; reessayer?: boolean }) =>
      appelSiege('maj_reglages_site', p),
    onSuccess: (_d, p) => {
      setMsg({
        texte: p.installer_maintenant
          ? 'Demande envoyée : le site installera dès qu’il aura reçu la consigne (sous 15 min s’il est en ligne).'
          : p.reessayer
            ? 'Nouvelle tentative demandée.'
            : 'Réglages enregistrés.',
        ok: true,
      });
      rafraichir();
    },
    onError: surErreur,
  });

  const proprietaire = data?.proprietaire ?? siege.proprietaire === true;
  const admin = siege.niveau === 'ADMIN';

  const demanderPromotion = (v: VersionMaj, vers: 'PILOTE' | 'GENERALE') => {
    const texte = vers === 'PILOTE'
      ? `Envoyer ${v.version} à l’anneau pilote (Angré 7E) ?`
      : `Envoyer ${v.version} à TOUS les sites ?`;
    if (!window.confirm(texte)) return;
    promouvoir.mutate(
      { numero: v.numero, vers },
      {
        onError: (e) => {
          // Pilote de moins de 48 h : le cloud demande une confirmation explicite.
          if (e instanceof ErreurSiege && e.statut === 409 && /48 h/.test(e.message) && window.confirm(`${e.message}`)) {
            promouvoir.mutate({ numero: v.numero, vers, forcer: true });
          }
        },
      },
    );
  };

  const demanderRetrait = (v: VersionMaj) => {
    const motif = window.prompt(`Retirer ${v.version} ? Indiquez le motif (obligatoire) :`);
    if (motif && motif.trim().length >= 3) retirer.mutate({ numero: v.numero, motif: motif.trim() });
  };

  const sites = (data?.sites ?? []).filter((s) => !choisi || s.restaurant_id === choisi.restaurant_id);
  const epinglables = versionsEpinglables(data?.versions ?? []);

  return (
    <section className="max-w-6xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Mises à jour</h1>
          <p className="text-doux">Les versions des postes, leur diffusion et ce que chaque restaurant en a fait.</p>
        </div>
        <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
      </div>

      <Info>
        Une version arrive ici en <b>brouillon</b>, publiée et signée depuis le poste du propriétaire. Elle passe ensuite en{' '}
        <b>pilote</b> (Angré 7E, 48 h d’observation), puis en <b>générale</b> (tous les sites). Les sites « ferme la nuit »
        l’installent au démarrage suivant, les sites 24h/24 à leur heure (coupure de 2-3 min).
      </Info>

      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}
      {data?.migration_absente && <Erreur texte="Le cloud n’a pas encore les tables de mise à jour (migration 20261023000000_maj_postes à appliquer)." />}
      {data && !data.cle_publique_empreinte && (
        <Erreur texte="Clé publique de mise à jour non configurée dans le cloud (secret MAJ_CLE_PUBLIQUE) : aucune version ne peut être enregistrée." />
      )}
      {msg && (msg.ok ? <Info>{msg.texte}</Info> : <Erreur texte={msg.texte} />)}

      {isPending ? (
        <Squelette lignes={4} />
      ) : (
        <div className="space-y-6">
          {/* ---------- Versions ---------- */}
          <div>
            <h2 className="mb-2 text-lg font-bold">Versions</h2>
            <div className="overflow-x-auto rounded-jeton border border-filet bg-carte">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-filet text-[11px] uppercase tracking-wide text-faible">
                    <th className="px-4 py-2 font-semibold">Version</th>
                    <th className="px-3 py-2 font-semibold">Statut</th>
                    <th className="px-3 py-2 font-semibold">Notes</th>
                    <th className="px-3 py-2 font-semibold">Publiée</th>
                    <th className="px-4 py-2 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.versions ?? []).map((v) => {
                    const s = LIBELLE_STATUT[v.statut];
                    const nouvelles = v.migrations?.nouvelles ?? [];
                    return (
                      <tr key={v.numero} className="border-b border-filet align-top last:border-0">
                        <td className="px-4 py-3">
                          <code className="chiffres font-semibold">{v.version}</code>
                          <div className="text-xs text-faible">
                            commit {v.commit_git.slice(0, 7)} · {taille(v.taille_octets)}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-block rounded-sm px-2 py-0.5 text-xs font-semibold ${s.classe}`}>{s.texte}</span>
                          {v.pilote_le && <div className="mt-1 text-xs text-faible">pilote : {dateHeure(v.pilote_le)}</div>}
                          {v.generale_le && <div className="text-xs text-faible">générale : {dateHeure(v.generale_le)}</div>}
                          {v.retiree_le && (
                            <div className="mt-1 text-xs text-alerte-txt">
                              retirée {dateHeure(v.retiree_le)}
                              {v.retiree_motif ? ` — ${v.retiree_motif}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="max-w-[320px] px-3 py-3">
                          <p className="whitespace-pre-line text-xs text-doux">{v.notes || '—'}</p>
                          {nouvelles.length > 0 && (
                            <p className="mt-1 text-xs text-faible">
                              {nouvelles.length} migration(s) de base{v.migrations?.retrocompatibles === false && ' · ⚠ non rétrocompatible'}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3 text-xs text-doux">
                          {dateHeure(v.publie_le)}
                          {v.publie_par && <div className="text-faible">par {v.publie_par}</div>}
                        </td>
                        <td className="px-4 py-3">
                          {proprietaire ? (
                            <div className="flex flex-wrap gap-2">
                              {actionsPossibles(v).map((a) =>
                                a === 'RETIRER' ? (
                                  <button key={a} type="button" className="btn-blanc" disabled={retirer.isPending} onClick={() => demanderRetrait(v)}>
                                    Retirer
                                  </button>
                                ) : (
                                  <button key={a} type="button" className="btn-accent" disabled={promouvoir.isPending} onClick={() => demanderPromotion(v, a)}>
                                    {a === 'PILOTE' ? 'Envoyer au pilote' : 'Envoyer à tous'}
                                  </button>
                                ),
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-faible">réservé au propriétaire</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {(data?.versions ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-doux">Aucune version publiée pour l’instant.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {data?.cle_publique_empreinte && (
              <p className="mt-2 text-xs text-faible">
                Clé de signature attendue par le cloud : <code>{data.cle_publique_empreinte}</code> — doit être celle du lanceur des postes.
              </p>
            )}
          </div>

          {/* ---------- Réglages par site ---------- */}
          <div>
            <h2 className="mb-2 text-lg font-bold">Réglages par restaurant</h2>
            {!admin && <Info>Votre compte est en <b>lecture seule</b> : vous voyez les réglages, vous ne les changez pas.</Info>}
            <div className="space-y-3">
              {sites.map((s) => (
                <ReglagesSite
                  key={s.restaurant_id}
                  site={s}
                  nom={nomResto.get(s.restaurant_id)}
                  epinglables={epinglables}
                  modifiable={admin}
                  occupe={regler.isPending}
                  onRegler={(p) => regler.mutate({ restaurant_id: s.restaurant_id, ...p })}
                />
              ))}
              {sites.length === 0 && <p className="text-doux">Aucun site enrôlé.</p>}
            </div>
          </div>

          {/* ---------- Comptes rendus ---------- */}
          <div>
            <h2 className="mb-2 text-lg font-bold">Ce que les sites ont fait</h2>
            <div className="overflow-x-auto rounded-jeton border border-filet bg-carte">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-filet text-[11px] uppercase tracking-wide text-faible">
                    <th className="px-4 py-2 font-semibold">Reçu</th>
                    <th className="px-3 py-2 font-semibold">Restaurant</th>
                    <th className="px-3 py-2 font-semibold">Version</th>
                    <th className="px-4 py-2 font-semibold">Événement</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.rapports ?? []).map((r) => {
                    const e = libelleEvenement(r.evenement);
                    const resto = nomResto.get(r.restaurant_id);
                    const detail = resumeDetail(r.detail);
                    return (
                      <tr key={r.id} className="border-b border-filet align-top last:border-0">
                        <td className="chiffres px-4 py-2 text-xs text-doux">{dateHeure(r.recu_le)}</td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2">
                            {resto && <PastilleMarque marque={resto.marque} />}
                            {resto?.nom ?? data?.sites.find((x) => x.restaurant_id === r.restaurant_id)?.code ?? '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <code className="chiffres text-xs">{versionDeNumero(r.numero) ?? '—'}</code>
                        </td>
                        <td className="px-4 py-2">
                          <span className={e.grave ? 'font-semibold text-alerte-txt' : ''}>{e.texte}</span>
                          {detail && <p className="text-xs text-doux">{detail}</p>}
                        </td>
                      </tr>
                    );
                  })}
                  {(data?.rapports ?? []).length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-doux">Aucun compte rendu reçu.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Une carte de réglages par site. Les changements ne partent qu'au clic sur « Enregistrer ». */
function ReglagesSite({
  site,
  nom,
  epinglables,
  modifiable,
  occupe,
  onRegler,
}: {
  site: SiteMaj;
  nom: { nom: string; marque: 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE' } | undefined;
  epinglables: VersionMaj[];
  modifiable: boolean;
  occupe: boolean;
  onRegler: (p: { modifications?: Partial<ReglagesMaj>; installer_maintenant?: boolean; reessayer?: boolean }) => void;
}) {
  const r = site.reglages;
  const [brouillon, setBrouillon] = useState<Partial<ReglagesMaj>>({});
  const val = { ...r, ...brouillon };
  const change = Object.keys(brouillon).length > 0;
  const poser = (p: Partial<ReglagesMaj>) => setBrouillon((b) => ({ ...b, ...p }));

  return (
    <article className="rounded-jeton border border-filet bg-carte p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-2 font-bold">
          {nom && <PastilleMarque marque={nom.marque} />}
          {nom?.nom ?? site.code}
          <span className="text-xs font-normal text-faible">{site.code}</span>
        </span>
        <span className="text-xs text-doux">
          cible : {site.cible ? <code className="chiffres">{site.cible.version}</code> : 'aucune'}
          {site.cible?.raison === 'EPINGLEE' && ' (épinglée)'}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-faible">Type de site</span>
          <select
            className="champ"
            disabled={!modifiable}
            value={val.type_site}
            onChange={(e) => poser({ type_site: e.target.value as ReglagesMaj['type_site'] })}
          >
            <option value="FERME_LA_NUIT">Ferme la nuit (au démarrage)</option>
            <option value="H24">24h/24 (à heure fixe)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-faible">{val.type_site === 'H24' ? 'Heure d’installation' : 'Heure de secours'}</span>
          <input
            type="time"
            className="champ"
            disabled={!modifiable}
            value={val.type_site === 'H24' ? val.heure_installation : val.heure_filet}
            onChange={(e) => poser(val.type_site === 'H24' ? { heure_installation: e.target.value } : { heure_filet: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-faible">Anneau</span>
          <select className="champ" disabled={!modifiable} value={val.anneau} onChange={(e) => poser({ anneau: e.target.value as ReglagesMaj['anneau'] })}>
            <option value="GENERAL">Général</option>
            <option value="PILOTE">Pilote</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-faible">Version épinglée</span>
          <select
            className="champ"
            disabled={!modifiable}
            value={val.version_epinglee ?? ''}
            onChange={(e) => poser({ version_epinglee: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Aucune (suivre l’anneau)</option>
            {epinglables.map((v) => (
              <option key={v.numero} value={v.numero}>
                {v.version}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" disabled={!modifiable} checked={val.pause} onChange={(e) => poser({ pause: e.target.checked })} />
          <span>En pause</span>
        </label>
        {modifiable && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-accent"
              disabled={!change || occupe}
              onClick={() => {
                onRegler({ modifications: brouillon });
                setBrouillon({});
              }}
            >
              Enregistrer
            </button>
            <button
              type="button"
              className="btn-blanc"
              disabled={occupe}
              onClick={() => {
                if (window.confirm('Installer la mise à jour prête MAINTENANT, même en plein service (coupure de 2-3 min) ?')) {
                  onRegler({ installer_maintenant: true });
                }
              }}
            >
              Installer maintenant
            </button>
            <button type="button" className="btn-blanc" disabled={occupe} onClick={() => onRegler({ reessayer: true })}>
              Réessayer
            </button>
          </div>
        )}
      </div>
      {(r.installer_maintenant_le || r.reessayer_le || r.maj_par) && (
        <p className="mt-2 text-xs text-faible">
          {r.installer_maintenant_le && `« Installer maintenant » demandé le ${dateHeure(r.installer_maintenant_le)}. `}
          {r.reessayer_le && `Nouvelle tentative demandée le ${dateHeure(r.reessayer_le)}. `}
          {r.maj_par && r.maj_le && `Dernier réglage : ${r.maj_par}, ${dateHeure(r.maj_le)}.`}
        </p>
      )}
    </article>
  );
}
