import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { IconKey, IconSearch } from '@tabler/icons-react';
import { appelSiege, ErreurSiege, type Employe, type EtatOrdre, type Siege } from '../api';
import { Erreur, Info, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';

/** Initiales pour l'emplacement de la photo, quand `photo_url` est vide. */
function initiales(nom: string): string {
  return nom
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((m) => m[0]?.toUpperCase() ?? '')
    .join('');
}

export function Equipe({
  siege,
  filtre,
  onFiltre,
}: {
  siege: Siege;
  filtre: FiltreResto;
  onFiltre: (v: FiltreResto) => void;
}) {
  const [recherche, setRecherche] = useState('');
  const [aReinitialiser, setAReinitialiser] = useState<Employe | null>(null);

  const { data: restos } = useRestaurants();
  const choisi = restoChoisi(restos?.restaurants, filtre);

  const { data, error, isPending } = useQuery({
    queryKey: ['equipe'],
    queryFn: () => appelSiege<{ employes: Employe[] }>('equipe'),
    staleTime: 5 * 60_000,
  });

  const employes = data?.employes ?? [];

  /** Un PIN ne se réinitialise que sur une caisse reliée au cloud : c'est elle qui exécute l'ordre. */
  const enroles = useMemo(
    () => new Set((restos?.restaurants ?? []).filter((r) => r.enrole).map((r) => r.samtrackly_id)),
    [restos],
  );

  /**
   * Le rattachement se compare sur le `samtrackly_id` et non sur le nom :
   * `employes[].restaurant_id` EST l'identifiant SamerTrackly du restaurant
   * (la fonction n'y ajoute que le nom, pour l'affichage). Comparer des noms
   * casserait au premier restaurant renommé ou mal accentué.
   */
  const visibles = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return employes.filter(
      (e) =>
        (!choisi || e.restaurant_id === choisi.samtrackly_id) &&
        (!q || (e.nom ?? '').toLowerCase().includes(q) || (e.poste ?? '').toLowerCase().includes(q)),
    );
  }, [employes, recherche, choisi]);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Équipe</h1>
          <p className="text-doux">
            {choisi ? `${visibles.length} personne(s) — ${choisi.nom}` : `${employes.length} personne(s) dans le groupe`}
          </p>
        </div>
        <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
      </div>

      {/* Le point à ne pas rouvrir : SamerTrackly est MAÎTRE de l'employé. La
          descente `sync-samtrackly.ts` désactive dans chaque POS tout compte lié
          disparu de sa liste — une seconde source d'employés provoquerait des
          désactivations et des doublons silencieux. D'où la lecture seule ici,
          et la phrase à l'écran plutôt qu'un bouton « Ajouter » qui manquerait. */}
      <Info>
        La fiche est en <b>lecture seule</b>. L’employé se crée et se modifie dans <b>SamerTrackly</b>, qui en est
        la source unique : chaque POS reçoit sa liste par la synchro, et désactive les comptes qui en disparaissent.
        {siege.niveau === 'ADMIN' && (
          <> Seul le <b>PIN de caisse</b> se réinitialise d’ici, quand un employé l’a oublié.</>
        )}
      </Info>

      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-doux" />
          <input
            type="search"
            className="champ pl-10"
            placeholder="Rechercher un nom, un poste…"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
          />
        </div>
      </div>

      {isPending ? (
        <Squelette lignes={4} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibles.map((e) => (
            <article key={e.id} className="flex items-center gap-3 rounded-jeton border border-filet bg-carte p-4 shadow-e1">
              {e.photo_url ? (
                <img src={e.photo_url} alt="" className="h-12 w-12 flex-none rounded-full object-cover" />
              ) : (
                <span className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-marque-tint text-sm font-bold text-marque-sur-plan">
                  {initiales(e.nom ?? '?')}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate font-semibold">{e.nom ?? 'Sans nom'}</p>
                <p className="truncate text-sm text-doux">{e.poste ?? 'Poste non renseigné'}</p>
                <p className="truncate text-xs text-faible">{e.restaurant_nom ?? 'Non rattaché à un restaurant'}</p>
              </div>
              {siege.niveau === 'ADMIN' && e.restaurant_id && enroles.has(e.restaurant_id) && (
                <button
                  type="button"
                  className="btn-blanc ml-auto flex-none"
                  title="Réinitialiser le PIN de caisse"
                  aria-label={`Réinitialiser le PIN de ${e.nom ?? 'cet employé'}`}
                  onClick={() => setAReinitialiser(e)}
                >
                  <IconKey size={18} />
                </button>
              )}
            </article>
          ))}
          {visibles.length === 0 && !error && (
            <p className="text-doux">Aucune personne ne correspond à cette recherche.</p>
          )}
        </div>
      )}

      {aReinitialiser && <ReinitPin employe={aReinitialiser} onFermer={() => setAReinitialiser(null)} />}
    </section>
  );
}

