import { z } from 'zod';
import { MODES_PAIEMENT, PINS_INTERDITS, TYPES_COMMANDE } from './constantes.js';

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

export const OuvrirServiceSchema = z.object({
  fond_de_caisse: z
    .number({ invalid_type_error: 'Le fond de caisse doit être un montant en FCFA' })
    .int('Le fond de caisse doit être un montant entier en FCFA')
    .min(0, 'Le fond de caisse ne peut pas être négatif'),
});

/**
 * Transfert des commandes en cours au caissier suivant (relève de caisse) :
 * le receveur ACCEPTE le transfert en saisissant son propre PIN.
 */
export const TransfererServiceSchema = z.object({
  receveur_id: z.string().uuid('Caissier receveur invalide'),
  pin_receveur: PinSaisiSchema,
});

export const CloturerServiceSchema = z.object({
  especes_comptees: z
    .number({ invalid_type_error: 'Le montant compté doit être un nombre' })
    .int('Le montant compté doit être un montant entier en FCFA')
    .min(0, 'Le montant compté ne peut pas être négatif'),
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

export type LoginInput = z.infer<typeof LoginSchema>;
export type CreerCommandeInput = z.infer<typeof CreerCommandeSchema>;
export type AjouterItemInput = z.infer<typeof AjouterItemSchema>;
export type PaiementInput = z.infer<typeof PaiementSchema>;
