import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { GardeErreur } from './components/GardeErreur';
import { deverrouillerSon } from './sonnerie';
import '@pos/theme/theme.css';
import './index.css';

// Le son « commande prête » doit être débloqué par un premier toucher.
deverrouillerSon();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('racine')!).render(
  <StrictMode>
    <GardeErreur enfants={
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    } />
  </StrictMode>,
);
