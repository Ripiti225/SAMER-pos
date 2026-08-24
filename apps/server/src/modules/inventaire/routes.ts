/**
 * Écran Inventaire (DESIGN_V2 § 6.9) — sans inventaire validé, pas de clôture.
 *
 * Le caissier ne saisit qu'UNE chose : le compté. Stock initial (repris),
 * entrées (onglet Entrées reçues) et sorties (ventes du service) viennent du
 * serveur ; le théorique et l'écart en découlent. Après validation, tout passe
 * en lecture seule.
 *
 * Le montant manquant est une INFORMATION pour le manager, jamais une retenue —
 * contrairement à SamerTrackly qui déduit.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  entreesStock,
  inventaireLignes,
  inventairesService,
  produitsInventaire,
  servicesCaisse,
  utilisateurs,
} from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager } from '../auth/pin.js';
import { serviceOuvertCourant } from '../depenses/service.js';
import { etatInventaire } from './service.js';
import { expliqueeInvalide } from './calcul.js';

/** Quantité d'inventaire : jamais un entier — fromage en grammes, glace en pots. */
const Quantite = z
  .number({ invalid_type_error: 'La quantité doit être un nombre' })
  .min(0, 'La quantité ne peut pas être négative')
  .max(1_000_000, 'Quantité invalide');

const CompterSchema = z.object({
  stock_compte: Quantite.nullable(),
  quantite_expliquee: Quantite.optional(),
  explication: z.string().trim().max(500).optional(),
});

const EntreeSchema = z.object({
  produit_id: z.string().uuid('Produit invalide'),
  quantite: Quantite.positive('La quantité reçue doit être supérieure à zéro'),
  fournisseur: z.string().trim().max(120).optional(),
});

const DebloquerSchema = z.object({
  pin_manager: z.string().min(4, 'PIN manager obligatoire'),
  motif: z.string().trim().min(1, 'Le déblocage exige un motif'),
});

