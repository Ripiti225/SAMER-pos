import { supabase } from './supabase';

/** Erreur portant le message FRANÇAIS renvoyé par la fonction, pas un code. */
export class ErreurSiege extends Error {
  constructor(
    message: string,
    readonly statut: number,
  ) {
    super(message);
  }
}

/**
 * Appelle l'Edge Function `siege` — point d'entrée UNIQUE de la console.
 *
 * Une action = une entrée du `switch` côté fonction. On n'interroge jamais la
 * base directement : la RLS y est forcée sans politique, une lecture directe
 * exigerait la clé `service_role` dans le navigateur.
 */
export async function appelSiege<T>(action: string, corps: Record<string, unknown> = {}): Promise<T> {
  const { data: sess } = await supabase.auth.getSession();
  const jeton = sess.session?.access_token;
  if (!jeton) throw new ErreurSiege('Connexion requise', 401);

  const rep = await supabase.functions.invoke(`siege`, {
    body: { action, ...corps },
    headers: { Authorization: `Bearer ${jeton}` },
  });

  // `functions.invoke` range le corps de réponse des statuts d'erreur dans
  // l'erreur ; on va le rechercher pour afficher le message français plutôt
  // qu'un « Edge Function returned a non-2xx status code ».
  if (rep.error) {
    let message = 'La console n’a pas pu joindre le siège';
    let statut = 500;
    const ctx = (rep.error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      statut = ctx.status;
      try {
        const corpsErreur = (await ctx.json()) as { erreur?: string };
        if (corpsErreur?.erreur) message = corpsErreur.erreur;
      } catch {
        // Réponse non JSON : on garde le message générique.
      }
    }
    throw new ErreurSiege(message, statut);
  }

  const data = rep.data as T & { erreur?: string };
  if (data && typeof data === 'object' && 'erreur' in data && data.erreur) {
    throw new ErreurSiege(data.erreur, 400);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Formes renvoyées par la fonction (supabase/functions/siege/index.ts).
// ---------------------------------------------------------------------------

export interface Siege {
  userId: string;
  nomComplet: string;
  /** LECTURE voit tout et n'écrit rien — pour un comptable ou un associé. */
  niveau: 'ADMIN' | 'LECTURE';
}

export interface RestoGroupe {
  /** UUID POS, présent SEULEMENT si le site est enrôlé : c'est la clé des ventes. */
  restaurant_id: string | null;
  samtrackly_id: string;
  nom: string;
  marque: 'SAMER' | 'AL_KAYAN';
  /** false = ce POS ne synchronise pas encore, donc aucune vente ici. */
  enrole: boolean;
}

export interface LigneTableauBord extends RestoGroupe {
  nb_commandes: number;
  ca: number;
  nb_annulees: number;
  remises: number;
  panier_moyen: number;
}

export interface TableauBord {
  periode: { debut: string; fin: string };
  total: number;
  restaurants: LigneTableauBord[];
  tendance: { restaurant_id: string; jour: string; ca: number; nb_commandes: number }[];
  /** Aucun site ne remonte encore : à écrire à l'écran, sinon on croit à une journée blanche. */
  aucun_site_enrole: boolean;
}

export interface Cloture {
  restaurant_id: string;
  service_id: string;
  caissier_id: string | null;
  ouvert_le: string;
  cloture_le: string | null;
  statut: string;
  fond_de_caisse: number;
  especes_comptees: number | null;
  especes_theorique: number | null;
  ecart: number | null;
}

export interface Employe {
  id: string;
  nom: string | null;
  poste: string | null;
  contact: string | null;
  photo_url: string | null;
  actif: boolean | null;
  restaurant_id: string | null;
  restaurant_nom: string | null;
}

/** Un membre de l'équipe d'un service, tel que l'action `equipe_service` le rend. */
export interface MembreService {
  utilisateur_id: string;
  nom_complet: string | null;
  poste: string | null;
  taux_journalier: number | null;
  /** Heure d'arrivée = heure du clic sur « Pointer » sur le site. */
  arrive_le: string | null;
  /** NULL = pas tranché ; à la clôture, tout ce qui n'est pas `true` est PARTI. */
  reste: boolean | null;
  /** Payé à la journée : montant et HEURE DE PAIE, qui vaut heure de départ. */
  salaire: { montant: number; paye_le: string } | null;
}
