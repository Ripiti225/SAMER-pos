/**
 * Correction du stock initial pendant la première heure du shift. Le chiffre
 * change tout de suite : le statut ne dit que qui paiera le manquant éventuel.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, ne } from 'drizzle-orm';
import { effetCorrectionSortant, type StatutCorrectionStock } from '@pos/shared';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { ecrireOutbox } from '../../db/outbox.js';
import {
  correctionsStockInitial,
  inventaireLignes,
  inventairesService,
  produitsInventaire,
} from '../../db/schema/index.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager, verifierPinUtilisateur } from '../auth/pin.js';
import { serviceOuvertCourant, type ServiceOuvert } from '../depenses/service.js';
import { arrondi, expliqueeInvalide, sortiesPourVentes } from './calcul.js';
import { finFenetre, sourceDuStock, stockReporte } from './correction.js';
import { etatInventaire, ventesEnCoursParProduit } from './service.js';

const CorrigerSchema = z
  .object({
    stock_initial: z
      .number({ invalid_type_error: 'Le stock doit être un nombre' })
      .min(0, 'Le stock ne peut pas être négatif')
      .max(1_000_000, 'Stock invalide'),
    explication: z.string().trim().min(1, 'Expliquez cette correction').max(500),
    pin_sortant: z.string().min(4).optional(),
    pin_manager: z.string().min(4).optional(),
  })
  .refine((c) => !(c.pin_sortant && c.pin_manager), { message: 'Saisissez un seul code à la fois' });

const ValiderSchema = z
  .object({
    pin_sortant: z.string().min(4).optional(),
    pin_manager: z.string().min(4).optional(),
  })
  .refine((c) => Boolean(c.pin_sortant) !== Boolean(c.pin_manager), {
    message: 'Saisissez le code du sortant ou celui du manager',
  });

/** Un PIN faux refuse l'action sans fermer la session du caissier en poste. */
async function verifierPinSortant(caissierId: string, pin: string): Promise<void> {
  try {
    await verifierPinUtilisateur(caissierId, pin);
  } catch (erreur) {
    if (erreur instanceof ErreurMetier && erreur.statusCode === 401) {
      throw new ErreurMetier('Ce n’est pas le code du caissier sortant', 403);
    }
    throw erreur;
  }
}

/** Celui qui bénéficie de la correction ne peut pas la valider lui-même. */
async function verifierManagerNonImplique(
  pin: string,
  contexte: string,
  auteurId: string,
  service: ServiceOuvert,
): Promise<string> {
  const manager = await verifierPinManager(pin, contexte);
  if (manager.id === auteurId || manager.id === service.caissier_id) {
    throw new ErreurMetier('Un autre manager doit valider : vous êtes concerné par cette correction', 403);
  }
  return manager.id;
}

