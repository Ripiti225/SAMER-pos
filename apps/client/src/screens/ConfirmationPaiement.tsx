import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { SuiviCommandeClient } from '@pos/shared';
import { formatFCFA } from '@pos/shared';
import { api } from '../api';

/**
 * Écran de fin de repas : dès que la caisse encaisse, le téléphone du client
 * l'annonce, chiffre ses points et lui donne son reçu PDF.
 *
 * C'est aussi le dernier moment utile pour lui montrer ce qu'il perd quand il
 * n'a pas laissé son numéro — le reçu, lui, reste offert dans les deux cas.
 */
export function ConfirmationPaiement({ jeton }: { jeton: string }) {
  const [ecartees, setEcartees] = useState<string[]>([]);

  // Même clé que SuiviCommandes : TanStack Query mutualise la requête.
  const { data } = useQuery({
    queryKey: ['suivi', jeton],
    queryFn: () => api<SuiviCommandeClient[]>(`/api/client/${jeton}/commandes`),
    refetchInterval: 10_000,
  });

  const payee = (data ?? []).find((c) => c.etat === 'PAYEE' && !ecartees.includes(c.id));
  if (!payee) return null;

  const { points, rattache } = payee.fidelite;
  const pluriel = points > 1 ? 's' : '';

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-fort/60 p-4 sm:items-center">
      <div className="carte w-full max-w-sm space-y-4 p-6 text-center shadow-e3">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-ok/15 text-3xl text-ok">
          ✓
        </div>

        <div>
          <div className="text-doux">Vous venez de payer</div>
          <div className="prix text-4xl font-black tabular-nums text-marque-fonce">
            {formatFCFA(payee.total)}
          </div>
        </div>

        {rattache ? (
          <div className="rounded-[13px] bg-marque-tint px-4 py-3">
            <div className="text-xl font-bold text-marque-fonce">
              + {points} point{pluriel} de fidélité
            </div>
            {/* Pas de promesse « visibles dans l'app Samer Delly » tant que la
                fusion clients côté cloud n'est pas livrée (voir BACKLOG_V2). */}
            <div className="text-sm text-doux">Ajoutés à votre compte fidélité.</div>
          </div>
        ) : (
          <div className="rounded-[13px] bg-surface-haute px-4 py-3">
            <div className="text-lg font-bold">
              {points} point{pluriel} non crédité{pluriel}
            </div>
            <div className="text-sm text-doux">
              Laissez votre numéro à la prochaine commande pour les cumuler.
            </div>
          </div>
        )}

        {/* Le serveur renvoie le PDF en pièce jointe : un lien suffit, aucun
            code de téléchargement à écrire côté téléphone. */}
        <a
          href={`/api/client/${jeton}/recu/${payee.id}`}
          target="_blank"
          rel="noopener"
          className="flex min-h-[56px] w-full items-center justify-center rounded-[13px] bg-marque text-lg font-bold text-sur-marque shadow-e2 transition active:translate-y-px"
        >
          Continuer · reçu PDF
        </a>
        <button
          type="button"
          className="text-sm font-medium text-doux underline"
          onClick={() => setEcartees((l) => [...l, payee.id])}
        >
          Fermer sans reçu
        </button>
      </div>
    </div>
  );
}
