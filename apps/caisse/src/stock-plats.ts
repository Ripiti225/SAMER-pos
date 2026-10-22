import { queryOptions } from '@tanstack/react-query';
import type { StockPlatsVue } from '@pos/shared';
import { INTERVALLE_STOCK_PLATS_MS } from '@pos/shared-ui';
import { api } from './api';

/**
 * Stock en cuisine de TOUS les plats, en une requête (sous la photo des
 * vignettes). Rafraîchi par WebSocket après chaque vente, envoi en cuisine ou
 * réception (`temps-reel.ts`), et toutes les minutes en filet de sécurité —
 * jamais recalculé par vignette.
 */
export const optionsStockPlats = queryOptions({
  queryKey: ['stock-plats'],
  queryFn: () => api<StockPlatsVue>('/api/stock-plats'),
  staleTime: 10_000,
  refetchInterval: INTERVALLE_STOCK_PLATS_MS,
});
