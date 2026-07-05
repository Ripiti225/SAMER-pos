import { useEffect, useState } from 'react';
import type { SessionInfo } from '@pos/shared';
import { api, ErreurApi } from '@pos/shared-ui';
import { LoginKds } from './screens/LoginKds';
import { Grille } from './screens/Grille';

const ROLES_KDS = ['CUISINE', 'MANAGER', 'PROPRIETAIRE'];

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [chargement, setChargement] = useState(true);

  // Session longue durée (§A5) : reprise au démarrage, pas de verrouillage
  // d'inactivité sur le KDS.
  useEffect(() => {
    api<SessionInfo>('/api/auth/moi')
      .then((s) => {
        if (ROLES_KDS.includes(s.utilisateur.role)) {
          document.documentElement.style.setProperty('--accent', s.restaurant.couleur_hex);
          setSession(s);
        }
      })
      .catch((e: unknown) => {
        if (!(e instanceof ErreurApi) || e.statusCode !== 401) console.warn(e);
      })
      .finally(() => setChargement(false));
  }, []);

  if (chargement) {
    return <div className="flex h-screen items-center justify-center text-2xl text-zinc-400">Démarrage du KDS…</div>;
  }
  if (!session) {
    return <LoginKds onConnecte={setSession} />;
  }
  return <Grille session={session} onDeconnexion={() => setSession(null)} />;
}
