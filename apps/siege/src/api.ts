/**
 * Accès au cloud depuis la console siège.
 *
 * Deux interlocuteurs seulement :
 *   * Supabase Auth (`/auth/v1`) pour la connexion et le renouvellement du
 *     jeton — on parle à l'API REST en `fetch`, comme le serveur POS le fait
 *     déjà pour SamerTrackly. Pas de SDK à installer.
 *   * la fonction `siege` pour TOUTES les données. La console ne touche jamais
 *     une table directement : elle n'en aurait pas le droit (RLS forcée) et il
 *     faudrait pour cela lui confier une clé qui ouvre les ventes du groupe.
 */

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const CLE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configureeCorrectement = !!URL_BASE && !!CLE_ANON;

/** Message d'erreur en français courant — jamais de code technique à l'écran. */
export class ErreurApi extends Error {}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
// Le jeton d'accès expire vite (1 h) ; c'est le jeton de renouvellement qui
// tient la session. Il est conservé dans le navigateur, ce qui est le
// fonctionnement normal d'une console d'administration ouverte sur un poste
// personnel — contrairement à la caisse, qui tourne sur un kiosque partagé et
// où l'on refuse d'écrire quoi que ce soit de sensible.

const CLE_STOCKAGE = 'siege.session';

interface Session {
  access_token: string;
  refresh_token: string;
  /** Instant d'expiration, en millisecondes. */
  expire_le: number;
}

function lireSession(): Session | null {
  try {
    const brut = localStorage.getItem(CLE_STOCKAGE);
    if (!brut) return null;
    const s = JSON.parse(brut) as Session;
    return s.refresh_token ? s : null;
  } catch {
    return null;
  }
}

function ecrireSession(s: Session | null): void {
  if (s) localStorage.setItem(CLE_STOCKAGE, JSON.stringify(s));
  else localStorage.removeItem(CLE_STOCKAGE);
}

interface ReponseJeton {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error_description?: string;
  msg?: string;
}

async function demanderJeton(corps: Record<string, string>, typeOctroi: string): Promise<Session> {
  const rep = await fetch(`${URL_BASE}/auth/v1/token?grant_type=${typeOctroi}`, {
    method: 'POST',
    headers: { apikey: CLE_ANON!, 'content-type': 'application/json' },
    body: JSON.stringify(corps),
  }).catch(() => null);

  if (!rep) throw new ErreurApi('Le cloud est injoignable. Vérifiez votre connexion internet.');

  const data = (await rep.json().catch(() => ({}))) as ReponseJeton;
  if (!rep.ok || !data.access_token || !data.refresh_token) {
    // Supabase renvoie un libellé anglais ; on ne le montre pas tel quel.
    if (rep.status === 400 || rep.status === 401) {
      throw new ErreurApi(
        typeOctroi === 'password' ? 'Adresse e-mail ou mot de passe incorrect.' : 'Session expirée.',
      );
    }
    throw new ErreurApi('Connexion impossible pour le moment.');
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expire_le: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

export async function seConnecter(email: string, motDePasse: string): Promise<void> {
  const s = await demanderJeton({ email: email.trim(), password: motDePasse }, 'password');
  ecrireSession(s);
}

export function seDeconnecter(): void {
  ecrireSession(null);
}

export function sessionOuverte(): boolean {
  return lireSession() !== null;
}

/**
 * Renvoie un jeton valide, en le renouvelant si besoin.
 * La marge de 60 s évite de partir avec un jeton qui expire pendant l'appel.
 */
async function jetonValide(): Promise<string> {
  const s = lireSession();
  if (!s) throw new ErreurApi('Session expirée.');
  if (Date.now() < s.expire_le - 60_000) return s.access_token;

  try {
    const neuf = await demanderJeton({ refresh_token: s.refresh_token }, 'refresh_token');
    ecrireSession(neuf);
    return neuf.access_token;
  } catch (e) {
    ecrireSession(null);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Appels à la fonction `siege`
// ---------------------------------------------------------------------------

export async function appeler<T>(action: string, corps: Record<string, unknown> = {}): Promise<T> {
  const jeton = await jetonValide();
  const rep = await fetch(`${URL_BASE}/functions/v1/siege`, {
    method: 'POST',
    headers: {
      apikey: CLE_ANON!,
      Authorization: `Bearer ${jeton}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ action, ...corps }),
  }).catch(() => null);

  if (!rep) throw new ErreurApi('Le cloud est injoignable. Vérifiez votre connexion internet.');

  const data = (await rep.json().catch(() => ({}))) as { erreur?: string };
  if (!rep.ok) {
    // 401 = la session ne vaut plus rien : on la jette pour que l'app renvoie
    // proprement à l'écran de connexion au lieu de boucler sur des erreurs.
    if (rep.status === 401) ecrireSession(null);
    throw new ErreurApi(data.erreur ?? 'Le cloud a refusé la demande.');
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Formes de données
// ---------------------------------------------------------------------------

export interface Moi {
  userId: string;
  nomComplet: string;
  niveau: 'ADMIN' | 'LECTURE';
}

export interface RestoTableau {
  restaurant_id: string | null;
  samtrackly_id: string;
  nom: string;
  marque: 'SAMER' | 'AL_KAYAN';
  enrole: boolean;
  nb_commandes: number;
  ca: number;
  nb_annulees: number;
  remises: number;
  panier_moyen: number;
}

export interface TableauBord {
  periode: { debut: string; fin: string };
  total: number;
  restaurants: RestoTableau[];
  tendance: { restaurant_id: string; jour: string; ca: number; nb_commandes: number }[];
  aucun_site_enrole: boolean;
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

/** FCFA : entiers, jamais de décimale. Même écriture que la caisse. */
export function fcfa(montant: number): string {
  return `${Math.round(montant).toLocaleString('fr-FR')} F`;
}

/**
 * Bornes d'une période, en ISO.
 * Abidjan vit à UTC+0 toute l'année : la journée comptable va donc bien de
 * minuit à minuit UTC, sans décalage à corriger.
 */
export function bornes(periode: 'jour' | 'semaine' | 'mois'): { debut: string; fin: string } {
  const maintenant = new Date();
  const debut = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate()));
  if (periode === 'semaine') {
    // Semaine commençant le lundi.
    const jour = (debut.getUTCDay() + 6) % 7;
    debut.setUTCDate(debut.getUTCDate() - jour);
  } else if (periode === 'mois') {
    debut.setUTCDate(1);
  }
  const fin = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate() + 1));
  return { debut: debut.toISOString(), fin: fin.toISOString() };
}
