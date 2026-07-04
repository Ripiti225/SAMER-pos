import { create } from 'zustand';
import type { SessionInfo } from '@pos/shared';

export type Ecran =
  | 'accueil'
  | 'commande'
  | 'paiement'
  | 'tables'
  | 'mes-ventes'
  | 'cloture';

interface EtatCaisse {
  session: SessionInfo | null;
  verrouille: boolean;
  ecran: Ecran;
  commandeId: string | null;
  toast: string | null;

  poserSession: (s: SessionInfo | null) => void;
  poserServiceOuvert: (service: SessionInfo['service_ouvert']) => void;
  verrouiller: (v: boolean) => void;
  aller: (ecran: Ecran, commandeId?: string | null) => void;
  afficherToast: (message: string) => void;
  effacerToast: () => void;
}

export const useCaisse = create<EtatCaisse>((set, get) => ({
  session: null,
  verrouille: false,
  ecran: 'accueil',
  commandeId: null,
  toast: null,

  poserSession: (session) => {
    if (session) {
      document.documentElement.style.setProperty('--accent', session.restaurant.couleur_hex);
    }
    set({ session, ecran: 'accueil', commandeId: null, verrouille: false });
  },
  poserServiceOuvert: (service) => {
    const s = get().session;
    if (s) set({ session: { ...s, service_ouvert: service } });
  },
  verrouiller: (verrouille) => set({ verrouille }),
  aller: (ecran, commandeId = null) => set({ ecran, commandeId }),
  afficherToast: (toast) => {
    set({ toast });
    setTimeout(() => {
      if (get().toast === toast) set({ toast: null });
    }, 3500);
  },
  effacerToast: () => set({ toast: null }),
}));
