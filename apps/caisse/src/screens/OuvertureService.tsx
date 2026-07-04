import { useState } from 'react';
import type { ServiceOuvertVue } from '@pos/shared';
import { formatFCFA } from '@pos/shared';
import { api } from '../api';
import { Numpad } from '../components/Numpad';
import { useCaisse } from '../stores/session';

/** Ouverture de service : saisie du fond de caisse avant toute vente. */
export function OuvertureService() {
  const { session, poserServiceOuvert, poserSession, afficherToast } = useCaisse();
  const [montant, setMontant] = useState('');
  const [enCours, setEnCours] = useState(false);

  const ouvrir = async () => {
    setEnCours(true);
    try {
      const service = await api<ServiceOuvertVue>('/api/services/ouvrir', {
        method: 'POST',
        corps: { fond_de_caisse: Number(montant || '0') },
      });
      poserServiceOuvert(service);
    } catch (e) {
      afficherToast((e as Error).message);
    } finally {
      setEnCours(false);
    }
  };

  const seDeconnecter = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    poserSession(null);
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold">Ouverture de service</h1>
        <p className="mt-1 text-zinc-400">
          {session?.utilisateur.nom_complet} — comptez le fond de caisse et saisissez le montant
        </p>
      </div>
      <div className="w-full max-w-xs space-y-3">
        <div className="champ flex items-center justify-center text-3xl font-bold">
          {montant ? formatFCFA(Number(montant)) : <span className="text-base font-normal text-zinc-500">Fond de caisse…</span>}
        </div>
        <Numpad
          valeur={montant}
          onChange={setMontant}
          onValider={ouvrir}
          libelleValider={enCours ? 'Ouverture…' : 'Ouvrir le service'}
          validerDesactive={montant === '' || enCours}
        />
        <button type="button" className="btn-sombre w-full" onClick={seDeconnecter}>
          Se déconnecter
        </button>
      </div>
    </div>
  );
}
