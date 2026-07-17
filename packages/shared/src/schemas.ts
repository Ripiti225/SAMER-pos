import { z } from 'zod';
import { MODES_PAIEMENT, PINS_INTERDITS, POSTES_JOUR, TYPES_COMMANDE } from './constantes.js';

/** PIN 4 à 6 chiffres, hors liste interdite (§14.1). */
export const PinSchema = z
  .string()
  .regex(/^\d{4,6}$/, 'Le PIN doit comporter 4 à 6 chiffres')
  .refine((pin) => !PINS_INTERDITS.includes(pin), 'Ce PIN est trop facile à deviner');

/** À la connexion on valide seulement le format, pas la liste interdite. */
export const PinSaisiSchema = z.string().regex(/^\d{4,6}$/, 'Le PIN doit comporter 4 à 6 chiffres');

export const LoginSchema = z.object({
  utilisateur_id: z.string().uuid('Utilisateur invalide'),
  pin: PinSaisiSchema,
});

export const DeverrouillerSchema = z.object({ pin: PinSaisiSchema });

/** Un membre de l'équipe du jour : qui + son poste pour la journée. */
export const MembreEquipeSchema = z.object({
  utilisateur_id: z.string().uuid(),
  poste_jour: z.enum(POSTES_JOUR),
});

export const OuvrirServiceSchema = z.object({
  fond_de_caisse: z
    .number({ invalid_type_error: 'Le fond de caisse doit être un montant en FCFA' })
    .int('Le fond de caisse doit être un montant entier en FCFA')
    .min(0, 'Le fond de caisse ne peut pas être négatif'),
  // Équipe du jour (allègement) : présents + poste du jour. Optionnelle.
  equipe: z.array(MembreEquipeSchema).max(50).optional(),
});

/**
 * Transfert des commandes en cours au caissier suivant (relève de caisse) :
 * le receveur ACCEPTE le transfert en saisissant son propre PIN.
 */
export const TransfererServiceSchema = z.object({
  receveur_id: z.string().uuid('Caissier receveur invalide'),
  pin_receveur: PinSaisiSchema,
});

const MontantPositif = z.number().int().min(0);

/**
 * Fermeture de shift avec réconciliation (§ brief). Le comptage aveugle est
 * préservé : `especes_comptees` est saisi sans que l'écart soit révélé avant.
 * `livraisons` (Yango/Glovo/Samer Deliv) et `modes` (électroniques) sont des
 * dictionnaires — toute clé absente vaut 0.
 */
export const CloturerServiceSchema = z.object({
  especes_comptees: z
    .number({ invalid_type_error: 'Le montant compté doit être un nombre' })
    .int('Le montant compté doit être un montant entier en FCFA')
    .min(0, 'Le montant compté ne peut pas être négatif'),
  depenses: MontantPositif.default(0),
  livraisons: z.record(z.string(), MontantPositif).default({}),
  modes: z.record(z.string(), MontantPositif).default({}),
});

export const CreerCommandeSchema = z
  .object({
    type: z.enum(TYPES_COMMANDE, { errorMap: () => ({ message: 'Type de commande invalide' }) }),
    table_id: z.string().uuid().nullish(),
    partenaire: z.string().min(1).nullish(),
    ref_partenaire: z.string().min(1).nullish(),
  })
  .refine((c) => c.type !== 'SUR_PLACE' || !!c.table_id, {
    message: 'Choisissez une table pour une commande sur place',
  });

export const OptionChoisieSchema = z.object({
  groupe: z.string().min(1),
  choix: z.array(z.string().min(1)),
});

export const SupplementChoisiSchema = z.object({
  id: z.string().uuid(),
});

export const AjouterItemSchema = z
  .object({
    article_id: z.string().uuid().nullish(),
    combo_id: z.string().uuid().nullish(),
    quantite: z.number().int().min(1, 'La quantité doit être au moins 1').max(99),
    options: z.array(OptionChoisieSchema).default([]),
    supplements: z.array(SupplementChoisiSchema).default([]),
  })
  .refine((i) => !!i.article_id !== !!i.combo_id, {
    message: 'Choisissez un article ou un combo',
  });

export const ModifierItemSchema = z.object({
  quantite: z.number().int().min(1, 'La quantité doit être au moins 1').max(99),
});

const MotifObligatoire = z
  .string({ required_error: 'Le motif est obligatoire' })
  .trim()
  .min(3, 'Le motif est obligatoire');

