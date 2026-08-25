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
    return <div className="flex h-full items-center justify-center text-doux">Démarrage…</div>;
  }
  if (!session) {
    return <LoginServeur onConnecte={setSession} />;
  }

  return (
    // Colonne pleine hauteur : l'écran actif prend la place restante, sans
    // hauteur codée en dur — indispensable sur téléphone (barres variables).
    <div className="flex h-full flex-col overflow-hidden" data-barre-basse={tableId ? '1' : '0'}>
      {/* Le nom du serveur connecté est affiché en permanence (§B5) */}
      <header className="marge-sure-cotes flex h-14 flex-none items-center gap-2 border-b border-bordure bg-surface px-2 shadow-e1 sm:h-14 sm:gap-3 sm:px-4">
        <span className="min-w-0 truncate font-bold text-marque-fonce">{session.restaurant.nom}</span>
        <span className="hidden min-w-0 truncate rounded-full bg-marque-tint px-3 py-1 text-sm font-semibold text-marque-fonce sm:inline">
          {session.utilisateur.nom_complet}
        </span>
        {/* Sur téléphone : prénom seul, la place manque pour le nom complet. */}
        <span className="min-w-0 truncate rounded-full bg-marque-tint px-2 py-1 text-sm font-semibold text-marque-fonce sm:hidden">
          {session.utilisateur.nom_complet.split(/\s+/)[0]}
        </span>
        {enAttente > 0 && (
          <span className="flex-none animate-pulse rounded-full bg-alerte-tint px-2 py-1 text-xs font-medium text-alerte sm:px-3 sm:text-sm">
            <span className="hidden sm:inline">En attente de connexion ({enAttente})</span>
            <span className="sm:hidden">⏳ {enAttente}</span>
          </span>
        )}
        <button
          type="button"
          title="Déconnexion"
          className="ml-auto flex h-11 w-11 flex-none items-center justify-center gap-2 rounded-[13px] bg-alerte/10 font-semibold text-alerte transition hover:bg-alerte/20 sm:h-auto sm:w-auto sm:px-4 sm:py-2"
          onClick={async () => {
            try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
            setSession(null);
            setTableId(null);
          }}
        >
          <span className="hidden sm:inline">Déconnexion</span>
          <span className="text-lg sm:hidden" aria-hidden>⏻</span>
          <span className="sr-only sm:hidden">Déconnexion</span>
        </button>
      </header>

      <main className="min-h-0 flex-1">
        {tableId ? (
          <PriseCommande tableId={tableId} onRetour={() => setTableId(null)} afficherToast={afficherToast} />
        ) : (
          <Salle onTable={setTableId} moiServeurId={session.utilisateur.id} afficherToast={afficherToast} />
        )}
      </main>

      <NotificationsServeur session={session} afficherToast={afficherToast} />

      <VerrouInactivite session={session} onDeconnexion={() => { setSession(null); setTableId(null); }} />

      {toast && (
        <div className="au-dessus-barre fixed left-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-xl border border-bordure bg-surface px-5 py-3 text-center text-base shadow-xl sm:text-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
