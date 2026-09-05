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
 * `modes` (électroniques) est un dictionnaire — toute clé absente vaut 0.
 *
 * Deux champs ne sont plus lus, et restent acceptés seulement pour ne pas
 * casser une caisse pas encore rebuildée (DESIGN_V2 § 6.8 / § 6.10) :
 * - `depenses` : le serveur additionne le registre des dépenses ;
 * - `livraisons` : montants partenaires non modifiables, calculés depuis les
 *   commandes payées. Le POS est la source officielle des ventes.
 */
export const CloturerServiceSchema = z.object({
  especes_comptees: z
    .number({ invalid_type_error: 'Le montant compté doit être un nombre' })
    .int('Le montant compté doit être un montant entier en FCFA')
    .min(0, 'Le montant compté ne peut pas être négatif'),
  /** @deprecated ignoré — somme du registre des dépenses côté serveur. */
  depenses: MontantPositif.default(0),
  /** @deprecated ignoré — calculé depuis les commandes payées. */
  livraisons: z.record(z.string(), MontantPositif).default({}),
  modes: z.record(z.string(), MontantPositif).default({}),
});

/** Accusé final du ticket. Un écart non nul rend l'explication obligatoire côté serveur. */
export const RemettreClotureSchema = z.object({
  explication_ecart: z.string().trim().min(3, 'Expliquez l’écart de caisse avant de terminer').max(500).optional(),
});

/**
 * Rasage de séquence (journée). Le gérant choisit LES SHIFTS qui composent la
 * journée : une séquence contient parfois le début de la journée suivante (le
 * créneau d'ouverture n'est pas figé) et un shift encore ouvert ne doit plus
 * bloquer la fermeture — il repart simplement dans la séquence suivante.
 *
 * `service_ids` omis = tous les shifts CLÔTURÉS de la séquence (le cas normal).
 */
