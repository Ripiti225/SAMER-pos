import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// La console n'est PAS une PWA : elle se regarde depuis un bureau connecté,
// aucun intérêt hors ligne — donc aucun service worker, et donc aucun cache à
// purger. Le piège du kiosque (une version figée dans le worker) ne s'applique
// pas ici, contrairement à la caisse.
export default defineConfig({
  plugins: [react()],
  // 5180 : la caisse tient déjà le 5173.
  server: { port: 5180, host: true },
});
