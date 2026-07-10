import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SessionInfo } from '@pos/shared';
import { api, ErreurApi } from './api';
import { BandeauAdditions } from './components/BandeauAdditions';
import { NotificationsCaisse } from './components/NotificationsCaisse';
import { VerrouInactivite } from './components/VerrouInactivite';
import { Accueil } from './screens/Accueil';
import { Cloture } from './screens/Cloture';
import { Commande } from './screens/Commande';
import { Login } from './screens/Login';
import { MesVentes } from './screens/MesVentes';
import { OuvertureService } from './screens/OuvertureService';
import { Paiement } from './screens/Paiement';
import { Reglages } from './screens/Reglages';
import { Supervision } from './screens/Supervision';
import { Tables } from './screens/Tables';
import { useCaisse, type Ecran } from './stores/session';
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
    return <div className="flex h-screen items-center justify-center text-doux">Démarrage de la caisse…</div>;
  }

  // Seuls les encaisseurs (permission caisse.encaisser) ont besoin d'un fond de
  // caisse : le superviseur sur son tableau de bord et le serveur qui prend des
  // commandes ne sont jamais bloqués par l'écran d'ouverture de service.
  const doitEncaisser = !!session?.permissions.includes('caisse.encaisser');
  const ecransSansService: Ecran[] = ['supervision', 'cloture', 'reglages'];

  let contenu: JSX.Element;
  if (!session) {
    contenu = <Login />;
  } else if (doitEncaisser && !session.service_ouvert && !ecransSansService.includes(ecran)) {
    // Pas de vente possible sans fond de caisse saisi (mais Supervision/Réglages restent ouverts)
    contenu = <OuvertureService />;
  } else {
    contenu = {
      supervision: <Supervision />,
      accueil: <Accueil />,
      commande: <Commande />,
      paiement: <Paiement />,
      tables: <Tables />,
      'mes-ventes': <MesVentes />,
      cloture: <Cloture />,
      reglages: <Reglages />,
    }[ecran];
  }

  return (
    <div className="h-full">
      {contenu}
      <BandeauAdditions />
      {session && <NotificationsCaisse />}
      <VerrouInactivite />
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-xl border border-bordure bg-surface px-5 py-3 text-lg shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