export function routesCorrectionStock(app: FastifyInstance): void {
  const garde = app.exigePermission('inventaire.saisir');

  /** Ce que le caissier doit voir avant de corriger. */
  app.get('/api/inventaire/lignes/:produitId/correction', { preHandler: garde }, async (req) => {
    const { produitId } = req.params as { produitId: string };
    const service = await serviceOuvertCourant(db);
    return db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      const ligne = etat.lignes.find((l) => l.produit_id === produitId && l.a_compter);
      if (!ligne) throw introuvable('Produit à compter');

      const source = await sourceDuStock(tx, service.id, produitId);
      const produits = await tx.select().from(produitsInventaire).where(eq(produitsInventaire.actif, true));
      const enCours = sortiesPourVentes(produits, await ventesEnCoursParProduit(tx, service.id));
      return {
        stock_actuel: ligne.stock_initial,
        stock_reporte: await stockReporte(tx, etat.inventaire.id, produitId, ligne.stock_initial),
        sorties_payees: ligne.sorties,
        sorties_en_cours: arrondi(enCours.get(produitId) ?? 0),
        fin: finFenetre(service.ouvert_le).toISOString(),
        sortant_nom: source.caissier_sortant_nom,
        meme_caissier: source.caissier_sortant_id === service.caissier_id,
        intermediaire: source.intermediaire,
        ligne_sortant: source.ligne,
      };
    });
  });

  app.post('/api/inventaire/lignes/:produitId/corriger-initial', { preHandler: garde }, async (req) => {
    const { produitId } = req.params as { produitId: string };
    const corps = valider(CorrigerSchema, req.body);
    const service = await serviceOuvertCourant(db);
    if (Date.now() > finFenetre(service.ouvert_le).getTime()) {
      throw new ErreurMetier('Le délai d’une heure pour corriger le stock initial est dépassé', 409);
    }
    const auteurId = req.session!.utilisateur_id;

    // Les PIN se vérifient hors transaction : un échec doit laisser sa trace
    // au journal et son compteur anti-force brute, même si l'action est refusée.
    const avant = await sourceDuStock(db, service.id, produitId);
    if ((corps.pin_sortant || corps.pin_manager) && (!avant.ligne || avant.intermediaire)) {
      throw new ErreurMetier('Cette correction ne peut pas être validée sur place', 409);
    }
    let reconnu = false;
    let managerId: string | null = null;
    if (corps.pin_sortant) {
      await verifierPinSortant(avant.caissier_sortant_id!, corps.pin_sortant);
      reconnu = true;
    }
    if (corps.pin_manager) {
      managerId = await verifierManagerNonImplique(corps.pin_manager, 'CORRECTION_STOCK_INITIAL', auteurId, service);
    }

    const resultat = await db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      if (etat.inventaire.valide) {
        throw new ErreurMetier('Cet inventaire est validé : il n’est plus modifiable', 409);
      }

      const [ligne] = await tx
        .select()
        .from(inventaireLignes)
        .where(and(eq(inventaireLignes.inventaire_id, etat.inventaire.id), eq(inventaireLignes.produit_id, produitId)))
        .for('update');
      if (!ligne) throw introuvable('Produit à compter');
      const stockAvant = Number(ligne.stock_initial);
      if (corps.stock_initial === stockAvant) {
        throw new ErreurMetier('Ce stock est déjà celui enregistré', 400);
      }

      const [produit] = await tx.select().from(produitsInventaire).where(eq(produitsInventaire.id, produitId));
      if (!produit) throw introuvable('Produit');

      const reporte = await stockReporte(tx, etat.inventaire.id, produitId, stockAvant);
      const source = await sourceDuStock(tx, service.id, produitId);
      const effet = source.ligne ? effetCorrectionSortant(source.ligne, corps.stock_initial) : null;
      const memeCaissier = source.caissier_sortant_id === service.caissier_id && !source.intermediaire;

      let statut: StatutCorrectionStock = 'A_VALIDER';
      let validePar: string | null = null;
      if (!effet?.litige) {
        statut = 'SANS_LITIGE';
      } else if (memeCaissier || reconnu) {
        statut = 'RECONNUE_SORTANT';
        validePar = source.caissier_sortant_id;
      } else if (managerId) {
        statut = 'VALIDEE_MANAGER';
        validePar = managerId;
      }

      const remplacees = await tx
        .update(correctionsStockInitial)
        .set({ statut: 'REMPLACEE' })
        .where(
          and(
            eq(correctionsStockInitial.inventaire_id, etat.inventaire.id),
            eq(correctionsStockInitial.produit_id, produitId),
            ne(correctionsStockInitial.statut, 'REMPLACEE'),
          ),
        )
        .returning();
      for (const r of remplacees) {
        await ecrireOutbox(tx, 'corrections_stock_initial', 'UPDATE', r.id, r as unknown as Record<string, unknown>);
      }

      const [correction] = await tx
        .insert(correctionsStockInitial)
        .values({
          inventaire_id: etat.inventaire.id,
          produit_id: produitId,
          produit_code: produit.code,
          produit_nom: produit.nom,
          produit_prix: produit.prix,
          stock_reporte: String(reporte),
          stock_avant: String(stockAvant),
          stock_apres: String(corps.stock_initial),
          explication: corps.explication,
          saisi_par: auteurId,
          service_sortant_id: source.service_sortant_id,
          caissier_sortant_id: source.caissier_sortant_id,
          shift_intermediaire_debloque: source.intermediaire,
          ecart_sortant_avant: effet ? String(effet.ecart_avant) : null,
          ecart_sortant_apres: effet ? String(effet.ecart_apres) : null,
          statut,
          valide_par: validePar,
          valide_le: validePar ? new Date() : null,
        })
        .returning();
      await ecrireOutbox(
        tx,
        'corrections_stock_initial',
        'INSERT',
        correction!.id,
        correction as unknown as Record<string, unknown>,
      );

      const [majLigne] = await tx
        .update(inventaireLignes)
        .set({ stock_initial: String(corps.stock_initial) })
        .where(eq(inventaireLignes.id, ligne.id))
        .returning();
      await ecrireOutbox(tx, 'inventaire_lignes', 'UPDATE', ligne.id, majLigne as unknown as Record<string, unknown>);

      await journaliser(tx, {
        user_id: auteurId,
        action: 'CORRECTION_STOCK_INITIAL',
        entite: 'corrections_stock_initial',
        entite_id: correction!.id,
        motif: corps.explication,
        meta: {
          produit: produit.nom,
          stock_reporte: reporte,
          avant: stockAvant,
          apres: corps.stock_initial,
          statut,
          sortant_id: source.caissier_sortant_id,
          valide_par: validePar,
        },
      });

      // Même garde-fou que la saisie du compté : le stock initial déplace
      // l'écart, l'explication déjà écrite ne doit pas le dépasser.
      const apres = await etatInventaire(tx, service.id);
      const ligneApres = apres.lignes.find((l) => l.produit_id === produitId);
      if (ligneApres && expliqueeInvalide(ligneApres.ecart, ligneApres.quantite_expliquee)) {
        throw new ErreurMetier(
          'Votre comptage explique plus d’unités que le nouvel écart. Corrigez d’abord l’explication.',
          400,
        );
      }
      return { correction: correction!, ligne: ligneApres ?? null, bilan: apres.bilan };
    });

    app.diffuser('inventaire', service.id);
    return resultat;
  });

  /** Le 1 h limite la correction, pas la validation : possible jusqu'à la clôture. */
  app.post('/api/inventaire/corrections/:id/valider', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ValiderSchema, req.body);
    const service = await serviceOuvertCourant(db);

    const [lue] = await db
      .select({ correction: correctionsStockInitial })
      .from(correctionsStockInitial)
      .innerJoin(inventairesService, eq(inventairesService.id, correctionsStockInitial.inventaire_id))
      .where(and(eq(correctionsStockInitial.id, id), eq(inventairesService.service_id, service.id)));
    if (!lue) throw new ErreurMetier('Cette correction n’appartient pas au shift en cours', 409);
    const c = lue.correction;
    if (c.statut !== 'A_VALIDER') throw new ErreurMetier('Cette correction a déjà été traitée', 409);
    if (c.shift_intermediaire_debloque || !c.caissier_sortant_id) {
      throw new ErreurMetier(
        'Cette correction ne peut pas être validée sur place : elle sera décidée dans SamerTrackly',
        409,
      );
    }

    let validePar = c.caissier_sortant_id;
    let statut: StatutCorrectionStock = 'RECONNUE_SORTANT';
    if (corps.pin_sortant) {
      await verifierPinSortant(c.caissier_sortant_id, corps.pin_sortant);
    } else {
      validePar = await verifierManagerNonImplique(
        corps.pin_manager!,
        'VALIDATION_CORRECTION_STOCK',
        c.saisi_par,
        service,
      );
      statut = 'VALIDEE_MANAGER';
    }

    const correction = await db.transaction(async (tx) => {
      const [maj] = await tx
        .update(correctionsStockInitial)
        .set({ statut, valide_par: validePar, valide_le: new Date() })
        .where(and(eq(correctionsStockInitial.id, id), eq(correctionsStockInitial.statut, 'A_VALIDER')))
        .returning();
      if (!maj) throw new ErreurMetier('Cette correction a déjà été traitée', 409);
      await ecrireOutbox(tx, 'corrections_stock_initial', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: validePar,
        action: 'VALIDATION_CORRECTION_STOCK',
        entite: 'corrections_stock_initial',
        entite_id: id,
        meta: { statut, produit: maj.produit_nom, demande_par: req.session!.utilisateur_id },
      });
      return maj;
    });

    app.diffuser('inventaire', service.id);
    return { correction };
  });
}
