/**
 * Catalogue FIXE des permissions (sprint 4B+4C). On compose des rôles à partir
 * de cette liste ; on n'invente pas de capacités. Libellés en français.
 * La permission « roles.gerer » est PROTÉGÉE (1.4) : réservée à SUPERVISEUR et
 * PROPRIETAIRE, jamais cochable ailleurs.
 */

export interface Permission {
  cle: string;
  libelle: string;
}
export interface SectionPermissions {
  cle: string;
  libelle: string;
  permissions: Permission[];
}

export const SECTIONS_PERMISSIONS: SectionPermissions[] = [
  {
    cle: 'caisse',
    libelle: 'Caisse',
    permissions: [
      { cle: 'caisse.service.ouvrir', libelle: 'Ouvrir un service' },
      { cle: 'caisse.encaisser', libelle: 'Encaisser' },
      { cle: 'caisse.remise', libelle: 'Faire une remise' },
      { cle: 'caisse.annuler_envoye', libelle: 'Annuler un article envoyé' },
      { cle: 'caisse.rouvrir', libelle: 'Rouvrir une commande payée' },
      { cle: 'caisse.cloturer', libelle: 'Clôturer le service' },
      { cle: 'caisse.fermer_sequence', libelle: 'Fermer la séquence (journée)' },
      { cle: 'caisse.imprimer_note', libelle: 'Imprimer la note' },
    ],
  },
  {
    cle: 'salle',
    libelle: 'Salle',
    permissions: [
      { cle: 'salle.commande', libelle: 'Prendre une commande' },
      { cle: 'salle.envoyer_cuisine', libelle: 'Envoyer en cuisine' },
      { cle: 'salle.transferer_table', libelle: 'Transférer une table' },
      { cle: 'salle.voir_toutes_tables', libelle: 'Voir toutes les tables' },
    ],
  },
  {
    cle: 'cuisine',
    libelle: 'Cuisine',
    permissions: [{ cle: 'cuisine.avancer', libelle: 'Avancer les commandes (KDS)' }],
  },
  /**
   * Dépenses, inventaire et pointage (DESIGN_V2 § 6.7 à § 6.10) — rattachés au
   * système de permissions le 2026-08-17.
   *
   * Ces trois modules étaient tous gardés par `caisse.service.ouvrir`. Ils
   * n'apparaissaient donc PAS dans « Rôles & accès » : impossible de les
   * accorder ou de les retirer. Et surtout, quiconque pouvait ouvrir un service
   * pouvait sortir de l'argent du tiroir — enregistrer un salaire, un
   * encouragement — et faire passer une clôture sans inventaire conforme.
   *
   * Le découpage sépare la SAISIE courante (le travail du caissier) des actes
   * d'encadrement : payer un salaire et débloquer un inventaire.
   */
  {
    cle: 'depenses',
    libelle: 'Dépenses & inventaire',
    permissions: [
      { cle: 'depenses.saisir', libelle: 'Enregistrer une dépense' },
      { cle: 'depenses.supprimer', libelle: 'Supprimer une dépense' },
      { cle: 'depenses.paie', libelle: 'Payer un salaire ou un encouragement' },
      { cle: 'inventaire.saisir', libelle: "Saisir l'inventaire et les entrées de stock" },
      { cle: 'inventaire.valider', libelle: "Valider l'inventaire" },
      { cle: 'inventaire.debloquer', libelle: 'Débloquer une clôture sans inventaire' },
      { cle: 'pointage.gerer', libelle: 'Pointages (arrivées et départs)' },
    ],
  },
  {
    cle: 'rapports',
    libelle: 'Rapports',
    permissions: [
      { cle: 'rapports.x', libelle: 'Rapport X' },
      { cle: 'rapports.z', libelle: 'Rapport Z' },
      { cle: 'rapports.tableau_bord', libelle: 'Tableau de bord' },
      { cle: 'rapports.notation', libelle: 'Récap notation' },
    ],
  },
  {
    cle: 'reglages',
    libelle: 'Réglages',
    permissions: [
      { cle: 'reglages.equipe', libelle: 'Équipe' },
      { cle: 'reglages.salle', libelle: 'Salle & QR' },
      { cle: 'reglages.disponibilite', libelle: 'Disponibilité des plats' },
      { cle: 'reglages.catalogue', libelle: 'Catalogue' },
      { cle: 'reglages.fidelite', libelle: 'Fidélité' },
      { cle: 'reglages.parametres', libelle: 'Paramètres' },
      { cle: 'reglages.restaurant', libelle: 'Configurer le restaurant' },
      { cle: 'reglages.audit', libelle: "Journal d'audit" },
      { cle: 'reglages.sante', libelle: 'Santé du système' },
    ],
  },
  {
    cle: 'roles',
    libelle: 'Rôles & accès',
    permissions: [{ cle: 'roles.gerer', libelle: 'Gérer les rôles et les accès' }],
  },
];

