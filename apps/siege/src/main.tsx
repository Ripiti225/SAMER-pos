import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@pos/theme/theme.css';
import './index.css';

// Le mode d'affichage est un réglage du POSTE (cf. DESIGN_V2 § 3.3), posé avant
// le premier rendu pour éviter l'éclair blanc au chargement.
const mode = localStorage.getItem('siege.mode');
if (mode === 'sombre') document.documentElement.dataset.mode = 'sombre';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // Les chiffres du jour bougent en continu côté restaurants ; on rafraîchit
      // sans que personne ait à recharger la page.
      refetchInterval: 60_000,
      staleTime: 30_000,
    },
  },
});

createRoot(document.getElementById('racine')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
