/**
 * File d'attente locale ANTI-COUPURE WIFI (§B4, §16 risque 7).
 *
 * Chaque action (envoi cuisine, demande d'addition) est d'abord écrite dans
 * IndexedDB, PUIS envoyée au serveur. Si le serveur ne répond pas, l'action
 * reste en file et la tablette continue de fonctionner ; à la reconnexion la
 * file est rejouée dans l'ordre. L'idempotence est garantie côté serveur par
 * l'UUID d'action (table actions_recues) : rejouer ne crée jamais de doublon.
 */
import { openDB, type IDBPDatabase } from 'idb';
import { api, ErreurApi } from '@pos/shared-ui';

export interface ActionEnFile {
  uuid: string;
  type: 'ENVOYER_CUISINE' | 'DEMANDER_ADDITION';
  corps: Record<string, unknown>;
  cree_le: number;
}

const ROUTES: Record<ActionEnFile['type'], string> = {
  ENVOYER_CUISINE: '/api/serveur/envoyer',
  DEMANDER_ADDITION: '/api/serveur/addition',
};

const INTERVALLE_REJEU_MS = 3000;

type Ecouteur = (enAttente: number) => void;

class FileAttente {
  private db: Promise<IDBPDatabase>;
  private ecouteurs = new Set<Ecouteur>();
  private envoiEnCours = false;
  private minuteur: ReturnType<typeof setTimeout> | null = null;
  /** Callback succès/échec définitif, pour rafraîchir l'UI. */
  onResultat: ((action: ActionEnFile, ok: boolean, erreur?: string) => void) | null = null;

  constructor() {
    this.db = openDB('pos-serveur-file', 1, {
      upgrade(d) {
        d.createObjectStore('actions', { keyPath: 'uuid' });
      },
    });
    window.addEventListener('online', () => void this.rejouer());
    void this.rejouer(); // rejeu des actions restées d'une session précédente
  }

  souscrire(cb: Ecouteur): () => void {
    this.ecouteurs.add(cb);
    void this.notifier();
    return () => this.ecouteurs.delete(cb);
  }

  private async notifier(): Promise<void> {
    const n = await (await this.db).count('actions');
    for (const cb of this.ecouteurs) cb(n);
  }

  /** Écrit l'action en local PUIS tente l'envoi — jamais l'inverse. */
  async enfiler(type: ActionEnFile['type'], corps: Record<string, unknown>): Promise<void> {
    const action: ActionEnFile = {
      uuid: (corps.action_uuid as string) ?? crypto.randomUUID(),
      type,
      corps,
      cree_le: Date.now(),
    };
    await (await this.db).put('actions', action);
    await this.notifier();
    void this.rejouer();
  }

  /** Rejeu dans l'ordre de création. S'arrête à la première coupure réseau. */
  async rejouer(): Promise<void> {
    if (this.envoiEnCours) return;
    this.envoiEnCours = true;
    try {
      const base = await this.db;
      const actions = ((await base.getAll('actions')) as ActionEnFile[]).sort(
        (a, b) => a.cree_le - b.cree_le,
      );
      for (const action of actions) {
        try {
          await api(ROUTES[action.type], { method: 'POST', corps: action.corps });
          await base.delete('actions', action.uuid);
          await this.notifier();
          this.onResultat?.(action, true);
        } catch (e) {
          const erreur = e as ErreurApi;
          if (erreur.statusCode === 0 || erreur.statusCode >= 500 || erreur.statusCode === 401) {
            // Réseau coupé, serveur en erreur ou session expirée :
            // on garde l'action et on réessaiera — AUCUNE perte.
            this.programmerRejeu();
            return;
          }
          // Erreur métier définitive (ex : addition sans commande) :
          // on retire l'action et on prévient l'utilisateur.
          await base.delete('actions', action.uuid);
          await this.notifier();
          this.onResultat?.(action, false, erreur.message);
        }
      }
    } finally {
      this.envoiEnCours = false;
    }
  }

  private programmerRejeu(): void {
    if (this.minuteur) clearTimeout(this.minuteur);
    this.minuteur = setTimeout(() => void this.rejouer(), INTERVALLE_REJEU_MS);
  }
}

export const fileAttente = new FileAttente();
