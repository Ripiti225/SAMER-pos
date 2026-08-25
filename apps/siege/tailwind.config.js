/** @type {import('tailwindcss').Config} */
/* Jetons « Duo contrasté » — voir docs/DESIGN_V2.md § 3.
   Reprise de apps/caisse/tailwind.config.js SANS les alias de compatibilité
   « Culinary Commerce » : la console naît après le portage v2, elle n'a aucune
   dette à traîner. Les noms utilisables ici sont donc les jetons neufs
   (plan / carte / filet / ard-*), et `doux` / `faible` pour le texte du plan,
   qui n'ont pas d'équivalent v2 dans le thème. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
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
        doux: 'var(--txt-doux)',
        faible: 'var(--txt-faible)',

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

        // --- Écrans vitrine (ici : la connexion) : ils suivent le mode d'affichage
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

        // --- Séries de graphique : une teinte par restaurant. L'ordre est le
        // mécanisme de sûreté daltonisme (voir packages/theme/theme.css).
        serie: {
          1: 'var(--serie-1)',
          2: 'var(--serie-2)',
          3: 'var(--serie-3)',
          4: 'var(--serie-4)',
          5: 'var(--serie-5)',
          6: 'var(--serie-6)',
          7: 'var(--serie-7)',
          8: 'var(--serie-8)',
        },

        // --- Couleurs d'opérateur de paiement : déjà définies par le thème,
        // le caissier les reconnaît avant de lire le mot. Ne pas en inventer.
        pay: {
          especes: 'var(--pay-especes)',
          wave: 'var(--pay-wave)',
          orange: 'var(--pay-orange)',
          mtn: 'var(--pay-mtn)',
          moov: 'var(--pay-moov)',
          carte: 'var(--pay-carte)',
          djamo: 'var(--pay-djamo)',
        },

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
      },
      fontFamily: {
        sans: ['Work Sans Variable', 'system-ui', 'sans-serif'],
      },
      borderRadius: { jeton: 'var(--r)', btn: 'var(--r-btn)', sm: 'var(--r-sm)' },
      boxShadow: {
        e1: 'var(--ombre-1)',
        e2: 'var(--ombre-2)',
        ard: 'var(--ombre-ard)',
      },
      transitionTimingFunction: { fluide: 'var(--ease)' },
    },
  },
  plugins: [],
};
