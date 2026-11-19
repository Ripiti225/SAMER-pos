/**
 * Réglages › Pointage par téléphone (2026-11-19). Les employés pointent avec
 * leur propre téléphone, connecté au wifi du restaurant, PIN + selfie.
 * Avec ou sans pointeuse : le premier pointage gagne.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface VueTelephone {
  actif: boolean;
  url: string | null;
  qr: string | null;
  telephones: { utilisateur_id: string; nom_complet: string; libelle: string | null; cree_le: string }[];
}

const CLE = ['admin', 'pointage-telephone'] as const;

export function PointageTelephone() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok: boolean } | null>(null);
  const { data } = useQuery({ queryKey: CLE, queryFn: () => api<VueTelephone>('/api/admin/pointage-telephone') });

  const basculer = useMutation({
    mutationFn: (actif: boolean) => api<{ actif: boolean }>('/api/admin/pointage-telephone', { method: 'PUT', corps: { actif } }),
    onSuccess: (r) => {
      setMsg({ texte: r.actif ? 'Pointage par téléphone activé' : 'Pointage par téléphone désactivé', ok: true });
      void qc.invalidateQueries({ queryKey: CLE });
    },
    onError: (e: Error) => setMsg({ texte: e.message, ok: false }),
  });

  if (!data) return <p className="text-doux">Chargement…</p>;

  return (
    <section className="max-w-3xl">
      <h2 className="mb-4 text-xl font-bold">Pointage par téléphone</h2>
      {msg && (
        <div className={`mb-4 rounded-jeton px-4 py-3 ${msg.ok ? 'bg-ok-tint text-ok-txt' : 'bg-alerte-tint text-alerte-txt'}`}>{msg.texte}</div>
      )}
      <p className="mb-4 text-sm text-doux">
        Chaque employé pointe son arrivée et son départ avec <b>son</b> téléphone, connecté au <b>wifi du restaurant</b>,
        avec son PIN et un selfie. Un téléphone ne sert qu’à une seule personne. Si la pointeuse est aussi en service,
        le premier pointage compte, l’autre est refusé.
      </p>

      <div className="mb-4 flex items-center justify-between gap-4 rounded-jeton border border-bordure bg-surface p-4">
        <div>
          <div className="font-semibold">{data.actif ? 'Activé' : 'Désactivé'}</div>
          <div className="text-sm text-doux">
            {data.actif ? 'Les employés peuvent pointer depuis leur téléphone.' : 'Les téléphones affichent « pas encore activé ».'}
          </div>
        </div>
        <button
          type="button"
          className={`${data.actif ? 'btn-blanc' : 'btn-accent'} min-h-[48px]`}
          disabled={basculer.isPending}
          onClick={() => basculer.mutate(!data.actif)}
        >
          {data.actif ? 'Désactiver' : 'Activer'}
        </button>
      </div>

      {data.actif && (
        <div className="mb-4 rounded-jeton border border-bordure bg-surface p-4">
          <div className="mb-2 font-semibold">Adresse à ouvrir sur les téléphones</div>
          {data.url ? (
            <div className="flex flex-wrap items-center gap-4">
              {data.qr && <img src={data.qr} alt="QR du pointage" className="h-40 w-40 rounded-jeton bg-white p-1" />}
              <div className="text-sm">
                <div className="mb-2 font-mono text-base">{data.url}</div>
                <ol className="list-decimal pl-5 text-doux">
                  <li>Se connecter au wifi du restaurant.</li>
                  <li>Scanner ce QR (ou taper l’adresse).</li>
                  <li>iPhone : « Partager › Sur l’écran d’accueil » pour garder le téléphone rattaché.</li>
                </ol>
              </div>
            </div>
          ) : (
            <p className="text-sm text-alerte-txt">Ce poste n’est sur aucun réseau : branchez-le au wifi du restaurant.</p>
          )}
        </div>
      )}

      <div className="rounded-jeton border border-bordure bg-surface p-4">
        <div className="mb-2 font-semibold">Téléphones rattachés ({data.telephones.length})</div>
        {data.telephones.length === 0 ? (
          <p className="text-sm text-doux">Aucun pour l’instant : un téléphone se rattache au premier pointage de l’employé.</p>
        ) : (
          <ul className="divide-y divide-bordure">
            {data.telephones.map((t) => (
              <li key={t.utilisateur_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="font-semibold">{t.nom_complet}</span>
                <span className="text-doux">
                  {t.libelle ?? 'Téléphone'} · depuis le {new Date(t.cree_le).toLocaleDateString('fr-FR')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-doux">
          Changement de téléphone : la demande apparaît sur l’accueil de la caisse, dans le bandeau de l’équipe (PIN manager).
        </p>
      </div>
    </section>
  );
}
