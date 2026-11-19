import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Port du serveur POS local. 3001 par défaut ; API_PORT permet de lancer une
// seconde instance (démo, essais) sans toucher à celle qui tourne déjà.
const API = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Caisse Chez Samer / Al Kayan',
        short_name: 'Caisse POS',
        description: 'Caisse offline-first — réseau local du restaurant',
        lang: 'fr',
        display: 'standalone',
        background_color: '#09090b',
        theme_color: '#EF9F27',
        icons: [
          { src: 'icone.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icone.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        // Le shell de l'app est mis en cache ; les données passent toujours par l'API locale
        // /pointage.html est une page à part (téléphones des employés).
        navigateFallbackDenylist: [/^\/api/, /^\/ws/, /^\/pointage/],
        // Les photos viennent de SamerTrackly/Supabase. Une fois vues sur un
        // poste, elles doivent rester disponibles immédiatement sur le LAN,
        // même si internet disparaît ou si un autre caissier se connecte.
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'pos-photos-v1',
              cacheableResponse: { statuses: [0, 200] },
              expiration: {
                maxEntries: 500,
                maxAgeSeconds: 60 * 60 * 24 * 90,
                purgeOnQuotaError: true,
              },
            },
          },
        ],
      },
    }),
  ],
  // Deux pages : la caisse et le pointage par téléphone (2026-11-19), servies
  // toutes deux par le mini-PC sur le port 3001.
  build: {
    rollupOptions: {
      input: {
        caisse: fileURLToPath(new URL('./index.html', import.meta.url)),
        pointage: fileURLToPath(new URL('./pointage.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: `http://localhost:${API}`, changeOrigin: false },
      '/ws': { target: `ws://localhost:${API}`, ws: true },
    },
  },
});