export const TOUTES_PERMISSIONS: string[] = SECTIONS_PERMISSIONS.flatMap((s) =>
  s.permissions.map((p) => p.cle),
);

/** Permission protégée (1.4) : jamais sur un rôle personnalisé ni sur M/C/S/CU. */
export const PERMISSION_PROTEGEE = 'roles.gerer';

/** Rôles système (nom = valeur de l'ancien enum). */
export const ROLES_SYSTEME = [
  'PROPRIETAIRE',
  'SUPERVISEUR',
  'MANAGER',
  'CAISSIER',
  'SERVEUR',
  'CUISINE',
  // Ajoutés le 2026-08-17 (migration 0024). Ils existaient dans la réalité du
  // restaurant mais pas dans le POS : la descente SamerTrackly rangeait un
  // comptoiriste avec les CAISSIERS (donc encaissement, remise, réouverture
  // d'une commande payée) et un agent d'entretien avec la CUISINE.
  'COMPTOIRISTE',
  'ENTRETIEN',
] as const;
export type RoleSysteme = (typeof ROLES_SYSTEME)[number];

/**
 * Permissions par défaut des rôles système. Elles reproduisent EXACTEMENT les
 * accès actuels (1.2) pour les capacités déjà existantes, et appliquent les
 * défauts Réglages du 2.2 pour les nouvelles sections.
 */
export const PERMISSIONS_DEFAUT: Record<RoleSysteme, string[]> = {
  // Propriétaire et Superviseur : tout, en permanence.
  PROPRIETAIRE: [...TOUTES_PERMISSIONS],
  SUPERVISEUR: [...TOUTES_PERMISSIONS],

  MANAGER: [
    // Caisse (comme avant) + fermeture de séquence (le proprio peut la retirer)
    'caisse.service.ouvrir', 'caisse.encaisser', 'caisse.remise', 'caisse.annuler_envoye',
    'caisse.rouvrir', 'caisse.cloturer', 'caisse.fermer_sequence', 'caisse.imprimer_note',
    // Salle
    'salle.commande', 'salle.envoyer_cuisine', 'salle.transferer_table', 'salle.voir_toutes_tables',
    // Dépenses & inventaire
    'depenses.saisir', 'depenses.supprimer', 'depenses.paie',
    'inventaire.saisir', 'inventaire.valider', 'inventaire.debloquer', 'pointage.gerer',
    // Rapports (sauf tableau de bord propriétaire)
    'rapports.x', 'rapports.z', 'rapports.notation',
    // Réglages (2.2 : tout sauf catalogue, fidélité, rôles)
    'reglages.equipe', 'reglages.salle', 'reglages.disponibilite', 'reglages.parametres',
    'reglages.audit', 'reglages.sante',
  ],

  CAISSIER: [
    'caisse.service.ouvrir', 'caisse.encaisser', 'caisse.remise', 'caisse.annuler_envoye',
    'caisse.rouvrir', 'caisse.cloturer', 'caisse.imprimer_note',
    'salle.commande', 'salle.envoyer_cuisine', 'salle.transferer_table', 'salle.voir_toutes_tables',
    /**
     * Dépenses & inventaire : le caissier les avait TOUTES avant le
     * 2026-08-17, puisque le seul garde était `caisse.service.ouvrir`. On les
     * lui laisse pour que personne ne perde d'accès du jour au lendemain —
     * règle du sprint 4B (« les employés existants conservent exactement leurs
     * accès »). C'est maintenant un réglage : décocher « Payer un salaire » et
     * « Débloquer une clôture sans inventaire » sur le rôle CAISSIER est le
     * durcissement à faire, et il se fait en deux clics dans Rôles & accès.
     */
    'depenses.saisir', 'depenses.supprimer', 'depenses.paie',
    'inventaire.saisir', 'inventaire.valider', 'inventaire.debloquer', 'pointage.gerer',
  ],

  SERVEUR: ['salle.commande', 'salle.envoyer_cuisine'],

  CUISINE: ['cuisine.avancer'],

  /**
   * COMPTOIRISTE — écran cuisine uniquement (tranché le 2026-08-17).
   * Mêmes droits que CUISINE : il prépare au comptoir et fait avancer ses
   * plats. Ce qui le distingue n'est pas la permission mais son
   * `poste_cuisine = COMPTOIRISTE`, qui lui fait attribuer les plats du
   * comptoir. Il n'a AUCUNE permission hors cuisine, donc `peutAccederCaisse()`
   * lui refuse la connexion à la caisse — côté serveur, pas côté écran.
   */
  COMPTOIRISTE: ['cuisine.avancer'],

  /**
   * ENTRETIEN (technicien de surface, ménagère, plonge) — aucune application.
   * La liste vide est le réglage voulu : le compte existe pour l'équipe du jour
   * et les présences, mais ne se connecte nulle part. Il ne doit surtout pas
   * rester en CUISINE : `attribution.ts` ne retient que les rôles cuisine, et
   * un `poste_cuisine` vide se rabat sur CUISINIER — l'agent d'entretien se
   * voyait donc créditer des plats qu'il n'a jamais préparés.
   */
  ENTRETIEN: [],
};

