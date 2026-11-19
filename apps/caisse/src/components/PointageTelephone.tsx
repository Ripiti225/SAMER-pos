/**
 * Pointage par téléphone (2026-11-19), côté caisse :
 *   - les selfies d'une arrivée / d'un départ pointés au téléphone ;
 *   - les changements de téléphone à valider par le gérant (PIN manager).
 * Le 1er téléphone d'un employé se rattache tout seul : seuls les
 * CHANGEMENTS arrivent ici.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDeviceMobile } from '@tabler/icons-react';
import { api } from '../api';
import { Modale } from './Modale';
import { ModalePinManager } from './ModalePinManager';

interface Demande {
  id: string;
  utilisateur_id: string;
  nom_complet: string;
  libelle: string | null;
  cree_le: string;
}

const CLE_DEMANDES = ['pointage-tel', 'demandes'] as const;

function quand(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Selfies d'un membre de l'équipe (rien si l'arrivée/le départ n'est pas passé par un téléphone). */
export function SelfiesPointage({ equipeId }: { equipeId: string }) {
  const [absents, setAbsents] = useState<Set<string>>(new Set());
  const sens = (['ENTREE', 'SORTIE'] as const).filter((s) => !absents.has(s));
  if (sens.length === 0) return null;
  return (
    <div className="mb-4 flex gap-3">
      {sens.map((s) => (
        <figure key={s} className="w-1/2">
          <img
            src={`/api/pointage-tel/selfie/${equipeId}/${s}`}
            alt={s === 'ENTREE' ? 'Selfie de l’arrivée' : 'Selfie du départ'}
            className="aspect-[3/4] w-full rounded-jeton object-cover"
            onError={() => setAbsents((a) => new Set(a).add(s))}
          />
          <figcaption className="mt-1 text-center text-xs text-doux">
            {s === 'ENTREE' ? 'Arrivée (téléphone)' : 'Départ (téléphone)'}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

/** Bouton du bandeau : n'apparaît que s'il y a des changements de téléphone à trancher. */
export function BoutonDemandesTelephone({ onErreur }: { onErreur: (m: string) => void }) {
  const [ouvert, setOuvert] = useState(false);
  const { data } = useQuery({
    queryKey: CLE_DEMANDES,
    queryFn: () => api<Demande[]>('/api/pointage-tel/demandes'),
    refetchInterval: 60_000,
  });
  if (!data || data.length === 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOuvert(true)}
        className="flex flex-none items-center gap-2 rounded-btn border border-attente/50 bg-attente-tint px-3 py-2 text-[13.5px] font-semibold text-attente-txt"
      >
        <IconDeviceMobile size={17} />
        {data.length} changement{data.length > 1 ? 's' : ''} de téléphone
      </button>
      {ouvert && <ModaleDemandes demandes={data} onFermer={() => setOuvert(false)} onErreur={onErreur} />}
    </>
  );
}

function ModaleDemandes({ demandes, onFermer, onErreur }: { demandes: Demande[]; onFermer: () => void; onErreur: (m: string) => void }) {
  const qc = useQueryClient();
  const [decision, setDecision] = useState<{ demande: Demande; accepter: boolean } | null>(null);
  const decider = useMutation({
    mutationFn: ({ pin }: { pin: string }) =>
      api(`/api/pointage-tel/demandes/${decision!.demande.id}/${decision!.accepter ? 'accepter' : 'refuser'}`, {
        method: 'POST',
        corps: { pin_manager: pin },
      }),
    onSuccess: () => {
      setDecision(null);
      void qc.invalidateQueries({ queryKey: CLE_DEMANDES });
    },
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  if (decision) {
    return (
      <ModalePinManager
        titre={`${decision.accepter ? 'Accepter' : 'Refuser'} le nouveau téléphone de ${decision.demande.nom_complet}`}
        explication={decision.accepter
          ? 'L’ancien téléphone ne pourra plus pointer pour ce compte. Vérifiez que c’est bien la personne, avec son nouveau téléphone en main.'
          : 'Le nouveau téléphone ne pourra pas pointer. L’ancien reste valable.'}
        demanderMotif={false}
        enCours={decider.isPending}
        onConfirmer={({ pin }) => decider.mutate({ pin })}
        onFermer={() => setDecision(null)}
      />
    );
  }

  return (
    <Modale
      titre="Changements de téléphone"
      onFermer={onFermer}
      enfants={
        <div>
          <p className="mb-4 text-sm text-doux">
            Ces employés veulent pointer avec un autre téléphone. Un téléphone ne sert qu’à une seule personne :
            acceptez seulement si la personne est devant vous avec son nouveau téléphone.
          </p>
          <ul className="flex flex-col gap-2">
            {demandes.map((d) => (
              <li key={d.id} className="flex items-center gap-3 rounded-jeton border border-bordure bg-surface p-3">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{d.nom_complet}</div>
                  <div className="text-sm text-doux">{d.libelle ?? 'Téléphone'} · demandé le {quand(d.cree_le)}</div>
                </div>
                <button type="button" className="btn-blanc min-h-[48px]" onClick={() => setDecision({ demande: d, accepter: false })}>
                  Refuser
                </button>
                <button type="button" className="btn-accent min-h-[48px]" onClick={() => setDecision({ demande: d, accepter: true })}>
                  Accepter
                </button>
              </li>
            ))}
          </ul>
        </div>
      }
    />
  );
}