export function routesInventaire(app: FastifyInstance): void {
  // Avant le 2026-08-17 : caisse.service.ouvrir pour tout, y compris le
  // deblocage d'une cloture sans inventaire conforme.
  const garde = app.exigePermission('inventaire.saisir');
  const gardeValider = app.exigePermission('inventaire.valider');
  // Laisser passer une cloture sans comptage conforme : acte d'encadrement.
  const gardeDebloquer = app.exigePermission('inventaire.debloquer');

  /** L'inventaire du service en cours, calculé. Créé à la volée au 1er accès. */
  app.get('/api/inventaire', { preHandler: garde }, async () => {
    const service = await serviceOuvertCourant(db);
    const etat = await db.transaction(async (tx) => etatInventaire(tx, service.id));

    const entrees = await db
      .select({
        id: entreesStock.id,
        produit_id: entreesStock.produit_id,
        produit_nom: produitsInventaire.nom,
        quantite: entreesStock.quantite,
        fournisseur: entreesStock.fournisseur,
        created_at: entreesStock.created_at,
      })
      .from(entreesStock)
      .innerJoin(produitsInventaire, eq(produitsInventaire.id, entreesStock.produit_id))
      .where(eq(entreesStock.inventaire_id, etat.inventaire.id))
      .orderBy(asc(entreesStock.created_at));

    // Colonne de gauche : combien reste-t-il à compter dans chaque catégorie.
    const categories = new Map<string, { categorie: string; total: number; restants: number }>();
    for (const l of etat.lignes) {
      if (!l.a_compter) continue;
      const c = categories.get(l.categorie) ?? { categorie: l.categorie, total: 0, restants: 0 };
      c.total += 1;
      if (l.stock_compte === null) c.restants += 1;
      categories.set(l.categorie, c);
    }

    return {
      service_id: service.id,
      inventaire_id: etat.inventaire.id,
      valide: etat.inventaire.valide,
      valide_le: etat.inventaire.valide_le?.toISOString() ?? null,
      debloque: etat.inventaire.debloque_par !== null,
      debloque_motif: etat.inventaire.debloque_motif,
      cloture_autorisee: etat.cloture_autorisee,
      categories: [...categories.values()],
      lignes: etat.lignes,
      bilan: etat.bilan,
      entrees: entrees.map((e) => ({
        ...e,
        quantite: Number(e.quantite),
        created_at: e.created_at.toISOString(),
      })),
    };
  });

  /** Saisie du compté (et justification d'un manquant). */
  app.put('/api/inventaire/lignes/:produitId', { preHandler: garde }, async (req) => {
    const { produitId } = req.params as { produitId: string };
    const corps = valider(CompterSchema, req.body);
    const service = await serviceOuvertCourant(db);

    return db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      if (etat.inventaire.valide) {
        throw new ErreurMetier('Cet inventaire est validé : il n’est plus modifiable', 409);
      }
      const [ligne] = await tx
        .select()
        .from(inventaireLignes)
        .where(
          and(
            eq(inventaireLignes.inventaire_id, etat.inventaire.id),
            eq(inventaireLignes.produit_id, produitId),
          ),
        );
      if (!ligne) throw introuvable('Produit à compter');

      const [majLigne] = await tx
        .update(inventaireLignes)
        .set({
          stock_compte: corps.stock_compte === null ? null : String(corps.stock_compte),
          quantite_expliquee:
            corps.quantite_expliquee === undefined ? ligne.quantite_expliquee : String(corps.quantite_expliquee),
          explication: corps.explication === undefined ? ligne.explication : (corps.explication || null),
        })
        .where(eq(inventaireLignes.id, ligne.id))
        .returning();
      await ecrireOutbox(tx, 'inventaire_lignes', 'UPDATE', ligne.id, majLigne as unknown as Record<string, unknown>);

      // Recalcul complet : un total dérivé bouge quand une consommation bouge.
      const apres = await etatInventaire(tx, service.id);

      // Garde-fou (2026-08-23) : on ne justifie pas plus d'unités qu'il n'en
      // manque. Vérifié APRÈS le recalcul — c'est le seul endroit où l'écart
      // définitif est connu, `stock_compte` venant d'être modifié dans le même
      // appel. Le `throw` annule la transaction, donc rien n'est écrit.
      const ligneApres = apres.lignes.find((l) => l.produit_id === produitId);
      if (ligneApres && expliqueeInvalide(ligneApres.ecart, ligneApres.quantite_expliquee)) {
        const manque = Math.abs(ligneApres.ecart ?? 0);
        throw new ErreurMetier(
          `Vous justifiez ${ligneApres.quantite_expliquee} unités alors qu'il n'en manque que ${manque}. `
          + `Ce champ attend un NOMBRE D'UNITÉS, pas un montant en francs.`,
          400,
        );
      }

      app.diffuser('inventaire', service.id);
      return {
        ligne: apres.lignes.find((l) => l.produit_id === produitId) ?? null,
        bilan: apres.bilan,
      };
    });
  });

  /** Onglet « Entrées reçues » : réception de marchandise pendant le service. */
  app.post('/api/inventaire/entrees', { preHandler: garde }, async (req) => {
    const corps = valider(EntreeSchema, req.body);
    const service = await serviceOuvertCourant(db);

    return db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      if (etat.inventaire.valide) {
        throw new ErreurMetier('Cet inventaire est validé : il n’est plus modifiable', 409);
      }
      const [produit] = await tx
        .select()
        .from(produitsInventaire)
        .where(eq(produitsInventaire.id, corps.produit_id));
      if (!produit) throw introuvable('Produit');

      const [entree] = await tx
        .insert(entreesStock)
        .values({
          inventaire_id: etat.inventaire.id,
          produit_id: corps.produit_id,
          quantite: String(corps.quantite),
          fournisseur: corps.fournisseur || null,
          saisi_par: req.session!.utilisateur_id,
        })
        .returning();
      await ecrireOutbox(tx, 'entrees_stock', 'INSERT', entree!.id, entree as unknown as Record<string, unknown>);

      app.diffuser('inventaire', service.id);
      return { ...entree!, quantite: Number(entree!.quantite) };
    });
  });

  app.delete('/api/inventaire/entrees/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const service = await serviceOuvertCourant(db);

    return db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      if (etat.inventaire.valide) {
        throw new ErreurMetier('Cet inventaire est validé : il n’est plus modifiable', 409);
      }
      const [entree] = await tx
        .select()
        .from(entreesStock)
        .where(and(eq(entreesStock.id, id), eq(entreesStock.inventaire_id, etat.inventaire.id)));
      if (!entree) throw introuvable('Entrée de stock');
      await tx.delete(entreesStock).where(eq(entreesStock.id, id));
      // Même règle que pour une dépense supprimée : l'outbox n'a pas de DELETE,
      // donc on republie la ligne marquée supprimée. Sans ça, une réception
      // saisie par erreur gonflerait le stock du site au siège, pour toujours.
      await ecrireOutbox(tx, 'entrees_stock', 'UPDATE', id, {
        ...(entree as unknown as Record<string, unknown>),
        supprime: true,
      });
      app.diffuser('inventaire', service.id);
      return { ok: true };
    });
  });

  /**
   * Validation : possible seulement quand TOUS les produits sont comptés. Fige
   * les chiffres dérivés dans les lignes — le ticket Z et les rapports doivent
   * raconter exactement ce que le caissier avait sous les yeux.
   */
  app.post('/api/inventaire/valider', { preHandler: gardeValider }, async (req) => {
    const service = await serviceOuvertCourant(db);

    const resultat = await db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      if (etat.inventaire.valide) throw new ErreurMetier('Cet inventaire est déjà validé', 409);
      if (etat.bilan.a_compter > 0) {
        throw new ErreurMetier(
          `Il reste ${etat.bilan.a_compter} produit(s) à compter avant de valider`,
          409,
        );
      }

      // Les chiffres dérivés sont FIGÉS dans les lignes, puis publiés : le
      // siège doit lire exactement ce que le caissier avait sous les yeux.
      for (const l of etat.lignes) {
        if (!l.a_compter) continue;
        const [figee] = await tx
          .update(inventaireLignes)
          .set({
            entrees: String(l.entrees),
            sorties: String(l.sorties),
            ecart: l.ecart === null ? null : String(l.ecart),
          })
          .where(
            and(
              eq(inventaireLignes.inventaire_id, etat.inventaire.id),
              eq(inventaireLignes.produit_id, l.produit_id),
            ),
          )
          .returning();
        if (figee) {
          await ecrireOutbox(tx, 'inventaire_lignes', 'UPDATE', figee.id, figee as unknown as Record<string, unknown>);
        }
      }

      const [maj] = await tx
        .update(inventairesService)
        .set({
          valide: true,
          valide_le: new Date(),
          valide_par: req.session!.utilisateur_id,
          montant_manquant: etat.bilan.montant,
        })
        .where(eq(inventairesService.id, etat.inventaire.id))
        .returning();
      await ecrireOutbox(tx, 'inventaires_service', 'UPDATE', maj!.id, maj as unknown as Record<string, unknown>);

      // Le verrou de clôture est porté par le service : c'est lui que la route
      // de clôture relit, sans avoir à recalculer l'inventaire.
      await tx
        .update(servicesCaisse)
        .set({ inventaire_valide: true })
        .where(eq(servicesCaisse.id, service.id));

      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'VALIDATION_INVENTAIRE',
        entite: 'inventaires_service',
        entite_id: etat.inventaire.id,
        montant: etat.bilan.montant,
        meta: {
          service_id: service.id,
          justes: etat.bilan.justes,
          manquants: etat.bilan.manquants,
          surplus: etat.bilan.surplus,
        },
      });
      return { inventaire: maj!, bilan: etat.bilan };
    });

    app.diffuser('inventaire', service.id);
    app.diffuser('service', service.id);
    return {
      valide: true,
      montant_manquant: resultat.bilan.montant,
      bilan: resultat.bilan,
    };
  });

  /**
   * Issue de secours (§ 6.10) : PIN manager + motif. Sans elle, un caissier
   * bloqué à 2 h du matin ne peut plus fermer sa caisse. Toujours tracée.
   */
  app.post('/api/inventaire/debloquer', { preHandler: gardeDebloquer }, async (req) => {
    const corps = valider(DebloquerSchema, req.body);
    const service = await serviceOuvertCourant(db);
    const manager = await verifierPinManager(corps.pin_manager, 'DEBLOCAGE_INVENTAIRE');

    await db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      if (etat.inventaire.valide) {
        throw new ErreurMetier('Cet inventaire est validé : aucun déblocage nécessaire', 409);
      }
      const [debloque] = await tx
        .update(inventairesService)
        .set({ debloque_par: manager.id, debloque_le: new Date(), debloque_motif: corps.motif })
        .where(eq(inventairesService.id, etat.inventaire.id))
        .returning();
      // Un déblocage part au siège comme le reste : c'est une clôture sans
      // comptage complet, exactement ce qu'un manager doit pouvoir justifier.
      await ecrireOutbox(tx, 'inventaires_service', 'UPDATE', debloque!.id, debloque as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: manager.id,
        action: 'DEBLOCAGE_INVENTAIRE',
        entite: 'inventaires_service',
        entite_id: etat.inventaire.id,
        motif: corps.motif,
        meta: {
          service_id: service.id,
          demande_par: req.session!.utilisateur_id,
          restants_a_compter: etat.bilan.a_compter,
        },
      });
    });

    app.diffuser('inventaire', service.id);
    return { debloque: true, par: manager.nom_complet };
  });

  /**
   * État léger pour la pastille de l'accueil. Contrairement à `GET
   * /api/inventaire`, cette route ne CRÉE rien : un badge qui s'affiche ne doit
   * pas ouvrir d'inventaire ni écrire en base.
   */
  app.get('/api/inventaire/etat', { preHandler: garde }, async () => {
    const service = await serviceOuvertCourant(db);
    const [inv] = await db
      .select()
      .from(inventairesService)
      .where(eq(inventairesService.service_id, service.id));
    if (!inv) return { commence: false, valide: false, debloque: false, restants_a_compter: null };

    const [restants] = await db
      .select({ n: sql<string>`COUNT(*)` })
      .from(inventaireLignes)
      .where(and(eq(inventaireLignes.inventaire_id, inv.id), isNull(inventaireLignes.stock_compte)));
    return {
      commence: true,
      valide: inv.valide,
      debloque: inv.debloque_par !== null,
      restants_a_compter: Number(restants?.n ?? 0),
    };
  });

  /** Catalogue de comptage (lecture) — sert aussi au sélecteur d'entrées. */
  app.get('/api/inventaire/produits', { preHandler: garde }, async () => {
    const produits = await db
      .select()
      .from(produitsInventaire)
      .where(eq(produitsInventaire.actif, true))
      .orderBy(asc(produitsInventaire.categorie), asc(produitsInventaire.ordre));
    return produits.map((p) => ({ ...p, ratio: p.ratio === null ? null : Number(p.ratio) }));
  });

  /** Qui a validé / débloqué (affiché en lecture seule après validation). */
  app.get('/api/inventaire/signataires', { preHandler: garde }, async () => {
    const service = await serviceOuvertCourant(db);
    const [inv] = await db
      .select({
        valide_par: inventairesService.valide_par,
        debloque_par: inventairesService.debloque_par,
      })
      .from(inventairesService)
      .where(eq(inventairesService.service_id, service.id));
    if (!inv) return { valide_par: null, debloque_par: null };

    const nom = async (id: string | null) => {
      if (!id) return null;
      const [u] = await db
        .select({ nom: utilisateurs.nom_complet })
        .from(utilisateurs)
        .where(eq(utilisateurs.id, id));
      return u?.nom ?? null;
    };
    return { valide_par: await nom(inv.valide_par), debloque_par: await nom(inv.debloque_par) };
  });
}
