import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { CatalogueVue } from '@pos/shared';
import { api } from './api';

const UN_JOUR = 24 * 60 * 60 * 1000;

/**
 * Le catalogue change par événements WebSocket. Entre deux événements, le
 * garder chaud évite une requête et un écran d'attente à chaque nouvelle note.
 */
export const optionsCatalogue = queryOptions({
  queryKey: ['catalogue'],
  queryFn: () => api<CatalogueVue>('/api/catalogue'),
  staleTime: UN_JOUR,
  gcTime: UN_JOUR,
});

export function urlsImagesCatalogue(catalogue: CatalogueVue): string[] {
  return [...new Set(catalogue.articles.flatMap((article) => article.image_url ? [article.image_url] : []))];
}

/** Charge le JSON et amorce le cache navigateur/PWA sans ralentir la connexion. */
export async function prechargerCatalogue(queryClient: QueryClient): Promise<void> {
  const catalogue = await queryClient.ensureQueryData(optionsCatalogue);
  for (const url of urlsImagesCatalogue(catalogue)) {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
  }
}
