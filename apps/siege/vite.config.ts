import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// La console du siège n'est PAS une PWA : contrairement à la caisse, elle n'a
// aucun intérêt hors ligne (toutes ses données viennent du cloud) et elle
// tourne sur un poste de bureau, pas sur un kiosque. Pas de service worker
// donc, et pas de cache à purger.
export default defineConfig({
  plugins: [react()],
  server: {
    // 5180 : la caisse occupe 5173 sur ce poste, on ne se marche pas dessus.
    port: 5180,
    host: true,
  },
});
