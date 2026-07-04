import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SessionInfo } from '@pos/shared';
import { api, ErreurApi } from './api';
import { VerrouInactivite } from './components/VerrouInactivite';
import { Accueil } from './screens/Accueil';
import { Cloture } from './screens/Cloture';
import { Commande } from './screens/Commande';
import { Login } from './screens/Login';
import { MesVentes } from './screens/MesVentes';
import { OuvertureService } from './screens/OuvertureService';
import { Paiement } from './screens/Paiement';
import { Tables } from './screens/Tables';
import { useCaisse } from './stores/session';
import { connecterTempsReel } from './temps-reel';

export function App() {
  const { session, ecran, toast, poserSession } = useCaisse();
  const [chargement, setChargement] = useState(true);
  const queryClient = useQueryClient();

  // Reprise de session au démarrage (cookie httpOnly côté serveur)
  useEffect(() => {
    api<SessionInfo>('/api/auth/moi')
      .then(poserSession)
      .catch((e: unknown) => {
        if (!(e instanceof ErreurApi) || e.statusCode !== 401) {
          console.warn('Session non reprise :', e);
        }
      })
      .finally(() => setChargement(false));
  }, [poserSession]);

  useEffect(() => connecterTempsReel(queryClient), [queryClient]);

  if (chargement) {
    return <div className="flex h-screen items-center justify-center text-zinc-400">Démarrage de la caisse…</div>;
  }

  let contenu: JSX.Element;
  if (!session) {
    contenu = <Login />;
  } else if (!session.service_ouvert && ecran !== 'cloture') {
    // Pas de vente possible sans fond de caisse saisi
    contenu = <OuvertureService />;
  } else {
    contenu = {
      accueil: <Accueil />,
      commande: <Commande />,
      paiement: <Paiement />,
      tables: <Tables />,
      'mes-ventes': <MesVentes />,
      cloture: <Cloture />,
    }[ecran];
  }

  return (
    <div className="h-full">
      {contenu}
      <VerrouInactivite />
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-xl bg-zinc-800 px-5 py-3 text-lg shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
