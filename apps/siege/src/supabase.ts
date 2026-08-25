import { createClient } from '@supabase/supabase-js';

/**
 * Client Supabase de la console.
 *
 * Il ne porte QUE la clé anonyme, publique par construction — elle part dans le
 * JavaScript téléchargé par le navigateur, il n'y a pas de secret à protéger
 * ici. Tout le privilège vit dans l'Edge Function `siege`, qui vérifie le jeton
 * de la personne connectée puis son appartenance à `siege_utilisateurs` : la
 * clé anon est elle-même un JWT valide, la seule vérification d'authentification
 * ne suffirait donc pas.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const cle = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** Dit à l'écran ce qui manque, plutôt que d'échouer sur un 401 incompréhensible. */
export const configurationManquante = !url || !cle;

export const supabase = createClient(url ?? 'https://exemple.invalid', cle ?? 'non-configuree', {
  auth: {
    persistSession: true,
    // La session dure une heure ; quelqu'un qui regarde des tableaux de bord
    // dépasse largement ce délai sans cliquer. Sans ce rafraîchissement, il
    // serait déconnecté en plein écran.
    autoRefreshToken: true,
  },
});
