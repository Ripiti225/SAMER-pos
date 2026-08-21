import { create } from 'zustand';
import { api } from '../api';

/**
 * Mode d'affichage du POSTE (DESIGN_V2 § 8) — clair / sombre, et état du
 * bandeau d'équipe sur l'accueil. Persisté dans `parametres_locaux` côté
 * serveur, jamais dans le localStorage : deux caissiers qui se succèdent sur la
 * même caisse retrouvent le même affichage, et chaque poste garde le sien.
 *
 * L'attribut posé sur <html> est `data-mode` (et non `data-theme`) : voir
 * docs/DESIGN_V2.md § 3.3.
 */
export type ModeAffichage = 'clair' | 'sombre';

interface Affichage {
  mode: ModeAffichage;
  bandeauEquipeDeplie: boolean;
  charge: boolean;

  /** Lit le réglage du poste (appelé au démarrage, avant la connexion). */
  charger: () => Promise<void>;
  poserMode: (mode: ModeAffichage) => void;
  basculerMode: () => void;
  poserBandeauEquipeDeplie: (deplie: boolean) => void;
}

interface ReponseAffichage {
  mode: ModeAffichage;
  bandeau_equipe_deplie: boolean;
}

function appliquer(mode: ModeAffichage): void {
  if (mode === 'sombre') document.documentElement.dataset.mode = 'sombre';
  else delete document.documentElement.dataset.mode;
}

/** Enregistrement best-effort : un réglage d'affichage ne bloque jamais la caisse. */
function enregistrer(corps: Partial<ReponseAffichage>): void {
  void api('/api/poste/affichage', { method: 'PUT', corps }).catch(() => undefined);
}

export const useAffichage = create<Affichage>((set, get) => ({
  mode: 'clair',
  bandeauEquipeDeplie: false,
  charge: false,

  charger: async () => {
    try {
      const a = await api<ReponseAffichage>('/api/poste/affichage');
      appliquer(a.mode);
      set({ mode: a.mode, bandeauEquipeDeplie: a.bandeau_equipe_deplie, charge: true });
    } catch {
      // Serveur injoignable : on reste en clair, l'écran s'affiche quand même.
      set({ charge: true });
    }
  },

  poserMode: (mode) => {
    appliquer(mode);
    set({ mode });
    enregistrer({ mode });
  },

  basculerMode: () => get().poserMode(get().mode === 'sombre' ? 'clair' : 'sombre'),

  poserBandeauEquipeDeplie: (bandeauEquipeDeplie) => {
    set({ bandeauEquipeDeplie });
    enregistrer({ bandeau_equipe_deplie: bandeauEquipeDeplie });
  },
}));
