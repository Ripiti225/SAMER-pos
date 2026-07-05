/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/shared-ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Jetons du thème clair partagé (packages/theme/theme.css)
        fond: 'var(--fond-page)',
        surface: 'var(--surface-carte)',
        bordure: 'var(--bordure)',
        fort: 'var(--texte-fort)',
        doux: 'var(--texte-doux)',
        marque: 'var(--marque)',
        'marque-fonce': 'var(--marque-foncee)',
        'marque-tint': 'var(--marque-tint)',
        ok: 'var(--ok)',
        'ok-tint': 'var(--ok-tint)',
        alerte: 'var(--alerte)',
        'alerte-tint': 'var(--alerte-tint)',
        info: 'var(--info)',
        'info-tint': 'var(--info-tint)',
        accent: 'var(--marque)',
      },
    },
  },
  plugins: [],
};