/** Rôles système dont les permissions sont VERROUILLÉES (toujours tout, 1.3/2.8). */
export const ROLES_VERROUILLES: string[] = ['PROPRIETAIRE', 'SUPERVISEUR'];

/** Clés du groupe Réglages (+ Rôles & accès) : ouvrent l'onglet Administration. */
export const PERMISSIONS_ADMIN: string[] = [
  ...(SECTIONS_PERMISSIONS.find((s) => s.cle === 'reglages')?.permissions.map((p) => p.cle) ?? []),
  PERMISSION_PROTEGEE,
];

/** true si `cle` fait partie du catalogue (aucune permission inventée). */
export function estPermissionConnue(cle: string): boolean {
  return TOUTES_PERMISSIONS.includes(cle);
}

/**
 * Permissions purement KDS (cuisine) : un compte qui n'a QUE celles-ci ne se
 * connecte pas au POS caisse (il travaille sur le KDS, par jeton d'appareil).
 */
export const PERMISSIONS_CUISINE_SEULE: string[] = ['cuisine.avancer'];

/**
 * true si l'utilisateur peut se connecter au POS caisse : il possède au moins
 * une permission qui n'est pas purement cuisine. Appliqué CÔTÉ SERVEUR au login
 * (le rôle CUISINE, dont la seule permission est `cuisine.avancer`, est refusé).
 */
export function peutAccederCaisse(permissions: string[]): boolean {
  return permissions.some((p) => !PERMISSIONS_CUISINE_SEULE.includes(p));
}

/**
 * Permissions purement SALLE : un compte qui n'a QUE celles-ci travaille sur la
 * tablette serveur, pas sur la caisse centrale. C'est exactement le rôle
 * SERVEUR — le CAISSIER les possède aussi, mais avec l'encaissement en plus.
 */
export const PERMISSIONS_SALLE_SEULE: string[] = ['salle.commande', 'salle.envoyer_cuisine'];

/**
 * true si le compte a sa place sur l'écran de connexion de la CAISSE CENTRALE :
 * il possède au moins une permission qui n'est ni purement cuisine, ni purement
 * salle (2026-09-05).
 *
 * Le serveur ne tient pas la caisse : sa liste de noms n'a rien à faire sur
 * l'écran de connexion du comptoir, où elle allongeait le choix et invitait à
 * ouvrir un service au nom de quelqu'un qui n'encaisse pas.
 *
 * ATTENTION — ceci filtre un AFFICHAGE, pas un droit de connexion. La tablette
 * serveur se connecte par la même route `/api/auth/login` : y refuser le rôle
 * SERVEUR fermerait la porte à sa propre application. Ce que le serveur peut
 * FAIRE reste, comme toujours, gouverné par ses permissions.
 */
