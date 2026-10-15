import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { IconCloudUpload, IconLogout } from '@tabler/icons-react';
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
    return <div className="flex h-full items-center justify-center bg-plan text-txt-doux">Démarrage…</div>;
  }
  if (!session) {
    return <LoginServeur onConnecte={setSession} />;
  }

  return (
    // Colonne pleine hauteur : l'écran actif prend la place restante, sans
    // hauteur codée en dur — indispensable sur téléphone (barres variables).
    <div className="flex h-full flex-col overflow-hidden bg-plan" data-barre-basse={tableId ? '1' : '0'}>
      {/* Ossature ardoise (DESIGN_V2 § 2) : le nom du serveur connecté reste
          affiché en permanence (§B5), sans aplat de couleur — la marque ne
          tient qu'au point devant le restaurant. */}
      <header className="marge-sure-cotes flex h-14 flex-none items-center gap-3 border-b border-ard-700 bg-ard-900 px-3 text-ard-txt sm:px-4">
        <span className="h-2.5 w-2.5 flex-none rounded-full bg-marque" />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[15px] font-bold">{session.restaurant.nom}</div>
          <div className="truncate text-xs font-medium text-ard-txt-doux">
            <span className="sm:hidden">{session.utilisateur.nom_complet.split(/\s+/)[0]}</span>
            <span className="hidden sm:inline">{session.utilisateur.nom_complet}</span>
          </div>
        </div>
        {enAttente > 0 && (
          <span
            className="flex flex-none items-center gap-1.5 rounded-full bg-attente px-2.5 py-1 text-xs font-bold text-white sm:text-sm"
            title="Actions en attente de connexion — elles partiront dès le retour du réseau"
          >
            <IconCloudUpload size={16} />
            <span className="hidden sm:inline">En attente de connexion</span> {enAttente}
          </span>
        )}
        <button
          type="button"
          title="Déconnexion"
          className="ml-auto flex h-11 flex-none items-center justify-center gap-2 rounded-btn px-3 font-semibold text-ard-txt-doux transition hover:bg-ard-750 hover:text-ard-txt"
          onClick={async () => {
            try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
            setSession(null);
            setTableId(null);
          }}
        >
          <IconLogout size={20} />
          <span className="hidden sm:inline">Déconnexion</span>
        </button>
      </header>

      <main className="min-h-0 flex-1">
        {tableId ? (
          <PriseCommande tableId={tableId} restaurant={session.restaurant.nom} marque={session.restaurant.marque} onRetour={() => setTableId(null)} afficherToast={afficherToast} />
        ) : (
          <Salle onTable={setTableId} moiServeurId={session.utilisateur.id} afficherToast={afficherToast} />
        )}
      </main>

      <NotificationsServeur session={session} afficherToast={afficherToast} />

      <VerrouInactivite session={session} onDeconnexion={() => { setSession(null); setTableId(null); }} />

      {toast && (
        <div className="au-dessus-barre fixed left-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-jeton bg-ard-800 px-5 py-3 text-center text-[15px] font-medium text-ard-txt shadow-ard">
          {toast}
        </div>
      )}
    </div>
  );
}
