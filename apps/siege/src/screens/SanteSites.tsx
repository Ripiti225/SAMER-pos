import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { appelSiege, ErreurSiege } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { dateHeure } from '../periode';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';
import {
  duree,
  evaluerMaj,
  evaluerSite,
  ilYa,
  trierParUrgence,
  versionDeNumero,
  versionMajoritaire,
  type CouleurSante,
  type ReponseSante,
  type TonMaj,
} from '../sante';

/** Ton de l'état de mise à jour → pastille (mêmes jetons que la colonne État). */
const TON_MAJ: Record<TonMaj, string> = {
  ok: 'bg-ok-tint text-ok-txt',
  attente: 'bg-attente-tint text-attente-txt',
  alerte: 'bg-alerte-tint text-alerte-txt',
  neutre: 'bg-carte-douce text-doux',
};

const PASTILLE: Record<CouleurSante, { classe: string; texte: string }> = {
  vert: { classe: 'bg-ok-tint text-ok-txt', texte: 'À jour' },
  orange: { classe: 'bg-attente-tint text-attente-txt', texte: 'En retard' },
  rouge: { classe: 'bg-alerte-tint text-alerte-txt', texte: 'À traiter' },
  gris: { classe: 'bg-carte-douce text-doux', texte: 'Non enrôlé' },
};

/**
 * Onglet Santé des sites — un coup d'œil pour savoir quel restaurant ne
 * remonte plus, sans téléphoner au gérant.
 *
 * Le siège ne peut pas interroger un mini-PC derrière la box d'un restaurant :
 * tout ce qu'on voit ici, c'est ce que le site a dit au cloud la dernière fois
 * qu'il lui a parlé (journal de synchro + battement de cœur envoyé avec chaque
 * descente). D'où la colonne « Dernière synchro » : un chiffre « en attente »
 * vieux de deux jours n'est pas l'état actuel du site, c'est son dernier mot.
 */
