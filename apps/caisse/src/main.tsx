import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@pos/theme/theme.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Ajustement à l'écran (2026-10-26). Les écrans de la caisse sont dessinés
 * pour 1024 × 768 au minimum. Un portable en 1920 × 1080 zoomé à 175 % par
 * Windows n'offre que 1097 × 617 : le paiement s'y écrasait (pavé et cases
 * les uns sur les autres). En dessous de cette taille, toute la caisse est
 * réduite d'un bloc, proportions gardées ; au-dessus, rien ne change.
 *
 * `zoom` sur #racine et non sur <html> : posé sur la racine, `height: 100%`
 * remplit encore l'écran. Seul `100vh` ne suit pas — voir `.h-screen` dans
 * index.css, qui lit `--echelle`.
 */
const LARGEUR_CONCUE = 1024;
const HAUTEUR_CONCUE = 768;
const ECHELLE_MIN = 0.6; // en deçà, le texte devient illisible : mieux vaut défiler

function ajusterALEcran(): void {
  const echelle = Math.max(
    ECHELLE_MIN,
    Math.min(1, window.innerWidth / LARGEUR_CONCUE, window.innerHeight / HAUTEUR_CONCUE),
  );
  document.getElementById('racine')!.style.zoom = echelle === 1 ? '' : String(echelle);
  document.documentElement.style.setProperty('--echelle', String(echelle));
}
ajusterALEcran();
window.addEventListener('resize', ajusterALEcran);

createRoot(document.getElementById('racine')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
