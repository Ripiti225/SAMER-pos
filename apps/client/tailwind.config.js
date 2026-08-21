/** @type {import('tailwindcss').Config} */
/* Jetons « Duo contrasté » — voir docs/DESIGN_V2.md § 3.
   Les noms `fond`, `surface*`, `bordure`, `fort`… sont conservés : ils pointent
   sur les alias de compatibilité de packages/theme/theme.css, le temps que tous
   les écrans passent aux jetons neufs (plan / carte / filet / ard-*). */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/shared-ui/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // --- Plan de travail (zone centrale claire)
        plan: 'var(--plan)',
        carte: 'var(--carte)',
        'carte-douce': 'var(--carte-douce)',
        filet: 'var(--filet)',
        'filet-fort': 'var(--filet-fort)',
        txt: 'var(--txt)',

        // --- Ossature ardoise (barres, colonnes, panneaux) : sombre dans les deux modes
        ard: {
          DEFAULT: 'var(--ard-800)',
          900: 'var(--ard-900)',
          850: 'var(--ard-850)',
          800: 'var(--ard-800)',
          750: 'var(--ard-750)',
          700: 'var(--ard-700)',
          650: 'var(--ard-650)',
          600: 'var(--ard-600)',
          txt: 'var(--ard-txt)',
          'txt-doux': 'var(--ard-txt-doux)',
          'txt-faible': 'var(--ard-txt-faible)',
        },

        // --- Écrans vitrine (connexion, accueil) : ils suivent le mode d'affichage
        vitrine: {
          fond: 'var(--vitrine-fond)',
          surface: 'var(--vitrine-surface)',
          'surface-2': 'var(--vitrine-surface-2)',
          bordure: 'var(--vitrine-bordure)',
          txt: 'var(--vitrine-txt)',
          'txt-doux': 'var(--vitrine-txt-doux)',
          'txt-faible': 'var(--vitrine-txt-faible)',
        },

        // --- Marque
        marque: 'var(--marque)',
        'marque-tint': 'var(--marque-tint)',
        'marque-clair': 'var(--marque-clair)',
        // Texte de marque sur le plan de travail : JAMAIS `marque` en dur (≈ 2:1).
        'marque-sur-plan': 'var(--marque-sur-plan)',
        'sur-marque': 'var(--sur-marque)',

        // --- Sémantique
        ok: 'var(--ok)',
        'ok-tint': 'var(--ok-tint)',
        'ok-txt': 'var(--ok-txt)',
        alerte: 'var(--alerte)',
        'alerte-tint': 'var(--alerte-tint)',
        'alerte-txt': 'var(--alerte-txt)',
        info: 'var(--info)',
        'info-tint': 'var(--info-tint)',
        'info-txt': 'var(--info-txt)',
        attente: 'var(--attente)',
        'attente-tint': 'var(--attente-tint)',
        'attente-txt': 'var(--attente-txt)',

        // --- Couleurs fonctionnelles (identiques pour les deux marques)
        cat: {
          chawarmas: 'var(--cat-chawarmas)',
          pizzas: 'var(--cat-pizzas)',
          grillades: 'var(--cat-grillades)',
          boissons: 'var(--cat-boissons)',
        },
        pay: {
          especes: 'var(--pay-especes)',
          wave: 'var(--pay-wave)',
          orange: 'var(--pay-orange)',
          mtn: 'var(--pay-mtn)',
          moov: 'var(--pay-moov)',
          carte: 'var(--pay-carte)',
          djamo: 'var(--pay-djamo)',
        },

        // --- Compatibilité (anciens noms, alias dans theme.css)
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
        'marque-fonce': 'var(--marque-foncee)',
        'marque-vif': 'var(--marque-vif)',
        accent: 'var(--marque)',
      },
      fontFamily: {
        sans: ['Work Sans Variable', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl: '1.5rem', jeton: 'var(--r)', btn: 'var(--r-btn)' },
      boxShadow: {
        e1: 'var(--ombre-1)',
        e2: 'var(--ombre-2)',
        e3: 'var(--ombre-2)',
        ard: 'var(--ombre-ard)',
      },
      transitionTimingFunction: { fluide: 'var(--ease)' },
    },
  },
  plugins: [],
};
