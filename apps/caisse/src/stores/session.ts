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
  /** Tables dont la demande d'addition a été OUVERTE par le caissier (bandeau masqué). */
  tablesVues: string[];

  poserSession: (s: SessionInfo | null) => void;
  poserServiceOuvert: (service: SessionInfo['service_ouvert']) => void;
  verrouiller: (v: boolean) => void;
  aller: (ecran: Ecran, commandeId?: string | null) => void;
  afficherToast: (message: string) => void;
  effacerToast: () => void;
  marquerTableVue: (tableId: string) => void;
  reconcilierTablesVues: (idsEncoreEnAttente: string[]) => void;
}

export const useCaisse = create<EtatCaisse>((set, get) => ({
  session: null,
  verrouille: false,
  ecran: 'accueil',
  commandeId: null,
  toast: null,
  tablesVues: [],

  poserSession: (session) => {
    if (session) {
      document.documentElement.dataset.marque = session.restaurant.marque;
      document.documentElement.style.setProperty('--marque', session.restaurant.couleur_hex);
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
  marquerTableVue: (tableId) => set({ tablesVues: [...get().tablesVues, tableId] }),
  // Une table encaissée (redevenue LIBRE) sort de la liste « vues » :
  // une prochaine demande d'addition fera réapparaître le bandeau.
  reconcilierTablesVues: (idsEncoreEnAttente) =>
    set({ tablesVues: get().tablesVues.filter((id) => idsEncoreEnAttente.includes(id)) }),
}));
