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
        name: 'KDS Cuisine — Chez Samer / Al Kayan',
        short_name: 'KDS Cuisine',
        description: 'Écran cuisine — réseau local du restaurant',
        lang: 'fr',
        display: 'fullscreen',
        // Suit l'appareil : debout ou couché, l'écran se réorganise (onglets / colonnes).
        orientation: 'any',
        background_color: '#10151d',
        theme_color: '#EF9F27',
        icons: [
          { src: 'icone.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icone.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
      },
    }),
  ],
  server: {
    port: 5174,
    host: true,
    proxy: {
      '/api': { target: `http://localhost:${API}`, changeOrigin: false },
      '/ws': { target: `ws://localhost:${API}`, ws: true },
    },
  },
});
