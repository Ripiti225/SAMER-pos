/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/shared-ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Accent de marque : orange Chez Samer par défaut, le rebranding
        // Al Kayan lit restaurant.couleur_hex via la variable CSS --accent.
        accent: 'var(--accent)',
      },
    },
  },
  plugins: [],
};
