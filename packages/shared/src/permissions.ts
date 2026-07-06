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
      { cle: 'reglages.pointage', libelle: 'Corrections de pointage' },
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
    'reglages.pointage', 'reglages.audit', 'reglages.sante',
  ],

  CAISSIER: [
    'caisse.service.ouvrir', 'caisse.encaisser', 'caisse.remise', 'caisse.annuler_envoye',
    'caisse.rouvrir', 'caisse.cloturer', 'caisse.imprimer_note',
    'salle.commande', 'salle.envoyer_cuisine', 'salle.transferer_table', 'salle.voir_toutes_tables',
  ],

  SERVEUR: ['salle.commande', 'salle.envoyer_cuisine'],

  CUISINE: ['cuisine.avancer'],
};
