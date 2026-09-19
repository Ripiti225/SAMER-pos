import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { TableClientVue } from '@pos/shared';
import { api } from './api';
import { PageTable } from './screens/PageTable';
import { lireVisite, memoriserVisite, positionActuelle } from './visite';

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
    // Point 4 : l'état de table reste synchronisé côté client (polling léger).
    refetchInterval: 10_000,
  });

  const visite = useQuery({
    queryKey: ['visite-client', jeton],
    enabled: !!jeton && !!data,
    retry: false,
    queryFn: async () => {
      const localisation = await positionActuelle(data!.geolocalisation.requise);
      const reprise = lireVisite(jeton!);
      const resultat = await api<{ visite_id: string; expire_le: string }>(
        `/api/client/${jeton}/visite`,
        {
          method: 'POST',
          corps: localisation ? { localisation } : {},
          visiteId: reprise ?? undefined,
        },
      );
      memoriserVisite(jeton!, resultat.visite_id);
      return resultat.visite_id;
    },
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
  if (visite.isLoading) {
    return <Centre><p className="text-doux">Vérification de votre présence au restaurant…</p></Centre>;
  }
  if (visite.error || !visite.data) {
    return (
      <Centre>
        <div>
          <p className="text-lg font-semibold text-alerte">Impossible d’ouvrir cette table.</p>
          <p className="mt-2 text-doux">{visite.error?.message ?? 'Rescannez le QR ou appelez un serveur.'}</p>
        </div>
      </Centre>
    );
  }
  return <PageTable jeton={jeton} table={data} visiteId={visite.data} />;
}

function Centre({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-fond p-8 text-center text-fort">
      {children}
    </div>
  );
}