export function SanteSites({ filtre, onFiltre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const { data: restos } = useRestaurants();
  const choisi = restoChoisi(restos?.restaurants, filtre);

  const { data, isPending, error } = useQuery({
    queryKey: ['sante_sites'],
    queryFn: () => appelSiege<ReponseSante>('sante_sites'),
    // La descente des sites passe toutes les 5 min ; une minute suffit à
    // voir un site repasser au vert sans marteler la fonction.
    refetchInterval: 60_000,
  });

  const lignes = useMemo(() => {
    if (!data) return [];
    const maintenant = new Date(data.maintenant);
    return trierParUrgence(
      data.sites
        .filter((s) => !choisi || s.samtrackly_id === choisi.samtrackly_id)
        .map((s) => ({ ...s, evaluation: evaluerSite(s, maintenant), majEval: evaluerMaj(s, maintenant) })),
    );
  }, [data, choisi]);

  const majoritaire = useMemo(() => versionMajoritaire(data?.sites ?? []), [data]);
  const maintenantMs = data ? new Date(data.maintenant).getTime() : 0;
  const nbPointsBloques = lignes.filter((l) => l.enrole && l.evaluation.points_bloques).length;
  const nbEnRetard = lignes.filter((l) => l.majEval.en_retard).length;
  const nbGrenam = lignes.filter((l) => l.majEval.suspects_grenam > 0).length;

  return (
    <section className="max-w-6xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Santé des sites</h1>
          <p className="text-doux">La dernière fois que chaque restaurant a parlé au cloud, et ce qu’il garde encore chez lui.</p>
        </div>
        <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
      </div>

      <Info>
        <b>Vert</b> : synchronisé il y a moins de 15 min. <b>Orange</b> : pas de nouvelles depuis moins de 24 h — les ventes
        continuent sur place et remonteront au retour d’internet. <b>Rouge</b> : plus de 24 h ou jamais. Au-delà de{' '}
        <b>24 h sans descente du catalogue, le site refuse le paiement en points</b> (il ne peut plus vérifier le solde
        du client) ; il le réautorise tout seul dès que la synchro repasse.
      </Info>

      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}
      {data?.migration_absente && (
        <Erreur texte="Le cloud n’a pas encore la table de santé des sites (migration 20261021010000_sante_sites à appliquer). Seule la liste des restaurants s’affiche." />
      )}
      {nbPointsBloques > 0 && (
        <Erreur
          texte={`Paiement en points bloqué en ce moment sur ${nbPointsBloques} restaurant${nbPointsBloques > 1 ? 's' : ''}.`}
        />
      )}

      {nbGrenam > 0 && (
        <Erreur
          texte={`Fichiers suspects (virus Grenam : exécutable de 533 504 octets ou g*.exe caché) signalés par ${nbGrenam} poste${nbGrenam > 1 ? 's' : ''} : ne plus y brancher de clé USB et faire analyser le poste.`}
        />
      )}
      {nbEnRetard > 0 && (
        <Erreur
          texte={`${nbEnRetard} restaurant${nbEnRetard > 1 ? 's n’ont' : ' n’a'} pas installé la mise à jour disponible depuis plus de 24 h.`}
        />
      )}
      {data && !data.migration_absente && data.maj_absente && (
        <Info>Mise à jour à distance : migration cloud 20261023000000_maj_postes pas encore appliquée, colonnes « cible » vides.</Info>
      )}

      {isPending ? (
        <Squelette lignes={4} />
      ) : (
        <div className="overflow-x-auto rounded-jeton border border-filet bg-carte">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-filet text-[11px] uppercase tracking-wide text-faible">
                <th className="px-4 py-2 font-semibold">Restaurant</th>
                <th className="px-3 py-2 font-semibold">État</th>
                <th className="px-3 py-2 font-semibold">Dernière synchro</th>
                <th className="px-3 py-2 text-right font-semibold">En attente</th>
                <th className="px-3 py-2 font-semibold">Points</th>
                <th className="px-3 py-2 font-semibold">Version installée / cible</th>
                <th className="px-4 py-2 font-semibold">Mise à jour</th>
              </tr>
            </thead>
            <tbody>
              {lignes.map((l) => {
                const e = l.evaluation;
                const s = l.sante;
                const p = PASTILLE[e.couleur];
                const contactMs = e.dernier_contact ? maintenantMs - new Date(e.dernier_contact).getTime() : null;
                return (
                  <tr key={l.samtrackly_id} className="border-b border-filet align-top last:border-0">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-semibold">
                        <PastilleMarque marque={l.marque} />
                        {l.nom}
                      </span>
                      {s?.code && <span className="text-xs text-faible">{s.code}</span>}
                    </td>
                    <td className="max-w-[300px] px-3 py-3">
                      <span className={`inline-block rounded-sm px-2 py-0.5 text-xs font-semibold ${p.classe}`}>{p.texte}</span>
                      <p className="mt-1 text-xs text-doux">{e.resume}</p>
                      {e.decalage_horloge_ms !== null && (
                        <p className="mt-1 text-xs text-attente-txt">
                          Horloge du mini-PC {e.decalage_horloge_ms > 0 ? 'en avance' : 'en retard'} de{' '}
                          {duree(Math.abs(e.decalage_horloge_ms))} : la règle des 24 h des points se calcule avec elle.
                        </p>
                      )}
                      {(s?.rejets_24h ?? 0) > 0 && (
                        <p className="mt-1 text-xs text-alerte-txt">{s!.rejets_24h} ligne(s) refusée(s) par le cloud en 24 h.</p>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {contactMs === null ? (
                        <span className="text-doux">{l.enrole ? 'Jamais' : '—'}</span>
                      ) : (
                        <>
                          <span className="font-semibold">{ilYa(contactMs)}</span>
                          <div className="chiffres text-xs text-faible">{dateHeure(e.dernier_contact)}</div>
                          {s?.dernier_push && (
                            <div className="text-xs text-faible">dernières ventes reçues : {dateHeure(s.dernier_push)}</div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="chiffres px-3 py-3 text-right">
                      {e.en_attente === null ? (
                        <span className="text-faible" title="Ce POS ne remonte pas encore ce chiffre (version antérieure au 21/10/2026)">
                          ?
                        </span>
                      ) : (
                        <span className={e.en_attente > 0 ? 'font-semibold' : 'text-doux'}>{e.en_attente}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs">
                      {!l.enrole ? (
                        <span className="text-faible">—</span>
                      ) : e.points_bloques ? (
                        <span className="font-semibold text-alerte-txt">Bloqués (règle des 24 h)</span>
                      ) : (
                        <span className="text-doux">
                          Autorisés
                          {e.points_bloques_dans_ms !== null && e.points_bloques_dans_ms < 6 * 3_600_000 && (
                            <span className="text-attente-txt"> · bloqués dans {duree(e.points_bloques_dans_ms)} sans synchro</span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {l.majEval.installe !== null && (
                        <div>
                          <code className="chiffres text-xs">{versionDeNumero(l.majEval.installe)}</code>
                        </div>
                      )}
                      {s?.version_code ? (
                        <>
                          <code className="chiffres text-xs" title={s.commit_git ?? undefined}>{s.version_code}</code>
                          {majoritaire && s.version_code !== majoritaire && (
                            <div className="text-xs text-attente-txt">différente des autres sites</div>
                          )}
                        </>
                      ) : (
                        l.majEval.installe === null && <span className="text-xs text-faible">{l.enrole ? 'inconnue' : '—'}</span>
                      )}
                      {l.maj?.cible && (
                        <div className="mt-1 text-xs text-doux">
                          cible : <code className="chiffres">{l.maj.cible.version}</code>
                          {l.maj.cible.raison === 'EPINGLEE' && ' (épinglée)'}
                          {l.maj.cible.raison === 'PILOTE' && ' (pilote)'}
                        </div>
                      )}
                    </td>
                    <td className="max-w-[240px] px-4 py-3">
                      {l.enrole ? (
                        <>
                          <span className={`inline-block rounded-sm px-2 py-0.5 text-xs font-semibold ${TON_MAJ[l.majEval.ton]}`}>
                            {l.majEval.etat}
                          </span>
                          {l.majEval.en_retard && l.majEval.attente_ms !== null && (
                            <p className="mt-1 text-xs font-semibold text-alerte-txt">En retard ({duree(l.majEval.attente_ms)})</p>
                          )}
                          {l.majEval.detail && <p className="mt-1 text-xs text-doux">{l.majEval.detail}</p>}
                          {l.maj && (
                            <p className="mt-1 text-xs text-faible">
                              {l.maj.type_site === 'FERME_LA_NUIT' ? 'au démarrage' : `à ${l.maj.heure_installation.replace(':', 'h')}`}
                              {l.maj.anneau === 'PILOTE' && ' · pilote'}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-faible">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {lignes.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-doux">Aucun restaurant.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-xs text-faible">
        « En attente » et « Version » viennent du site lui-même, avec sa dernière synchro : un site éteint garde
        le dernier chiffre qu’il a donné. « ? » ou « inconnue » : le POS de ce site est antérieur à ce suivi.
      </p>
    </section>
  );
}
