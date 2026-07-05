import { useState } from 'react';
import type { CommandeVue } from '@pos/shared';
import { formatFCFA } from '@pos/shared';
import { api } from '../api';
import { useCaisse } from '../stores/session';

interface SoldeRep {
  existe: boolean;
  solde: number;
  bareme: { valeur_point_fcfa: number; seuil_utilisation: number };
}

/**
 * Fidélité au paiement (§9) : saisie du téléphone, affichage du solde,
 * utilisation des points en remise (droit du client, sans PIN manager).
 */
export function Fidelite({ commande, onMaj }: { commande: CommandeVue; onMaj: (vue: CommandeVue) => void }) {
  const { afficherToast } = useCaisse();
  const [ouvert, setOuvert] = useState(false);
  const [telephone, setTelephone] = useState('');
  const [solde, setSolde] = useState<SoldeRep | null>(null);

  const chercher = async () => {
    try {
      const r = await api<SoldeRep>(`/api/fidelite/${encodeURIComponent(telephone)}`);
      setSolde(r);
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  const rattacher = async (utiliser?: number) => {
    try {
      const r = await api<{ commande: CommandeVue; solde: number }>(`/api/commandes/${commande.id}/fidelite`, {
        method: 'POST',
        corps: { telephone, utiliser_points: utiliser },
      });
      onMaj(r.commande);
      setSolde((s) => (s ? { ...s, existe: true, solde: r.solde } : s));
      afficherToast(utiliser ? 'Points utilisés' : 'Client fidélité rattaché');
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  if (!ouvert) {
    return (
      <button type="button" className="btn-blanc mb-4 w-full" onClick={() => setOuvert(true)}>
        {commande.client_fidelite_id ? 'Client fidélité rattaché ✓' : 'Client fidélité'}
      </button>
    );
  }

  const points = solde?.solde ?? 0;
  const seuil = solde?.bareme.seuil_utilisation ?? 50;
  const valeurUtilisation = points * (solde?.bareme.valeur_point_fcfa ?? 10);

  return (
    <div className="carte mb-4 p-4">
      <div className="flex gap-2">
        <input className="champ flex-1" inputMode="tel" placeholder="Téléphone du client" value={telephone} onChange={(e) => setTelephone(e.target.value)} />
        <button type="button" className="btn-blanc px-4" onClick={chercher} disabled={telephone.length < 6}>Chercher</button>
      </div>
      {solde && (
        <div className="mt-3 space-y-2 text-sm">
          <div>
            {solde.existe ? (
              <>Solde : <span className="font-bold">{points} points</span> ({formatFCFA(valeurUtilisation)})</>
            ) : (
              'Nouveau client — sera créé au rattachement'
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-ok flex-1" onClick={() => rattacher()}>Rattacher (crédit)</button>
            {solde.existe && points >= seuil && (
              <button type="button" className="btn-accent flex-1" onClick={() => rattacher(points)}>
                Utiliser {points} pts = {formatFCFA(valeurUtilisation)}
              </button>
            )}
          </div>
          {commande.fidelite_montant > 0 && (
            <div className="text-ok">Remise fidélité appliquée : −{formatFCFA(commande.fidelite_montant)}</div>
          )}
        </div>
      )}
    </div>
  );
}
