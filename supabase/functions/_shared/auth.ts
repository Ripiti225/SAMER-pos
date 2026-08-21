import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Client Supabase service_role (contourne la RLS) — secrets de la fonction. */
export function clientAdmin(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** sha256 hex d'une chaîne (identique côté serveur local pour l'enrôlement). */
export async function sha256Hex(valeur: string): Promise<string> {
  const octets = new TextEncoder().encode(valeur);
  const hache = await crypto.subtle.digest('SHA-256', octets);
  return [...new Uint8Array(hache)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ErreurAuth extends Error {}

/**
 * Vérifie la clé de site et renvoie le restaurant_id. La clé est révocable
 * individuellement (actif = false) → 401 sans divulguer de détail.
 */
export async function verifierCleSite(admin: SupabaseClient, cleSite: unknown): Promise<string> {
  if (typeof cleSite !== 'string' || cleSite.length < 16) {
    throw new ErreurAuth('Clé de site absente ou invalide');
  }
  const hash = await sha256Hex(cleSite);
  const { data, error } = await admin
    .from('sites_autorises')
    .select('restaurant_id, actif')
    .eq('cle_hash', hash)
    .maybeSingle();
  if (error) throw new ErreurAuth('Vérification impossible');
  if (!data || !data.actif) throw new ErreurAuth('Site non autorisé ou révoqué');
  return data.restaurant_id as string;
}

/** Réponse JSON normalisée. */
export function json(corps: unknown, statut = 200): Response {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// CONSOLE SIÈGE (2026-08-17) — authentification par HUMAIN, pas par machine.
//
// Les 4 fonctions de synchro s'authentifient par `cle_site` : un poste prouve
// qu'il est un poste. La console, elle, est ouverte par une personne depuis un
// navigateur quelconque : il lui faut une vraie identité. On délègue à Supabase
// Auth (mot de passe, réinitialisation, expiration du jeton) et on ne garde ici
// que l'autorisation : ce compte a-t-il le droit d'entrer, et pour quoi faire.
// ---------------------------------------------------------------------------

export interface Siege {
  userId: string;
  nomComplet: string;
  niveau: 'ADMIN' | 'LECTURE';
}

/**
 * Vérifie le jeton porteur et renvoie l'utilisateur siège.
 *
 * Le contrôle en DEUX temps est délibéré. `auth.getUser()` seul ne suffit pas :
 * la clé anonyme du projet EST un JWT valide, et elle est publique par
 * construction (elle vit dans le JavaScript de la console). Le passage par
 * `siege_utilisateurs` est donc ce qui autorise réellement — sans lui,
 * n'importe qui ayant ouvert la page aurait accès aux ventes du groupe.
 */
export async function verifierSiege(admin: SupabaseClient, req: Request): Promise<Siege> {
  const entete = req.headers.get('Authorization') ?? '';
  const jeton = entete.startsWith('Bearer ') ? entete.slice(7) : '';
  if (!jeton) throw new ErreurAuth('Connexion requise');

  const { data: auth, error } = await admin.auth.getUser(jeton);
  if (error || !auth?.user) throw new ErreurAuth('Session expirée, reconnectez-vous');

  const { data, error: e2 } = await admin
    .from('siege_utilisateurs')
    .select('user_id, nom_complet, niveau, actif')
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (e2) throw new ErreurAuth('Vérification impossible');
  if (!data || !data.actif) throw new ErreurAuth("Ce compte n'a pas accès à la console du siège");

  return {
    userId: data.user_id as string,
    nomComplet: data.nom_complet as string,
    niveau: data.niveau as 'ADMIN' | 'LECTURE',
  };
}

/** Le niveau LECTURE voit tout mais n'écrit rien. */
export function exigeAdmin(siege: Siege): void {
  if (siege.niveau !== 'ADMIN') {
    throw new ErreurAuth('Votre compte est en lecture seule');
  }
}

/**
 * CORS — la console est servie depuis une autre origine que les fonctions
 * (localhost en développement, le domaine du siège ensuite). Les fonctions de
 * synchro n'en ont jamais eu besoin : elles sont appelées par un serveur Node,
 * pas par un navigateur.
 */
export const ENTETES_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/** Réponse JSON avec CORS (console siège). */
export function jsonCors(corps: unknown, statut = 200): Response {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { 'content-type': 'application/json', ...ENTETES_CORS },
  });
}
