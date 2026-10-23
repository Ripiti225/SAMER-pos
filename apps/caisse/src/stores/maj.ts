import { create } from 'zustand';

/**
 * Mise à jour à distance vue par la caisse (contrat § 5) : `maj_debut` arrive
 * quand le lanceur coupe l'API, `maj_terminee` quand la nouvelle version est
 * validée. Entre les deux, la caisse affiche « Mise à jour en cours » et
 * n'envoie rien (l'API répondrait 503 de toute façon).
 */
interface EtatMaj {
  enCours: boolean;
  /** Nouvelle version en service : recharger la page dès que la caisse est au repos. */
  aRecharger: boolean;
  debut: () => void;
  terminee: () => void;
}

export const useMaj = create<EtatMaj>((set) => ({
  enCours: false,
  aRecharger: false,
  debut: () => set({ enCours: true }),
  terminee: () => set({ enCours: false, aRecharger: true }),
}));
