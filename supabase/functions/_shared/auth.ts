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
