/**
 * Client HTTP des Edge Functions cloud. Uniquement SORTANT (§14.4).
 * Toute erreur est typée : réseau/timeout = statut 0, sinon code HTTP.
 */
export interface LignePush {
  seq: number;
  table_name: string;
  record_id: string;
  operation: string;
  payload: Record<string, unknown>;
}

/**
 * Ligne que le cloud a REFUSÉE, avec la raison. Le POS ne peut pas deviner :
 * un refus arrive dans une réponse HTTP 200 (la fonction s'est exécutée), il
 * faut donc que le cloud dise explicitement laquelle et pourquoi.
 */
export interface BlocagePush {
  seq: number;
  table_name: string;
  raison: string;
}

export interface ReponsePush {
  acquitte_jusqua_seq: number;
  blocage?: BlocagePush;
}

export interface LigneDescente {
  table_name: string;
  row: Record<string, unknown>;
}
export type ReponsePull = Record<string, { lignes: LigneDescente[]; version: number }>;

export interface ReponseReconcile {
  statut: 'OK' | 'ECART';
  total_cloud: number;
  nb_cloud: number;
  ecart: number;
}

export class ErreurSync extends Error {
  constructor(
    message: string,
    /** 0 = réseau/timeout ; sinon code HTTP (401 = clé révoquée). */
    public readonly statut: number,
  ) {
    super(message);
    this.name = 'ErreurSync';
  }
  get estRevocation(): boolean {
    return this.statut === 401;
  }
  get estReseau(): boolean {
    return this.statut === 0;
  }
}

const TIMEOUT_MS = 15_000;

/**
 * L'appel HTTP a réussi (200) mais le cloud n'a appliqué AUCUNE ligne du lot.
 * Ce n'est ni une panne réseau ni une révocation : c'est un refus côté cloud
 * (schéma, contrainte, table inconnue). Il doit remonter comme une erreur, pas
 * comme un succès — sinon la file n'avance plus et personne ne sait pourquoi.
 */
export const STATUT_REFUS_CLOUD = 200;

export class ClientCloud {
  constructor(
    private readonly url: string,
    private readonly cleSite: string,
  ) {}

  private async appeler<T>(fonction: string, corps: Record<string, unknown>): Promise<T> {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), TIMEOUT_MS);
    let rep: Response;
    try {
      rep = await fetch(`${this.url}/${fonction}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cle_site: this.cleSite, ...corps }),
        signal: controleur.signal,
      });
    } catch {
      throw new ErreurSync(`Cloud injoignable (${fonction})`, 0);
    } finally {
      clearTimeout(minuteur);
    }
    if (!rep.ok) {
      let message = `Erreur cloud ${rep.status}`;
      try {
        const j = (await rep.json()) as { erreur?: string };
        if (j.erreur) message = j.erreur;
      } catch {
        /* corps non JSON */
      }
      throw new ErreurSync(message, rep.status);
    }
    return (await rep.json()) as T;
  }

  push(lignes: LignePush[]): Promise<ReponsePush> {
    return this.appeler<ReponsePush>('sync-push', { lignes });
  }

  pull(versions: Record<string, number>): Promise<ReponsePull> {
    return this.appeler<ReponsePull>('sync-pull', { versions });
  }

  reconcile(jour: string, local: { nb_payees: number; total_ventes: number; par_mode: Record<string, number> }): Promise<ReponseReconcile> {
    return this.appeler<ReponseReconcile>('sync-reconcile', { jour, local });
  }

  /**
   * Édition d'administration (catalogue, barème fidélité) : écrit dans le CLOUD
   * (source siège). La version est incrémentée côté cloud ; la modification
   * redescend par la synchro normale (< 5 min).
   */
  adminCatalogue(op: string, entite: string, valeurs: Record<string, unknown>): Promise<{ ok: true; version?: number }> {
    return this.appeler('admin-catalogue', { op, entite, valeurs });
  }
}