export const AnnulerItemSchema = z.object({
  motif: MotifObligatoire,
  pin_manager: PinSaisiSchema.nullish(),
});

export const RemiseSchema = z.object({
  montant: z
    .number({ required_error: 'Le montant de la remise est obligatoire' })
    .int()
    .min(1, 'Le montant de la remise doit être positif'),
  motif: z
    .string({ required_error: 'Le motif de la remise est obligatoire' })
    .trim()
    .min(3, 'Le motif de la remise est obligatoire'),
  pin_manager: z
    .string({ required_error: 'Le PIN manager est obligatoire' })
    .regex(/^\d{4,6}$/, 'Le PIN doit comporter 4 à 6 chiffres'),
});

export const ReouvrirSchema = z.object({
  motif: MotifObligatoire,
  pin_manager: PinSaisiSchema,
});

export const AnnulerCommandeSchema = z.object({
  motif: MotifObligatoire,
  pin_manager: PinSaisiSchema,
});

export const PaiementSchema = z.object({
  mode: z.enum(MODES_PAIEMENT, { errorMap: () => ({ message: 'Mode de paiement invalide' }) }),
  montant: z.number().int().min(1, 'Le montant doit être positif'),
  note_id: z.string().uuid().nullish(),
});

export const SplitSchema = z.object({
  notes: z
    .array(
      z.object({
        libelle: z.string().trim().min(1, 'Chaque note doit avoir un libellé'),
        montant: z.number().int().min(1, 'Chaque note doit avoir un montant positif'),
      }),
    )
    .min(2, 'Un split comporte au moins 2 notes'),
});

// ---------------------------------------------------------------------------
// Sprint 2 — App serveur tablette (actions idempotentes, file anti-coupure §B4)
// ---------------------------------------------------------------------------

/**
 * « Envoyer en cuisine » depuis la tablette : UNE action idempotente qui crée
 * la commande de table si besoin, ajoute le lot d'articles et l'envoie au KDS.
 * L'action_uuid est généré sur la tablette ; rejouer le même uuid est sans effet.
 */
export const EnvoyerCuisineSchema = z.object({
  action_uuid: z.string().uuid('Action invalide'),
  table_id: z.string().uuid('Table invalide'),
  items: z.array(AjouterItemSchema).min(1, 'Ajoutez au moins un article avant d’envoyer'),
});

export const DemanderAdditionSchema = z.object({
  action_uuid: z.string().uuid('Action invalide'),
  table_id: z.string().uuid('Table invalide'),
});

// ---------------------------------------------------------------------------
// CORRECTIONS3 — circuit client ↔ serveur
// ---------------------------------------------------------------------------

/** Appel client (téléphone via QR) : appeler le serveur ou demander la facture. */
export const AppelClientSchema = z.object({
  type: z.enum(['APPEL_SERVEUR', 'DEMANDE_FACTURE'], {
    errorMap: () => ({ message: 'Type d’appel invalide' }),
  }),
});

/** Proposition de commande depuis le téléphone client (jamais envoyée en cuisine directement). */
export const CommandeClientSchema = z.object({
  items: z.array(AjouterItemSchema).min(1, 'Ajoutez au moins un article'),
});

/** Refus d'une commande client (message obligatoire montré au client). */
export const RefusCommandeSchema = z.object({
  motif: z.string().trim().min(3, 'Indiquez la raison du refus (montrée au client)'),
});

/** Transfert d'une table à un autre serveur (caisse/manager uniquement). */
export const TransfertTableSchema = z.object({
  serveur_id: z.string().uuid('Serveur invalide'),
});

// ---------------------------------------------------------------------------
// SPRINT 4 — Fidélité (§9)
// ---------------------------------------------------------------------------

/** Numéro de téléphone du client fidélité (saisi au paiement). */
export const TelephoneFideliteSchema = z
  .string()
  .trim()
  .regex(/^[+0-9][0-9 ]{5,19}$/, 'Numéro de téléphone invalide');

// ---------------------------------------------------------------------------
// SPRINT 4B/4C — Administration (Réglages)
// ---------------------------------------------------------------------------

const NomRoleSchema = z.string().trim().min(2, 'Nom de rôle trop court').max(40, 'Nom de rôle trop long');
const PermissionsSchema = z.array(z.string().min(1)).max(64);

