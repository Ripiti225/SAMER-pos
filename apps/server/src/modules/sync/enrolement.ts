/** Choisit la clé qui authentifiera ce site auprès du cloud. */
export function choisirCleSite(
  cleLocale: unknown,
  cleSauvegardee: unknown,
  generer: () => string,
): string {
  if (typeof cleLocale === 'string' && cleLocale.length >= 16) return cleLocale;
  if (typeof cleSauvegardee === 'string' && cleSauvegardee.length >= 16) return cleSauvegardee;
  return generer();
}

export type ModeConfigurationSite = 'NOUVEAU' | 'REMPLACEMENT';

/**
 * SQL d'autorisation cloud. En remplacement, un UPDATE strict empêche une
 * faute de frappe dans l'UUID de créer silencieusement un deuxième site.
 */
export function sqlAutorisationSite(params: {
  mode: ModeConfigurationSite;
  restaurantId: string;
  code: string;
  hash: string;
}): string {
  if (params.mode === 'REMPLACEMENT') {
    return (
      `DO $$\nBEGIN\n` +
      `  UPDATE sites_autorises\n` +
      `  SET cle_hash = '${params.hash}', actif = TRUE\n` +
      `  WHERE restaurant_id = '${params.restaurantId}' AND code = '${params.code}';\n` +
      `  IF NOT FOUND THEN\n` +
      `    RAISE EXCEPTION 'Site existant introuvable : remplacement annulé';\n` +
      `  END IF;\n` +
      `END $$;`
    );
  }
  return (
    `INSERT INTO sites_autorises (restaurant_id, code, cle_hash, actif)\n` +
    `VALUES ('${params.restaurantId}', '${params.code}', '${params.hash}', TRUE)\n` +
    `ON CONFLICT (restaurant_id) DO UPDATE SET cle_hash = EXCLUDED.cle_hash, actif = TRUE\n` +
    `  WHERE sites_autorises.code = EXCLUDED.code;`
  );
}
