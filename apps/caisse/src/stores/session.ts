import { create } from 'zustand';
import type { SessionInfo } from '@pos/shared';

export type Ecran =
  | 'supervision'
  | 'accueil'
  | 'commande'
  | 'paiement'
  | 'tables'
  | 'mes-ventes'
  // DESIGN_V2 § 6.2 : l'accueil passe à 6 tuiles, Dépenses et Inventaire
  // deviennent des écrans à part entière (entorse au §15, tranchée par le boss).
  | 'depenses'
  | 'inventaire'
  | 'cloture'
  | 'sequence'
  | 'reglages';

/**
 * Écran d'atterrissage selon le rôle : le propriétaire, le superviseur et le
 * GÉRANT (porteur de `caisse.fermer_sequence`) ne sont pas des caissiers. Ils
 * arrivent sur le tableau de bord Supervision, d'où ils peuvent fermer la
 * séquence ET basculer en mode caisse à la demande — sans être forcés d'ouvrir
 * un shift juste pour entrer (un shift ouvert empêcherait de raser la séquence).
 * Les autres arrivent sur l'accueil caissier.
 */
export function ecranInitial(session: SessionInfo | null): Ecran {
  if (!session) return 'accueil';
  const { est_proprietaire, est_superviseur } = session.utilisateur;
  if (est_proprietaire || est_superviseur || session.permissions.includes('caisse.fermer_sequence')) {
    return 'supervision';
  }
  return 'accueil';
}

interface EtatCaisse {
  session: SessionInfo | null;
  verrouille: boolean;
  ecran: Ecran;
  commandeId: string | null;
  toast: string | null;
  /** Tables dont la demande d'addition a été OUVERTE par le caissier (bandeau masqué). */
  tablesVues: string[];

  poserSession: (s: SessionInfo | null) => void;
  /** Met à jour permissions/utilisateur en direct (WebSocket) sans changer d'écran. */
  majPermissions: (s: SessionInfo) => void;
  poserServiceOuvert: (service: SessionInfo['service_ouvert']) => void;
  verrouiller: (v: boolean) => void;
  aller: (ecran: Ecran, commandeId?: string | null) => void;
  /** Retour à l'écran d'accueil propre au rôle (Supervision ou Accueil caissier). */
  rentrer: () => void;
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
    set({ session, ecran: ecranInitial(session), commandeId: null, verrouille: false });
  },
  majPermissions: (fraiche) => {
    const s = get().session;
    if (!s) return;
    // Si l'utilisateur perd l'accès Réglages en direct, on le renvoie à l'accueil.
    const perdAcces = get().ecran === 'reglages' && fraiche.permissions.length === 0;
    set({
      session: { ...s, utilisateur: fraiche.utilisateur, permissions: fraiche.permissions },
      ...(perdAcces ? { ecran: 'accueil' as Ecran } : {}),
    });
  },
  poserServiceOuvert: (service) => {
    const s = get().session;
    if (s) set({ session: { ...s, service_ouvert: service } });
  },
  verrouiller: (verrouille) => set({ verrouille }),
  aller: (ecran, commandeId = null) => set({ ecran, commandeId }),
  rentrer: () => set({ ecran: ecranInitial(get().session), commandeId: null }),
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
