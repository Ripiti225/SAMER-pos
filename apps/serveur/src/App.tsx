import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SessionInfo } from '@pos/shared';
import { api, ErreurApi } from '@pos/shared-ui';
import { fileAttente } from './file-attente';
import { LoginServeur } from './screens/LoginServeur';
import { Salle } from './screens/Salle';
import { PriseCommande } from './screens/PriseCommande';
import { VerrouInactivite } from './components/VerrouInactivite';
import { NotificationsServeur } from './components/NotificationsServeur';

const ROLES_SALLE = ['SERVEUR', 'MANAGER', 'PROPRIETAIRE'];

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [chargement, setChargement] = useState(true);
  const [tableId, setTableId] = useState<string | null>(null);
  const [enAttente, setEnAttente] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const afficherToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    api<SessionInfo>('/api/auth/moi')
      .then((s) => {
        if (ROLES_SALLE.includes(s.utilisateur.role)) {
          document.documentElement.dataset.marque = s.restaurant.marque;
          document.documentElement.style.setProperty('--marque', s.restaurant.couleur_hex);
          setSession(s);
        }
      })
      .catch((e: unknown) => {
        if (!(e instanceof ErreurApi) || e.statusCode !== 401) console.warn(e);
      })
      .finally(() => setChargement(false));
  }, []);

  // Pastille « En attente de connexion » + rafraîchissement après rejeu (§B4)
  useEffect(() => fileAttente.souscrire(setEnAttente), []);
  useEffect(() => {
    fileAttente.onResultat = (_action, ok, erreur) => {
      void queryClient.invalidateQueries({ queryKey: ['tables'] });
      void queryClient.invalidateQueries({ queryKey: ['commande'] });
      if (!ok && erreur) afficherToast(erreur);
    };
    return () => {
      fileAttente.onResultat = null;
    };
  }, [queryClient]);

  if (chargement) {
    return <div className="flex h-screen items-center justify-center text-doux">Démarrage…</div>;
  }
  if (!session) {
    return <LoginServeur onConnecte={setSession} />;
  }

  return (
    <div className="h-full">
      {/* Le nom du serveur connecté est affiché en permanence (§B5) */}
      <header className="flex items-center gap-3 border-b border-bordure px-4 py-2">
        <span className="font-black text-marque-fonce">{session.restaurant.nom}</span>
        <span className="rounded-full border border-bordure bg-surface px-3 py-1 text-sm font-semibold">
          {session.utilisateur.nom_complet}
        </span>
        {enAttente > 0 && (
          <span className="animate-pulse rounded-full bg-alerte-tint px-3 py-1 text-sm text-alerte">
            En attente de connexion ({enAttente})
          </span>
        )}
        <button
          type="button"
          className="btn-blanc ml-auto"
          onClick={async () => {
            try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
            setSession(null);
            setTableId(null);
          }}
        >
          Se déconnecter
        </button>
      </header>

      {tableId ? (
        <PriseCommande tableId={tableId} onRetour={() => setTableId(null)} afficherToast={afficherToast} />
      ) : (
        <Salle onTable={setTableId} moiServeurId={session.utilisateur.id} afficherToast={afficherToast} />
      )}

      <NotificationsServeur session={session} afficherToast={afficherToast} />

      <VerrouInactivite session={session} onDeconnexion={() => { setSession(null); setTableId(null); }} />

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-xl border border-bordure bg-surface px-5 py-3 text-lg shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
