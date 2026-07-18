import { useQuery } from '@tanstack/react-query';
import type { EtatSuiviClient, SuiviCommandeClient } from '@pos/shared';
import { formatFCFA, LIBELLES_SUIVI_CLIENT } from '@pos/shared';
import { api } from '../api';

// Étapes visuelles (jauge) du parcours normal d'une commande.
const ETAPES: EtatSuiviClient[] = ['EN_VALIDATION', 'EN_PREPARATION', 'PRETE', 'SERVIE'];

/**
 * « Votre commande » (point 1c) : suivi en temps réel par polling léger
 * (10 s) — pas de WebSocket côté client (port restreint, § RESEAU).
 */
export function SuiviCommandes({ jeton }: { jeton: string }) {
  const { data } = useQuery({
    queryKey: ['suivi', jeton],
    queryFn: () => api<SuiviCommandeClient[]>(`/api/client/${jeton}/commandes`),
    refetchInterval: 10_000,
  });

  if (!data || data.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold">Votre commande</h2>
      {data.map((c) => (
        <div key={c.id} className="carte p-4 shadow-e1">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm text-doux">Ticket n° {c.numero_ticket}</span>
            <span className="prix font-bold tabular-nums">{formatFCFA(c.total)}</span>
          </div>

          {c.etat === 'REFUSEE' ? (
            <div className="rounded-[13px] bg-alerte-tint px-3 py-2 text-alerte">
              <div className="font-bold">Commande refusée</div>
              {c.refus_motif && <div className="text-sm">{c.refus_motif}</div>}
            </div>
          ) : (
            <Jauge etat={c.etat} />
          )}

          {c.articles.length > 0 && (
            <div className="mt-2 text-sm text-doux">
              {c.articles.map((a) => `${a.quantite} × ${a.nom}`).join(', ')}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function Jauge({ etat }: { etat: EtatSuiviClient }) {
  const indexActuel = ETAPES.indexOf(etat);
  return (
    <div className="flex items-center gap-1">
      {ETAPES.map((e, i) => {
        const atteint = indexActuel >= 0 && i <= indexActuel;
        return (
          <div key={e} className="flex flex-1 flex-col items-center gap-1">
            <div className={`h-2.5 w-full rounded-full transition ${atteint ? 'bg-ok' : 'bg-surface-tres-haute'}`} />
            <span className={`text-[11px] ${i === indexActuel ? 'font-bold text-ok' : 'text-doux'}`}>
              {LIBELLES_SUIVI_CLIENT[e]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