export function tientLaCaisse(permissions: string[]): boolean {
  return permissions.some(
    (p) => !PERMISSIONS_CUISINE_SEULE.includes(p) && !PERMISSIONS_SALLE_SEULE.includes(p),
  );
}

/**
 * Catalogue des paramètres locaux éditables depuis Réglages (2.6), avec libellé
 * français, type d'entrée et valeur par défaut. La route serveur n'accepte QUE
 * ces clés (liste blanche). Les paramètres de fidélité sont gérés à part (2.5).
 */
export interface ParametreEditable {
  cle: string;
  libelle: string;
  type: 'entier' | 'texte' | 'booleen' | 'position';
  unite?: string;
  defaut: number | string | boolean;
}

export const PARAMETRES_EDITABLES: ParametreEditable[] = [
  { cle: 'verrou_inactivite_caisse_secondes', libelle: 'Verrouillage caisse après inactivité (0 = désactivé)', type: 'entier', unite: 's', defaut: 0 },
  { cle: 'verrouillage_inactivite_serveur_secondes', libelle: 'Verrouillage tablette serveur (0 = désactivé)', type: 'entier', unite: 's', defaut: 0 },
  { cle: 'seuil_alerte_ecart_caisse', libelle: "Seuil d'alerte écart de caisse", type: 'entier', unite: 'FCFA', defaut: 2000 },
  { cle: 'kds_seuil_vert_minutes', libelle: 'Chrono KDS — seuil vert', type: 'entier', unite: 'min', defaut: 5 },
  { cle: 'kds_seuil_orange_minutes', libelle: 'Chrono KDS — seuil orange', type: 'entier', unite: 'min', defaut: 10 },
  { cle: 'commande_client_expiration_minutes', libelle: "Expiration des commandes client (QR)", type: 'entier', unite: 'min', defaut: 15 },
  { cle: 'ticket_entete', libelle: 'En-tête du ticket', type: 'texte', defaut: '' },
  { cle: 'ticket_pied', libelle: 'Pied du ticket', type: 'texte', defaut: '' },
  { cle: 'url_base_client', libelle: 'Adresse web des QR clients', type: 'texte', defaut: '' },
  { cle: 'imprimante_thermique_queue', libelle: 'Imprimante thermique (file CUPS)', type: 'texte', defaut: '' },
  /**
   * Mot de passe de l'ÉCRAN CUISINE (le KDS s'identifie par un jeton
   * d'appareil, jamais par un PIN humain — correction 3). Éditable ici depuis
   * le 2026-08-16 : `preparer-base-master.sql` supprime volontairement cette
   * clé de l'image (un site ne doit pas hériter du jeton d'un autre), et sans
   * elle le serveur refusait TOUT jeton, y compris le bon — l'installation de
   * la cuisine était bloquée sans aucune valeur à trouver nulle part.
   * À l'installation : poser une valeur ici, la taper une fois sur l'écran
   * cuisine. Vide = aucun écran cuisine autorisé.
   */
  { cle: 'kds_jeton_appareil', libelle: 'Jeton de l’écran cuisine (à saisir une fois sur le KDS)', type: 'texte', defaut: '' },
];

export const CLES_PARAMETRES_EDITABLES: string[] = PARAMETRES_EDITABLES.map((p) => p.cle);

/**
 * Nettoie une liste de permissions demandée pour un rôle NON verrouillé :
 * ne garde que les permissions connues et retire la permission protégée (1.4).
 * Retourne aussi si la permission protégée avait été demandée (pour auditer/refuser).
 */
export function filtrerPermissionsRole(demandees: string[]): {
  permissions: string[];
  protegeeDemandee: boolean;
  inconnues: string[];
} {
  const uniques = [...new Set(demandees)];
  const inconnues = uniques.filter((c) => !estPermissionConnue(c));
  const protegeeDemandee = uniques.includes(PERMISSION_PROTEGEE);
  const permissions = uniques.filter((c) => estPermissionConnue(c) && c !== PERMISSION_PROTEGEE);
  return { permissions, protegeeDemandee, inconnues };
}