/** Création d'un rôle personnalisé. */
export const CreerRoleSchema = z.object({
  nom: NomRoleSchema,
  permissions: PermissionsSchema,
});

/** Modification d'un rôle (nom optionnel, permissions remplacées). */
export const ModifierRoleSchema = z.object({
  nom: NomRoleSchema.optional(),
  permissions: PermissionsSchema,
});

/** Duplication d'un rôle existant sous un nouveau nom. */
export const DupliquerRoleSchema = z.object({ nom: NomRoleSchema });

const NomCompletSchema = z.string().trim().min(2, 'Nom trop court').max(80, 'Nom trop long');
const TelephoneSchema = z.string().trim().regex(/^[+0-9][0-9 ]{5,19}$/, 'Numéro de téléphone invalide').optional();
const PosteCuisineSchema = z.enum(['CUISINIER', 'PIZZAIOLO', 'COMPTOIRISTE']).nullish();

/** Création d'un employé (le PIN est posé ensuite par l'employé lui-même). */
export const CreerEmployeSchema = z.object({
  nom_complet: NomCompletSchema,
  role_id: z.string().uuid('Rôle invalide'),
  poste_cuisine: PosteCuisineSchema,
  telephone: TelephoneSchema,
});

/** Modification d'un employé (rôle, poste, téléphone, intitulé, photo). */
export const ModifierEmployeSchema = z.object({
  nom_complet: NomCompletSchema.optional(),
  role_id: z.string().uuid('Rôle invalide').optional(),
  poste_cuisine: PosteCuisineSchema,
  telephone: TelephoneSchema,
  // Intitulé de poste RH (libre) et photo (URL) — chaîne vide = effacer.
  poste: z.string().trim().max(60, 'Intitulé trop long').nullish(),
  photo_url: z.string().trim().max(500, 'URL trop longue').nullish(),
});

/** Changement de disponibilité RH d'un employé (présent / malade / congé / permission). */
export const MajDisponibiliteSchema = z.object({
  disponibilite: z.enum(['PRESENT', 'MALADE', 'CONGE', 'PERMISSION']),
});

/** Configuration de l'identité du restaurant (choix depuis SamerTrackly). */
export const ConfigRestaurantSchema = z.object({
  samtrackly_restaurant_id: z.string().uuid('Restaurant invalide'),
});

/** Pose du PIN par l'employé (code temporaire à usage unique + PIN choisi deux fois). */
export const PoserPinSchema = z
  .object({
    utilisateur_id: z.string().uuid('Employé invalide'),
    code_temporaire: z.string().regex(/^\d{6}$/, 'Code temporaire à 6 chiffres'),
    pin: PinSchema,
    pin_confirmation: PinSchema,
  })
  .refine((v) => v.pin === v.pin_confirmation, {
    message: 'Les deux PIN saisis ne correspondent pas',
    path: ['pin_confirmation'],
  });

// Salle (zones & tables)
export const CreerZoneSchema = z.object({ nom: z.string().trim().min(1).max(40), ordre: z.number().int().optional() });
export const ModifierZoneSchema = z.object({ nom: z.string().trim().min(1).max(40).optional(), ordre: z.number().int().optional() });
export const CreerTableSchema = z.object({
  zone_id: z.string().uuid('Zone invalide'),
  numero: z.string().trim().min(1).max(20),
  partenaire: z.string().trim().max(40).nullish(),
});
export const ModifierTableSchema = z.object({
  numero: z.string().trim().min(1).max(20).optional(),
  zone_id: z.string().uuid().optional(),
  actif: z.boolean().optional(),
});

/** Disponibilité locale d'un article (2.3). */
export const DisponibiliteSchema = z.object({ disponible: z.boolean() });

/** Modification d'un paramètre local (2.6). */
export const ModifierParametreSchema = z.object({
  cle: z.string().trim().min(1),
  valeur: z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown())]),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type CreerCommandeInput = z.infer<typeof CreerCommandeSchema>;
export type AjouterItemInput = z.infer<typeof AjouterItemSchema>;
export type PaiementInput = z.infer<typeof PaiementSchema>;
export type CreerRoleInput = z.infer<typeof CreerRoleSchema>;
export type ModifierRoleInput = z.infer<typeof ModifierRoleSchema>;
export type CreerEmployeInput = z.infer<typeof CreerEmployeSchema>;
