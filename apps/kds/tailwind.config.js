/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/shared-ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        fond: 'var(--fond-page)',
        surface: 'var(--surface-carte)',
        'surface-douce': 'var(--surface-douce)',
        'surface-moyenne': 'var(--surface-moyenne)',
        'surface-haute': 'var(--surface-haute)',
        'surface-tres-haute': 'var(--surface-tres-haute)',
        bordure: 'var(--bordure)',
        'bordure-forte': 'var(--bordure-forte)',
        fort: 'var(--texte-fort)',
        doux: 'var(--texte-doux)',
        faible: 'var(--texte-faible)',
        marque: 'var(--marque)',
        'marque-fonce': 'var(--marque-foncee)',
        'marque-tint': 'var(--marque-tint)',
        'marque-vif': 'var(--marque-vif)',
        'sur-marque': 'var(--sur-marque)',
        ok: 'var(--ok)',
        'ok-tint': 'var(--ok-tint)',
        alerte: 'var(--alerte)',
        'alerte-tint': 'var(--alerte-tint)',
        info: 'var(--info)',
        'info-tint': 'var(--info-tint)',
        accent: 'var(--marque)',
      },
      fontFamily: {
        sans: ['Work Sans Variable', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl: '1.5rem' },
      boxShadow: {
        e1: 'var(--ombre-1)',
        e2: 'var(--ombre-2)',
        e3: 'var(--ombre-3)',
      },
    },
  },
  plugins: [],
};
