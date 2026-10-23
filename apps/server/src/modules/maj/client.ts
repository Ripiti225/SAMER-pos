/**
 * Appels à l'Edge Function `maj` (contrat § 2) : `consulter` et `rapporter`.
 * Même authentification que les autres fonctions (clé de site dans le corps).
 */
import type { ReglagesMaj } from './fondations.js';

export interface MorceauUrl {
  nom: string;
  url: string;
}

export interface CibleMaj {
  numero: number;
  version: string;
  manifeste: string;
  signature: string;
  morceaux: MorceauUrl[];
  dependances: null | {
    empreinte: string;
    manifeste: string;
    signature: string;
    morceaux: MorceauUrl[];
  };
}

export interface ReponseConsulter {
  cible: CibleMaj | null;
  reglages: ReglagesMaj;
  migration_absente?: boolean;
}

export type EvenementMaj =
  | 'TELECHARGEMENT'
  | 'PRET'
  | 'AVERTI'
  | 'REPORTE'
  | 'DEBUT'
  | 'INSTALLE'
  | 'ECHEC_RETOUR_ARRIERE'
  | 'REFUSEE'
  | 'BLOQUE'
  | 'ESPACE_INSUFFISANT'
  | 'LANCEUR_TROP_ANCIEN'
  | 'SIGNATURE_INVALIDE'
  | 'ERREUR';

export class ErreurCloudMaj extends Error {
  constructor(
    message: string,
    /** 0 = réseau/délai ; sinon code HTTP. */
    public readonly statut: number,
  ) {
    super(message);
    this.name = 'ErreurCloudMaj';
  }
}

/** Le cloud tronque au-delà de 8 Ko : on coupe nous-mêmes les textes longs. */
function borner(detail: Record<string, unknown>): Record<string, unknown> {
  const texte = JSON.stringify(detail);
  if (texte.length <= 7000) return detail;
  return { tronque: true, extrait: texte.slice(0, 6500) };
}

export class ClientMaj {
  constructor(
    private readonly url: string,
    private readonly cleSite: string,
    private readonly delaiMs = 30_000,
    private readonly faireFetch: typeof fetch = fetch,
  ) {}

  private async appeler<T>(corps: Record<string, unknown>): Promise<T> {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.delaiMs);
    let rep: Response;
    try {
      rep = await this.faireFetch(`${this.url}/maj`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cle_site: this.cleSite, ...corps }),
        signal: controleur.signal,
      });
    } catch {
      throw new ErreurCloudMaj('Cloud injoignable (mise à jour)', 0);
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
      throw new ErreurCloudMaj(message, rep.status);
    }
    return (await rep.json()) as T;
  }

  consulter(installee: { numero: number; version: string }, lanceurNumero: number): Promise<ReponseConsulter> {
    return this.appeler<ReponseConsulter>({ action: 'consulter', installee, lanceur_numero: lanceurNumero });
  }

  rapporter(numero: number, evenement: EvenementMaj, detail: Record<string, unknown> = {}): Promise<{ ok: true }> {
    return this.appeler<{ ok: true }>({ action: 'rapporter', numero, evenement, detail: borner(detail) });
  }
}
