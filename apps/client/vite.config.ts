import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Chez Samer / Al Kayan — Table',
        short_name: 'Ma table',
        description: 'Appeler le serveur, commander, suivre sa commande',
        lang: 'fr',
        display: 'standalone',
        background_color: '#F7F5F0',
        theme_color: '#EF9F27',
        icons: [
          { src: 'icone.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icone.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: { navigateFallbackDenylist: [/^\/api/] },
    }),
  ],
  server: {
    port: 5176,
    host: true,
    // Le client n'utilise PAS de WebSocket (port restreint, § RESEAU) : polling léger.
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: false },
    },
  },
});