export const CloturerSequenceSchema = z.object({
  service_ids: z.array(z.string().uuid('Shift invalide')).optional(),
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

/**
 * Infos d'une commande partenaire, saisies dans la modale qui s'ouvre au
 * lancement en cuisine (n° de commande chez Yango/Glovo, téléphone du client).
 *
 * Les deux champs sont facultatifs — le caissier peut fermer sans rien mettre,
 * et le ticket Z compte alors une commande sans contact. Mais un enregistrement
 * entièrement vide est refusé : il n'ajouterait rien et EFFACERAIT une saisie
 * précédente, sur une donnée qu'on veut justement ne pas perdre.
 */
export const InfosLivraisonSchema = z
  .object({
    ref_partenaire: z.string().trim().max(60, 'Numéro de commande trop long').nullish(),
    contact_client: z.string().trim().max(40, 'Contact trop long').nullish(),
  })
  .refine((i) => !!i.ref_partenaire || !!i.contact_client, {
    message: 'Renseignez au moins le numéro de commande ou le contact du client',
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

// ---------------------------------------------------------------------------
// Options réutilisables (migration 0020) — administration
// ---------------------------------------------------------------------------

/** Le prix est porté par l'option : 0 = gratuite (pâte à l'ail), > 0 = payante. */
export const CreerOptionSchema = z.object({
  nom: z.string().trim().min(1, 'Le nom de l’option est obligatoire').max(60),
  prix: z.number().int().min(0, 'Le prix ne peut pas être négatif').max(1000000),
});

export const ModifierOptionSchema = z
  .object({
    nom: z.string().trim().min(1, 'Le nom de l’option est obligatoire').max(60).optional(),
    prix: z.number().int().min(0, 'Le prix ne peut pas être négatif').max(1000000).optional(),
    actif: z.boolean().optional(),
    ordre: z.number().int().min(0).max(999).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Aucune modification demandée' });

// ---------------------------------------------------------------------------
// Promotions — administration (brief 4C § 2.4, livré le 2026-08-17)
// ---------------------------------------------------------------------------
// Les promotions s'appliquent AUTOMATIQUEMENT côté serveur dès que le jour et
// l'heure correspondent (`catalogue/promos.ts`). Il n'existait aucun écran pour
// les voir ni les arrêter : l'image de déploiement porte une « Happy Hour
// −20 % » active tous les jours de 17 h à 19 h, soit le créneau le plus chargé,
// et le seul moyen de l'éteindre était d'aller dans la base.

/** `heure_debut`/`heure_fin` : « HH:MM » ou « HH:MM:SS » (type `time` en base). */
const HeureSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Heure invalide (attendu HH:MM)');

/** Jour ISO : 1 = lundi … 7 = dimanche, comme le stocke le schéma. */
const JoursSchema = z
  .array(z.number().int().min(1, 'Jour invalide').max(7, 'Jour invalide'))
  .min(1, 'Choisissez au moins un jour')
  .max(7);

const champsPromo = {
  nom: z.string().trim().min(1, 'Le nom de la promotion est obligatoire').max(80),
  type: z.enum(['POURCENTAGE', 'MONTANT'], { errorMap: () => ({ message: 'Type de promotion invalide' }) }),
  valeur: z.number().int('La valeur doit être un nombre entier').min(1, 'La valeur doit être supérieure à zéro'),
  heure_debut: HeureSchema.nullish(),
  heure_fin: HeureSchema.nullish(),
  jours: JoursSchema,
  /** Promotion ciblée sur un article, ou sur toute la commande si absent. */
  article_id: z.string().uuid('Article invalide').nullish(),
  actif: z.boolean(),
};

/**
 * Une remise en pourcentage au-delà de 100 % rendrait la commande négative.
 * Vérifié ici plutôt qu'en base : le message doit être lisible par le manager.
 * De même, une plage horaire se donne entière ou pas du tout — n'en fournir
 * qu'une moitié laisserait `promotionActive()` ignorer l'horaire en silence et
 * la promo tournerait 24 h sur 24.
 */
interface PromoBrute {
  type: string;
  valeur: number;
  heure_debut?: string | null;
  heure_fin?: string | null;
}

const remiseSensee = (v: PromoBrute): boolean => v.type !== 'POURCENTAGE' || v.valeur <= 100;
const plageEntiere = (v: PromoBrute): boolean => !!v.heure_debut === !!v.heure_fin;
const plageOrdonnee = (v: PromoBrute): boolean =>
  !v.heure_debut || !v.heure_fin || v.heure_debut < v.heure_fin;

const MSG_POURCENT = { message: 'Une remise en pourcentage ne peut pas dépasser 100 %', path: ['valeur'] };
const MSG_PLAGE = { message: 'Donnez l’heure de début ET l’heure de fin, ou aucune des deux', path: ['heure_fin'] };
const MSG_ORDRE = { message: 'L’heure de fin doit être après l’heure de début', path: ['heure_fin'] };

export const CreerPromotionSchema = z
  .object({ ...champsPromo, actif: champsPromo.actif.default(true) })
  .refine(remiseSensee, MSG_POURCENT)
  .refine(plageEntiere, MSG_PLAGE)
  .refine(plageOrdonnee, MSG_ORDRE);

export const ModifierPromotionSchema = z
  .object(champsPromo)
  .refine(remiseSensee, MSG_POURCENT)
  .refine(plageEntiere, MSG_PLAGE)
  .refine(plageOrdonnee, MSG_ORDRE);

/** Allumer/éteindre une promotion sans toucher au reste — le geste courant. */
export const BasculerPromotionSchema = z.object({ actif: z.boolean() });

/** Une liaison vise UNE catégorie entière OU UN article, jamais les deux. */
export const LierOptionSchema = z
  .object({
    categorie_id: z.string().uuid('Catégorie invalide').nullish(),
    article_id: z.string().uuid('Article invalide').nullish(),
  })
  .refine((v) => !!v.categorie_id !== !!v.article_id, {
    message: 'Choisissez une catégorie OU un article',
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

/**
 * Clôture d'un Kdo (repas offert). Pas de PIN manager — décision client : le
 * caissier peut offrir seul — mais le motif reste OBLIGATOIRE, c'est la seule
 * trace qui permettra de repérer un abus dans le journal d'audit.
 */
export const OffrirSchema = z.object({
  motif: MotifObligatoire,
});

export const PaiementSchema = z.object({
  mode: z.enum(MODES_PAIEMENT, { errorMap: () => ({ message: 'Mode de paiement invalide' }) }),
  montant: z.number().int().min(1, 'Le montant doit être positif'),
  note_id: z.string().uuid().nullish(),
  /**
   * Espèces réellement posées sur le comptoir par le client — le billet.
   * Facultatif, et ignoré hors ESPECES : un paiement Wave ne rend pas de
   * monnaie. La monnaie rendue n'est PAS transmise : le serveur la calcule,
   * comme tout montant (aucun calcul monétaire côté client).
   */
  montant_recu: z.number().int().min(1, 'Le montant reçu doit être positif').nullish(),
});

/** Sélection tactile des quantités qu'un convive souhaite régler. */
export const CreerSousNoteSchema = z.object({
  items: z
    .array(
      z.object({
        commande_item_id: z.string().uuid('Article invalide'),
        quantite: z.number().int().min(1, 'La quantité doit être au moins 1').max(99),
      }),
    )
    .min(1, 'Sélectionnez au moins un article'),
  client_fidelite_id: z.string().uuid('Client fidélité invalide').nullish(),
  telephone_fidelite: z.string().trim().min(6, 'Téléphone invalide').max(20, 'Téléphone invalide').optional(),
  fidelite_points: z.number().int().min(0).default(0),
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

// ---------------------------------------------------------------------------
// SPRINT 4 — Fidélité (§9)
// ---------------------------------------------------------------------------

/** Numéro de téléphone du client fidélité (saisi au paiement). */
export const TelephoneFideliteSchema = z
  .string()
  .trim()
  .regex(/^[+0-9][0-9 ]{5,19}$/, 'Numéro de téléphone invalide');

/** Proposition de commande depuis le téléphone client (jamais envoyée en cuisine directement). */
export const CommandeClientSchema = z.object({
  items: z.array(AjouterItemSchema).min(1, 'Ajoutez au moins un article'),
  /**
   * Téléphone FACULTATIF : on le demande toujours, on ne bloque jamais la
   * commande. Un champ laissé vide vaut « pas de numéro » — le client perd ses
   * points et l'écran le lui dit, mais sa commande part quand même.
   */
  telephone: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    TelephoneFideliteSchema.optional(),
  ),
});

/** Refus d'une commande client (message obligatoire montré au client). */
export const RefusCommandeSchema = z.object({
  motif: z.string().trim().min(3, 'Indiquez la raison du refus (montrée au client)'),
});

/** Transfert d'une table à un autre serveur (caisse/manager uniquement). */
export const TransfertTableSchema = z.object({
  serveur_id: z.string().uuid('Serveur invalide'),
});

/**
 * Libérer une table depuis le plan de salle : elle vide la table de TOUT ce qui
 * l'occupe encore. Motif et PIN manager sont facultatifs ICI, et EXIGÉS par le
 * serveur dès qu'une commande porte au moins un article — c'est alors une
 * annulation de commande, avec sa trace d'audit et son retour. Une table où
 * rien n'a été tapé se libère sans rien demander : aucun franc n'a bougé.
 */
export const LibererTableSchema = z.object({
  motif: z.string().trim().nullish(),
  pin_manager: PinSaisiSchema.nullish(),
});

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

/**
 * Taux journalier en FCFA. Champ vide = effacer le taux (retour à « pas de taux
 * journalier »), pas « taux à zéro » : un salaire nul et un salaire inconnu ne
 * se disent pas pareil, et c'est ce taux qui pré-remplit la paie et déclenche
 * l'exigence de motif quand le montant payé en diffère.
 */
const TauxJournalierSchema = z
  .union([
    z.literal('').transform(() => null),
    z.null(),
    z.coerce
      .number()
      .int('Le taux journalier doit être un nombre entier de FCFA')
      .min(0, 'Le taux journalier ne peut pas être négatif')
      .max(1_000_000, 'Taux journalier irréaliste (max 1 000 000 FCFA)'),
  ])
  .optional();

// Pas de schéma de CRÉATION d'employé : depuis le 2026-09-04, on n'embauche pas
// depuis la caisse. Un employé arrive par la descente SamerTrackly, qui construit
// sa fiche elle-même (`sync-samtrackly.ts`).

/** Modification d'un employé (rôle, poste, téléphone, intitulé, photo, taux). */
export const ModifierEmployeSchema = z.object({
  nom_complet: NomCompletSchema.optional(),
  role_id: z.string().uuid('Rôle invalide').optional(),
  poste_cuisine: PosteCuisineSchema,
  telephone: TelephoneSchema,
  // Intitulé de poste RH (libre) et photo (URL) — chaîne vide = effacer.
  poste: z.string().trim().max(60, 'Intitulé trop long').nullish(),
  photo_url: z.string().trim().max(500, 'URL trop longue').nullish(),
  taux_journalier: TauxJournalierSchema,
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
export const DerogationDisponibiliteSchema = z.object({
  active: z.boolean(),
  motif: z.string().trim().min(3).max(200),
});

/** Modification d'un paramètre local (2.6). */
export const ModifierParametreSchema = z.object({
  cle: z.string().trim().min(1),
  valeur: z.union([z.number(), z.string(), z.boolean(), z.record(z.unknown())]),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type CreerCommandeInput = z.infer<typeof CreerCommandeSchema>;
export type AjouterItemInput = z.infer<typeof AjouterItemSchema>;
export type PaiementInput = z.infer<typeof PaiementSchema>;
export type CreerSousNoteInput = z.infer<typeof CreerSousNoteSchema>;
export type CreerRoleInput = z.infer<typeof CreerRoleSchema>;
export type ModifierRoleInput = z.infer<typeof ModifierRoleSchema>;