/**
 * Réinitialisation du PIN de caisse, en deux temps : confirmation, puis code.
 *
 * Le code est tiré par la fonction `siege` et montré UNE fois : le cloud n'en
 * garde que l'empreinte. Il devient utilisable quand la caisse du restaurant a
 * pris l'ordre (30 s en temps normal) — d'où le suivi, pour ne pas envoyer
 * l'employé taper un code que sa caisse ne connaît pas encore.
 */
function ReinitPin({ employe, onFermer }: { employe: Employe; onFermer: () => void }) {
  const nom = employe.nom ?? 'cet employé';
  const demande = useMutation({
    mutationFn: () =>
      appelSiege<{ ordre_id: string; code: string; restaurant_nom: string }>('pin_reinitialiser', {
        travailleur_id: employe.id,
      }),
  });
  const ordreId = demande.data?.ordre_id;

  const suivi = useQuery({
    queryKey: ['ordre_etat', ordreId],
    queryFn: () => appelSiege<{ ordre: EtatOrdre }>('ordre_etat', { id: ordreId }),
    enabled: !!ordreId,
    refetchInterval: (q) => (q.state.data?.ordre.statut === 'EN_ATTENTE' || !q.state.data ? 3000 : false),
  });
  const ordre = suivi.data?.ordre;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onFermer}>
      <div className="w-full max-w-lg rounded-jeton border border-filet bg-carte p-5 shadow-e2" onClick={(e) => e.stopPropagation()}>
        {!demande.data ? (
          <>
            <h2 className="mb-2 text-xl font-bold">Réinitialiser le PIN de {nom} ?</h2>
            <p className="mb-3 text-doux">
              Son PIN actuel cessera de fonctionner sur la caisse de {employe.restaurant_nom ?? 'son restaurant'}, et ses
              sessions ouvertes seront fermées. Vous recevrez un <b>code à 6 chiffres</b> à lui transmettre : il le tape
              sur la caisse, puis choisit lui-même son nouveau PIN.
            </p>
            {demande.error && (
              <p className="mb-3 rounded-sm bg-alerte-tint px-3 py-2 text-sm text-alerte-txt">
                {demande.error instanceof ErreurSiege ? demande.error.message : 'Réinitialisation impossible'}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-blanc" onClick={onFermer}>
                Annuler
              </button>
              <button type="button" className="btn-accent" disabled={demande.isPending} onClick={() => demande.mutate()}>
                {demande.isPending ? 'Envoi…' : 'Réinitialiser'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="mb-2 text-xl font-bold">Code pour {nom}</h2>
            <p className="mb-3 text-doux">
              Transmettez-lui ce code. Sur la caisse, il touche son profil, tape le code, puis pose son nouveau PIN. Il
              est valable <b>7 jours</b> et ne sert qu’une fois.
            </p>
            <p className="mb-4 rounded-jeton bg-plan py-4 text-center font-mono text-4xl font-bold tracking-[0.3em]">
              {demande.data.code}
            </p>
            {(!ordre || ordre.statut === 'EN_ATTENTE') && (
              <p className="mb-4 rounded-sm bg-attente-tint px-3 py-2 text-sm text-attente-txt">
                En attente de la caisse de {demande.data.restaurant_nom}… Elle prend la demande dans les 30 secondes si
                elle est allumée et connectée. Le code ne marche qu’après.
              </p>
            )}
            {ordre?.statut === 'EXECUTE' && (
              <p className="mb-4 rounded-sm bg-ok-tint px-3 py-2 text-sm text-ok-txt">
                La caisse de {demande.data.restaurant_nom} a pris le nouveau code : il est utilisable maintenant.
              </p>
            )}
            {(ordre?.statut === 'ECHEC' || ordre?.statut === 'EXPIRE') && (
              <p className="mb-4 rounded-sm bg-alerte-tint px-3 py-2 text-sm text-alerte-txt">
                La caisse n’a pas appliqué ce code : {ordre.erreur ?? 'raison inconnue'}. Ce code ne marchera pas.
              </p>
            )}
            <p className="mb-4 text-xs text-faible">
              Ce code ne sera plus affiché après fermeture. S’il est perdu, refaites une réinitialisation : l’ancien code
              sera remplacé.
            </p>
            <div className="flex justify-end">
              <button type="button" className="btn-accent" onClick={onFermer}>
                Fermer
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
