import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { TableClientVue } from '@pos/shared';
import { api } from './api';
import { PageTable } from './screens/PageTable';

/** Le qr_token est le dernier segment de l'URL /t/:qr_token. */
function lireJeton(): string | null {
  const m = location.pathname.match(/\/t\/([^/]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function App() {
  const jeton = lireJeton();

  const { data, error, isLoading } = useQuery({
    queryKey: ['table', jeton],
    queryFn: () => api<TableClientVue>(`/api/client/${jeton}`),
    enabled: !!jeton,
  });

  useEffect(() => {
    if (data) {
      document.documentElement.dataset.marque = data.restaurant.marque;
      document.documentElement.style.setProperty('--marque', data.restaurant.couleur_hex);
    }
  }, [data]);

  if (!jeton) {
    return (
      <Centre>
        <p className="text-lg text-doux">Scannez le QR collé sur votre table pour commencer.</p>
      </Centre>
    );
  }
  if (isLoading) return <Centre><p className="text-doux">Chargement…</p></Centre>;
  if (error || !data) {
    return (
      <Centre>
        <p className="text-lg text-alerte">Cette table est introuvable. Appelez un serveur.</p>
      </Centre>
    );
  }
  return <PageTable jeton={jeton} table={data} />;
}

function Centre({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-fond p-8 text-center text-fort">
      {children}
    </div>
  );
}
