import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useCaisse } from '../stores/session';

interface Presence {
  id: string;
  nom: string;
  role: string;
  methode: string;
  arrivee: string;
  depart: string | null;
  depart_oublie: boolean;
  en_poste: boolean;
}

const heure = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Présences du jour (§7 A4) — manager : qui est là, depuis quand. */
export function PresencesJour() {
  const { session } = useCaisse();
  const { data } = useQuery({
    queryKey: ['presences'],
    queryFn: () => api<Presence[]>('/api/pointage/presences'),
    enabled: !!session,
    refetchInterval: 60_000,
  });

  return (
    <div className="carte p-4 lg:col-span-3">
      <h2 className="mb-2 font-bold">Présences du jour</h2>
      {(data ?? []).length === 0 && <div className="text-sm text-doux">Aucun pointage aujourd’hui.</div>}
      <div className="space-y-1 text-sm">
        {(data ?? []).map((p) => (
          <div key={p.id} className="flex items-center justify-between">
            <span>
              <span className="font-semibold">{p.nom}</span>
              {p.en_poste ? (
                <span className="ml-2 rounded-full bg-ok-tint px-2 py-0.5 text-xs text-ok">en poste depuis {heure(p.arrivee)}</span>
              ) : (
                <span className="ml-2 text-doux">{heure(p.arrivee)} → {p.depart ? heure(p.depart) : '—'}</span>
              )}
            </span>
            {p.depart_oublie && <span className="rounded-full bg-alerte-tint px-2 py-0.5 text-xs text-alerte">départ oublié</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
