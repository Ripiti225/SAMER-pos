import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { SessionInfo, UtilisateurPublic } from '@pos/shared';
import { api } from '../api';
import { Numpad } from '../components/Numpad';
import { useCaisse } from '../stores/session';

const LIBELLES_ROLES: Record<string, string> = {
  PROPRIETAIRE: 'Propriétaire',
  MANAGER: 'Manager',
  CAISSIER: 'Caissier',
  SERVEUR: 'Serveur',
  CUISINE: 'Cuisine',
};

export function Login() {
  const { poserSession, afficherToast } = useCaisse();
  const [choisi, setChoisi] = useState<UtilisateurPublic | null>(null);
  const [pin, setPin] = useState('');
  const [enCours, setEnCours] = useState(false);

  const { data: utilisateurs } = useQuery({
    queryKey: ['utilisateurs-login'],
    queryFn: () => api<UtilisateurPublic[]>('/api/auth/utilisateurs'),
  });

  const seConnecter = async () => {
    if (!choisi) return;
    setEnCours(true);
    try {
      const session = await api<SessionInfo>('/api/auth/login', {
        method: 'POST',
        corps: { utilisateur_id: choisi.id, pin },
      });
      poserSession(session);
    } catch (e) {
      afficherToast((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-4xl font-black text-accent">Chez Samer / Al Kayan</h1>
        <p className="mt-2 text-zinc-400">Caisse — connexion par PIN</p>
      </div>

      {!choisi ? (
        <div className="grid w-full max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3">
          {(utilisateurs ?? []).map((u) => (
            <button key={u.id} type="button" className="carte min-h-[80px] p-4 text-left hover:border-accent" onClick={() => setChoisi(u)}>
              <div className="font-bold">{u.nom_complet}</div>
              <div className="text-sm text-zinc-400">{LIBELLES_ROLES[u.role] ?? u.role}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="w-full max-w-xs space-y-3">
          <div className="text-center text-lg font-semibold">{choisi.nom_complet}</div>
          <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
            {'•'.repeat(pin.length) || <span className="text-base tracking-normal text-zinc-500">PIN</span>}
          </div>
          <Numpad
            valeur={pin}
            onChange={setPin}
            longueurMax={6}
            onValider={seConnecter}
            libelleValider={enCours ? 'Connexion…' : 'Se connecter'}
            validerDesactive={pin.length < 4 || enCours}
          />
          <button type="button" className="btn-sombre w-full" onClick={() => { setChoisi(null); setPin(''); }}>
            ← Changer d’utilisateur
          </button>
        </div>
      )}
    </div>
  );
}
