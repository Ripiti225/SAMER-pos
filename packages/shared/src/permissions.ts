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
    // Caisse (comme avant)
    'caisse.service.ouvrir', 'caisse.encaisser', 'caisse.remise', 'caisse.annuler_envoye',
    'caisse.rouvrir', 'caisse.cloturer', 'caisse.imprimer_note',
    // Salle
    'salle.commande', 'salle.envoyer_cuisine', 'salle.transferer_table', 'salle.voir_toutes_tables',
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
  ],

  SERVEUR: ['salle.commande', 'salle.envoyer_cuisine'],

  CUISINE: ['cuisine.avancer'],
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
