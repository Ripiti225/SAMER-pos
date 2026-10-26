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
  /**
   * Seul le propriétaire publie, promeut et retire une version des postes.
   * Absent d'une fonction `siege` antérieure au 23/10/2026 : vaut « non ».
   */
  proprietaire?: boolean;
}

export interface RestoGroupe {
  /** UUID POS, présent SEULEMENT si le site est enrôlé : c'est la clé des ventes. */
  restaurant_id: string | null;
  samtrackly_id: string;
  nom: string;
  marque: 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE';
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

/**
 * Réponse de l'action `tableau_bord`. Chaque tableau vient d'une fonction SQL
 * `siege_*` : l'agrégation se fait dans PostgreSQL, jamais dans la fonction
 * Deno ni ici. Un bloc dont la fonction manque (migration pas encore passée)
 * arrive VIDE plutôt que de faire échouer tout l'écran.
 */
export interface Bord {
  /** `fin_precedent` : absente d'une fonction déployée avant les plages
   *  horaires — la période d'en face finissait alors à `debut`. */
  periode: { debut: string; fin: string; debut_precedent: string; fin_precedent?: string };
  total: number;
  total_precedent: number;
  restaurants: (RestoGroupe & {
    nb_commandes: number;
    ca: number;
    nb_annulees: number;
    remises: number;
    panier_moyen: number;
    ca_precedent: number;
    nb_commandes_precedent: number;
  })[];
  tendance: { restaurant_id: string; jour: string; ca: number; nb_commandes: number }[];
  heures: { restaurant_id: string; heure: number; nb: number; ca: number }[];
  plats: { restaurant_id: string; nom: string; quantite: number; total: number }[];
  /** Plats vendus pendant chaque heure — l'infobulle des heures de pic. Absent
   *  d'une fonction déployée avant le 2026-10-18. */
  plats_heure?: { restaurant_id: string; heure: number; plats: { nom: string; quantite: number; total: number }[] }[];
  /** Ventes de chaque caissier ; leur somme par restaurant = son CA. Absent
   *  d'une fonction déployée avant le 2026-10-18. */
  caissiers?: {
    restaurant_id: string;
    caissier_id: string | null;
    caissier: string;
    nb_commandes: number;
    ca: number;
    nb_services: number;
  }[];
  modes: { restaurant_id: string; mode: string; montant: number; nb: number }[];
  types: { restaurant_id: string; type: string; partenaire: string | null; nb: number; total: number }[];
  /** `numero` est NULL tant que `pnpm salle:republier` n'a pas tourné sur le site. */
  tables: { restaurant_id: string; table_id: string; numero: string | null; zone: string | null; nb: number; total: number }[];
  retours: { restaurant_id: string; nom: string; quantite: number; montant: number }[];
  depenses: { restaurant_id: string; categorie: string; montant: number; nb: number }[];
  ecarts: { restaurant_id: string; caissier: string; ecart: number; nb_services: number }[];
  equipe: {
    restaurant_id: string;
    utilisateur_id: string;
    nom: string;
    poste: string | null;
    nb_services: number;
    minutes: number;
    salaire: number;
  }[];
  remises: { restaurant_id: string; numero_ticket: number; montant: number; motif: string | null; created_at: string }[];
  annulations: { restaurant_id: string; numero_ticket: number; total: number; created_at: string }[];
  inventaire: { restaurant_id: string; nb_inventaires: number; montant_manquant: number; nb_debloques: number }[];
  /**
   * Livraisons partenaires, par caissier. `nb` = courses payées, `contacts` =
   * celles qui portent le téléphone du client, `refs` = celles qui portent le
   * n° de commande du partenaire. L'écart entre `nb` et `contacts` est le
   * nombre de courses qu'on ne saura rattacher à personne en cas de litige.
   */
  livraisons: {
    restaurant_id: string;
    caissier: string;
    partenaire: string;
    nb: number;
    contacts: number;
    refs: number;
    ca: number;
  }[];
  /** État COURANT de la fiche employé, jamais un historique. */
  absents: { id: string; restaurant_id: string; nom_complet: string; poste: string | null; disponibilite: string }[];
  aucun_site_enrole: boolean;
  /** Les tables remontent sans nom : le référentiel de salle n'a pas été republié. */
  salle_non_publiee: boolean;
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
  /** Écart espèces brut, conservé comme détail du tiroir. */
  ecart: number | null;
  /** Écart global après correction des modes de paiement — anomalie réelle. */
  ecart_reconciliation?: number | null;
  /** Nom du caissier (ticket Z figé, sinon fiche employé). */
  caissier?: string | null;
  /** Ce que le caissier a écrit sous son écart en validant son ticket. */
  explication_ecart?: string | null;
  /** Ticket validé par le caissier (« Terminer ») ; NULL : pas encore. */
  remis_le?: string | null;
}

export type StatutExplicationInventaire = 'en_attente' | 'validee' | 'refusee';

/** Une réception de stock d'une journée, quelle que soit son origine. */
export interface EntreeInventaireSiege {
  entree_id: string;
  inventaire_id: string;
  restaurant_id: string;
  restaurant_nom: string;
  date: string;
  type_shift: string;
  caissier_id: string | null;
  caissier_nom: string;
  produit_code: string;
  produit_nom: string;
  quantite: number;
  fournisseur_nom: string | null;
  origine: 'POS' | 'SAMERTRACKLY';
  saisie_le: string | null;
}

/** Une explication d'écart POS telle que SamerTrackly la conserve. */
export interface ExplicationInventaireSiege {
  ligne_id: string;
  inventaire_id: string;
  point_id: string;
  pos_service_id: string;
  restaurant_id: string;
  restaurant_nom: string;
  date: string;
  type_shift: string;
  heure_debut: string | null;
  heure_fin: string | null;
  caissier_id: string | null;
  caissier_nom: string;
  produit_code: string;
  produit_nom: string;
  stock_theorique: number;
  stock_compte: number | null;
  ecart: number | null;
  quantite_expliquee: number;
  explication: string | null;
  montant_deduit: number;
  statut: StatutExplicationInventaire;
  quantite_acceptee: number | null;
  decidee_par: string | null;
  decidee_le: string | null;
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
  /** Sortie pointée à la pointeuse (2026-10-26) ; NULL = pas de sortie pointée. */
  parti_le?: string | null;
  /** Absences Sortie → Entrée du shift, déduites des heures. */
  minutes_absence?: number;
  /** NULL = pas tranché ; à la clôture, tout ce qui n'est pas `true` est PARTI. */
  reste: boolean | null;
  /** Payé à la journée : montant et HEURE DE PAIE, qui vaut heure de départ. */
  salaire: { montant: number; paye_le: string } | null;
}

/**
 * Un participant au tirage des clients du mois. Le classement vient de la
 * fonction `siege` (`siege_clients_mois` + départage dans `_shared/siege-tirage.ts`).
 */
export interface ParticipantTirage {
  rang: number;
  client_id: string;
  telephone: string;
  /** Facultatif à la caisse : sans nom, on affiche le téléphone. */
  nom: string | null;
  montant: number;
  nb_visites: number;
}

/** Procès-verbal d'un tirage — append-only côté cloud, un par restaurant et par mois. */
export interface TirageClients {
  id: string;
  restaurant_id: string;
  /** Premier jour du mois concerné : « 2026-10-01 ». */
  mois: string;
  tire_le: string;
  tire_par_nom: string;
  /** La liste FIGÉE au moment du tirage, dans l'ordre du classement. */
  participants: ParticipantTirage[];
  gagnant_client_id: string;
  gagnant_rang: number;
}

/** Réponse de l'action `clients_mois`. */
export interface ClientsMois {
  mois: string;
  /** Un mois en cours se consulte mais ne se tire pas. */
  mois_termine: boolean;
  /** Classement d'aujourd'hui ; après le tirage, c'est `tirage.participants` qui fait foi. */
  participants: ParticipantTirage[];
  tirage: TirageClients | null;
}
