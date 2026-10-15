import { create } from 'zustand';
import type { SessionInfo } from '@pos/shared';

function appliquerMarque(session: SessionInfo): void {
  document.documentElement.dataset.marque = session.restaurant.marque;
  document.documentElement.style.setProperty('--marque', session.restaurant.couleur_hex);
}

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

/**
 * Où en était CET onglet, pour qu'un rechargement de page (nouvelle version de
 * la caisse, serveur local redémarré, fenêtre du poste rechargée) ne renvoie
 * plus un gérant ou un propriétaire de sa commande vers la Supervision.
 *
 * sessionStorage, pas localStorage : propre à l'onglet, effacé à sa fermeture.
 * Aucune donnée sensible — un nom d'écran et un identifiant de commande.
 */
const CLE_REPRISE = 'pos-caisse-ecran';
interface Reprise {
  utilisateur_id: string;
  ecran: Ecran;
  commandeId: string | null;
  modeCaisse: boolean;
}

function lireReprise(): Reprise | null {
  try {
    const brut = sessionStorage.getItem(CLE_REPRISE);
    return brut ? (JSON.parse(brut) as Reprise) : null;
  } catch {
    return null;
  }
}

function ecrireReprise(reprise: Reprise | null): void {
  try {
    if (reprise) sessionStorage.setItem(CLE_REPRISE, JSON.stringify(reprise));
    else sessionStorage.removeItem(CLE_REPRISE);
  } catch {
    /* navigation privée, stockage bloqué : on retombe sur l'écran du rôle */
  }
}

interface EtatCaisse {
  session: SessionInfo | null;
  verrouille: boolean;
  ecran: Ecran;
  commandeId: string | null;
  /**
   * Le gérant ou le propriétaire a choisi de travailler EN CAISSE (il est
   * passé par l'accueil caissier). « Retour » le ramène alors à l'accueil
   * caissier, plus à la Supervision. Toujours vrai pour un caissier.
   */
  modeCaisse: boolean;
  toast: string | null;
  /** Tables dont la demande d'addition a été OUVERTE par le caissier (bandeau masqué). */
  tablesVues: string[];

  poserSession: (s: SessionInfo | null) => void;
  /**
   * Session relue sans nouvelle connexion (démarrage de l'onglet, identité du
   * restaurant changée) : on reste sur l'écran où l'on était, si c'est la même
   * personne. Seule une vraie connexion part de l'écran du rôle.
   */
  reprendreSession: (s: SessionInfo) => void;
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
  modeCaisse: false,
  toast: null,
  tablesVues: [],

  poserSession: (session) => {
    if (session) appliquerMarque(session);
    const ecran = ecranInitial(session);
    set({ session, ecran, commandeId: null, verrouille: false, modeCaisse: ecran === 'accueil' });
  },
  reprendreSession: (session) => {
    const reprise = lireReprise();
    if (!reprise || reprise.utilisateur_id !== session.utilisateur.id) {
      get().poserSession(session);
      return;
    }
    appliquerMarque(session);
    set({
      session,
      ecran: reprise.ecran,
      commandeId: reprise.commandeId,
      modeCaisse: reprise.modeCaisse,
    });
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
  aller: (ecran, commandeId = null) =>
    set({
      ecran,
      commandeId,
      // L'accueil caissier fait entrer en mode caisse, la Supervision en fait
      // sortir. Les autres écrans (Mes ventes, Dépenses…) ne changent rien :
      // on y vient des deux côtés, « Retour » doit ramener d'où l'on vient.
      modeCaisse: ecran === 'accueil' ? true : ecran === 'supervision' ? false : get().modeCaisse,
    }),
  rentrer: () =>
    set({ ecran: get().modeCaisse ? 'accueil' : ecranInitial(get().session), commandeId: null }),
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

// Chaque déplacement est noté pour la reprise après rechargement. Une
// déconnexion efface la note : le compte suivant part de son propre écran.
useCaisse.subscribe((etat) => {
  ecrireReprise(
    etat.session
      ? { utilisateur_id: etat.session.utilisateur.id, ecran: etat.ecran, commandeId: etat.commandeId, modeCaisse: etat.modeCaisse }
      : null,
  );
});
