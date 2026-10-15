/**
 * SPRINT 4C — Paramètres (2.6) et Outils d'encadrement (2.7).
 * - Paramètres : liste blanche PARAMETRES_EDITABLES, effet immédiat + audit
 *   MODIF_PARAMETRE (avant/après). Guard `reglages.parametres`.
 * - Journal d'audit : lecture seule avec filtres. Guard `reglages.audit`.
 */
import type { FastifyInstance } from 'fastify';
import { cleSonnerie, modeSonnerieEnregistre, MODES_SONNERIE } from '@pos/shared';
import { commandeSonnerie } from '../../printer/sonnerie.js';
import { envoyerRaw } from '../../printer/escpos.js';
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { clePosteImprimante, CLES_PARAMETRES_EDITABLES, ConfigRestaurantSchema, ModifierParametreSchema, PARAMETRES_EDITABLES, POSTE_IMPRESSION_DEFAUT, POSTES_IMPRESSION, type PosteImpression } from '@pos/shared';
import { db } from '../../db/client.js';
import { articles, auditLog, categories, commandes, inventaireConsommations, inventaireLignes, inventairesService, parametresLocaux, produitsInventaire, restaurant, routageArticle, routageCategorie, servicesCaisse, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { appliquerRecettesDefaut } from '../inventaire/recettes-defaut.js';
import { publierInventaireHistorique } from '../inventaire/publication-cloud.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { restaurantsSamtrackly } from '../equipe/sync-samtrackly.js';
import { moteurSync } from '../sync/moteur.js';
import { CLE_COLONNES, CLE_LOGO, colonnesValides, COLONNES_POSSIBLES, imprimerTest, listerImprimantes, queuePoste } from '../../printer/escpos.js';
import { estModeLogo, type Marque } from '../../printer/logo.js';
import { importerProfilRestaurant, lireProfilRestaurant } from '../../profils/importer.js';
import { marqueRestaurant } from '../../profils/marque.js';

/**
 * Recette d'un produit d'inventaire : la quantité n'est PAS un entier (0,5
 * poulet par demi-poulet, comme les quantités d'inventaire en général).
 */
const RecettesSchema = z.object({
  recettes: z
    .array(
      z.object({
        article_id: z.string().uuid('Article invalide'),
        quantite: z
          .number({ invalid_type_error: 'La quantité doit être un nombre' })
          .positive('La quantité doit être supérieure à zéro')
          .max(1000, 'Quantité invalide'),
      }),
    )
    .max(500, 'Recette trop longue'),
});

const NouveauProduitInventaireSchema = z.object({
  nom: z.string().trim().min(1, 'Nom du produit obligatoire').max(120),
  categorie: z.enum(['PAIN', 'POUL', 'APER', 'PLAT', 'FROM', 'BOIS', 'GLAC', 'FRIT']),
  unite: z.string().trim().min(1, 'Unité obligatoire').max(16),
  prix: z.number().int('Le prix doit être entier').min(0, 'Le prix ne peut pas être négatif').max(100_000_000),
});

const estHex = (c: string | null): c is string => !!c && /^#[0-9a-fA-F]{6}$/.test(c);
const slug = (nom: string): string =>
  nom
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'RESTAURANT';

export function routesReglages(app: FastifyInstance): void {
  // ---- Paramètres du restaurant (2.6) ----
  const gardeParam = app.exigePermission('reglages.parametres');

  app.get('/api/admin/parametres', { preHandler: gardeParam }, async () => {
    const lignes = await db.select().from(parametresLocaux);
    const parCle = new Map(lignes.map((l) => [l.cle, l.valeur]));
    return PARAMETRES_EDITABLES.map((p) => ({
      ...p,
      valeur: parCle.has(p.cle) ? parCle.get(p.cle) : p.defaut,
    }));
  });

  app.patch('/api/admin/parametres', { preHandler: gardeParam }, async (req) => {
    const corps = valider(ModifierParametreSchema, req.body);
    if (!CLES_PARAMETRES_EDITABLES.includes(corps.cle)) {
      throw new ErreurMetier('Ce paramètre n’est pas modifiable', 400);
    }
    const [avant] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, corps.cle));
    await db.transaction(async (tx) => {
      await tx
        .insert(parametresLocaux)
        .values({ cle: corps.cle, valeur: corps.valeur as never })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: corps.valeur as never } });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'parametres_locaux',
        meta: { cle: corps.cle, avant: avant?.valeur ?? null, apres: corps.valeur },
      });
    });
    return { cle: corps.cle, valeur: corps.valeur };
  });

  // ---- Imprimante par poste : découverte + config + test (permission Paramètres) ----
  async function infosResto(): Promise<{ nom: string; marque: Marque; colonnes: number }> {
    const [r] = await db.select().from(restaurant).limit(1);
    const [c] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, CLE_COLONNES));
    return {
      nom: r?.nom ?? 'Chez Samer',
      marque: (r?.marque as Marque) ?? 'SAMER',
      colonnes: colonnesValides(c?.valeur),
    };
  }

  // Renvoie l'imprimante configurée pour chaque poste (Caisse retombe sur la clé
  // héritée `imprimante_thermique_queue` si non renseignée).
  app.get('/api/admin/imprimantes', { preHandler: gardeParam }, async () => {
    const [disponibles, lignes] = await Promise.all([
      listerImprimantes(),
      db.select().from(parametresLocaux),
    ]);
    const lire = (cle: string): string => {
      const p = lignes.find((x) => x.cle === cle);
      return typeof p?.valeur === 'string' ? p.valeur.trim() : '';
    };
    const postes: Record<string, string> = {};
    for (const poste of POSTES_IMPRESSION) {
      const val = lire(clePosteImprimante(poste));
      postes[poste] = poste === 'CAISSE' ? (val || lire('imprimante_thermique_queue')) : val;
    }
    const logo = lire(CLE_LOGO);
    const brutCol = lignes.find((x) => x.cle === CLE_COLONNES)?.valeur;
    return {
      disponibles,
      postes,
      sonneries: Object.fromEntries(POSTES_IMPRESSION.map((poste) => [poste,
        modeSonnerieEnregistre(lignes.find((p) => p.cle === cleSonnerie(poste))?.valeur, postes[poste]!, poste),
      ])),
      logo: estModeLogo(logo) ? logo : 'aucun',
      colonnes: colonnesValides(brutCol),
      colonnes_possibles: COLONNES_POSSIBLES,
    };
  });

  /**
   * Largeur du papier en colonnes (32 / 42 / 48). Mal réglée, elle ne tronque
   * pas : le surplus passe à la ligne suivante et casse l'alignement des
   * montants. Se calibre avec la partie 1 du ticket de test.
   */
  app.post('/api/admin/imprimante/colonnes', { preHandler: gardeParam }, async (req) => {
    const brut = (req.body as { colonnes?: unknown } | null)?.colonnes;
    const n = typeof brut === 'number' ? brut : Number(brut);
    if (!(COLONNES_POSSIBLES as readonly number[]).includes(n)) {
      throw new ErreurMetier('Largeur de papier inconnue', 400);
    }
    const [avant] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, CLE_COLONNES));
    await db.transaction(async (tx) => {
      await tx
        .insert(parametresLocaux)
        .values({ cle: CLE_COLONNES, valeur: n as never })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: n as never } });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'parametres_locaux',
        meta: { cle: CLE_COLONNES, avant: avant?.valeur ?? null, apres: n },
      });
    });
    return { colonnes: n };
  });

  /**
   * Encodage du logo sur les tickets : `aucun`, `raster` (GS v 0) ou `bandes`
   * (ESC *). À choisir après avoir comparé les modes A et B du ticket de test —
   * une commande image non comprise par l'imprimante sort en charabia.
   */
  app.post('/api/admin/imprimante/logo', { preHandler: gardeParam }, async (req) => {
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    if (!estModeLogo(mode)) throw new ErreurMetier('Mode de logo inconnu', 400);
    const [avant] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, CLE_LOGO));
    await db.transaction(async (tx) => {
      await tx
        .insert(parametresLocaux)
        .values({ cle: CLE_LOGO, valeur: mode as never })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: mode as never } });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'parametres_locaux',
        meta: { cle: CLE_LOGO, avant: avant?.valeur ?? null, apres: mode },
      });
    });
    return { mode };
  });

  // Enregistre l'imprimante d'un poste (chaîne vide = désactivé → console).
  app.post('/api/admin/imprimante/poste', { preHandler: gardeParam }, async (req) => {
    const corps = (req.body ?? {}) as { poste?: unknown; queue?: unknown };
    const poste = corps.poste as PosteImpression;
    if (!POSTES_IMPRESSION.includes(poste)) throw new ErreurMetier('Poste d’impression inconnu', 400);
    const queue = typeof corps.queue === 'string' ? corps.queue.trim() : '';
    const cle = clePosteImprimante(poste);
    const [avant] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, cle));
    await db.transaction(async (tx) => {
      await tx
        .insert(parametresLocaux)
        .values({ cle, valeur: queue as never })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: queue as never } });
      // Caisse : on aligne aussi la clé héritée pour cohérence des anciens lecteurs.
      if (poste === 'CAISSE') {
        await tx
          .insert(parametresLocaux)
          .values({ cle: 'imprimante_thermique_queue', valeur: queue as never })
          .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: queue as never } });
      }
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'parametres_locaux',
        meta: { cle, avant: avant?.valeur ?? null, apres: queue },
      });
    });
    return { poste, queue };
  });

  const SonnerieSchema = z.object({
    poste: z.enum(POSTES_IMPRESSION), mode: z.enum(MODES_SONNERIE),
    queue: z.string().trim().min(1).max(500),
  });
  app.post('/api/admin/imprimante/sonnerie/test', { preHandler: gardeParam }, async (req) => {
    const { poste, mode, queue } = valider(SonnerieSchema, req.body);
    if (mode === 'aucun') throw new ErreurMetier('Choisissez un mode sonore à tester', 400);
    if (await queuePoste(poste) !== queue) throw new ErreurMetier('Enregistrez d’abord cette imprimante, puis relancez le test', 409);
    try {
      await envoyerRaw(queue, commandeSonnerie(mode));
    } catch (e) {
      throw new ErreurMetier(`Test sonore échoué : ${(e as Error).message}`, 502);
    }
    return { ok: true };
  });
  app.post('/api/admin/imprimante/sonnerie', { preHandler: gardeParam }, async (req) => {
    const { poste, mode, queue } = valider(SonnerieSchema, req.body);
    if (await queuePoste(poste) !== queue) throw new ErreurMetier('L’imprimante a changé. Actualisez les réglages avant de recommencer', 409);
    const cle = cleSonnerie(poste);
    const valeur = { queue, mode };
    await db.transaction(async (tx) => {
      const [avant] = await tx.select().from(parametresLocaux).where(eq(parametresLocaux.cle, cle));
      await tx.insert(parametresLocaux).values({ cle, valeur })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur } });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id, action: 'MODIF_PARAMETRE', entite: 'parametres_locaux',
        meta: { cle, avant: avant?.valeur ?? null, apres: valeur },
      });
    });
    return { poste, mode };
  });

  app.post('/api/admin/imprimante/test', { preHandler: gardeParam }, async (req) => {
    const corps = (req.body ?? {}) as { queue?: unknown; poste?: unknown };
    let queue = typeof corps.queue === 'string' ? corps.queue.trim() : '';
    // À défaut de file explicite, teste l'imprimante configurée du poste demandé.
    if (!queue && POSTES_IMPRESSION.includes(corps.poste as PosteImpression)) {
      queue = (await queuePoste(corps.poste as PosteImpression)) ?? '';
    }
    if (!queue) throw new ErreurMetier('Aucune imprimante sélectionnée à tester', 400);
    try {
      const resto = await infosResto();
      await imprimerTest(queue, resto.nom, resto.marque, resto.colonnes);
    } catch (e) {
      throw new ErreurMetier(`Impression de test échouée : ${(e as Error).message}`, 502);
    }
    return { ok: true, queue };
  });

  // ---- Routage d'impression : catégories + exceptions par article (local) ----
  app.get('/api/admin/routage', { preHandler: gardeParam }, async () => {
    const [cats, arts, rc, ra] = await Promise.all([
      db.select({ id: categories.id, nom: categories.nom, ordre: categories.ordre }).from(categories).where(eq(categories.actif, true)),
      db.select({ id: articles.id, nom: articles.nom, categorie_id: articles.categorie_id }).from(articles).where(eq(articles.actif, true)),
      db.select().from(routageCategorie),
      db.select().from(routageArticle),
    ]);
    const posteCat = new Map(rc.map((x) => [x.categorie_id, x.poste]));
    const posteArt = new Map(ra.map((x) => [x.article_id, x.poste]));
    return {
      defaut: POSTE_IMPRESSION_DEFAUT,
      categories: cats
        .sort((a, b) => a.ordre - b.ordre || a.nom.localeCompare(b.nom))
        .map((c) => ({ id: c.id, nom: c.nom, poste: posteCat.get(c.id) ?? null })),
      articles: arts.map((a) => ({ id: a.id, nom: a.nom, categorie_id: a.categorie_id, poste: posteArt.get(a.id) ?? null })),
    };
  });

  // poste = null → efface le routage (revient à l'héritage / défaut).
  const majRoutage = async (
    userId: string,
    cible: 'categorie' | 'article',
    id: string,
    poste: PosteImpression | null,
  ): Promise<void> => {
    const table = cible === 'categorie' ? routageCategorie : routageArticle;
    const col = cible === 'categorie' ? routageCategorie.categorie_id : routageArticle.article_id;
    await db.transaction(async (tx) => {
      if (poste === null) {
        await tx.delete(table).where(eq(col, id));
      } else if (cible === 'categorie') {
        await tx
          .insert(routageCategorie)
          .values({ categorie_id: id, poste })
          .onConflictDoUpdate({ target: routageCategorie.categorie_id, set: { poste, updated_at: new Date() } });
      } else {
        await tx
          .insert(routageArticle)
          .values({ article_id: id, poste })
          .onConflictDoUpdate({ target: routageArticle.article_id, set: { poste, updated_at: new Date() } });
      }
      await journaliser(tx, {
        user_id: userId,
        action: 'MODIF_PARAMETRE',
        entite: cible === 'categorie' ? 'routage_categorie' : 'routage_article',
        entite_id: id,
        meta: { poste },
      });
    });
  };

  app.put('/api/admin/routage/categorie', { preHandler: gardeParam }, async (req) => {
    const corps = (req.body ?? {}) as { categorie_id?: unknown; poste?: unknown };
    if (typeof corps.categorie_id !== 'string') throw new ErreurMetier('Catégorie manquante', 400);
    const poste = corps.poste === null ? null : (corps.poste as PosteImpression);
    if (poste !== null && !POSTES_IMPRESSION.includes(poste)) throw new ErreurMetier('Poste inconnu', 400);
    await majRoutage(req.session!.utilisateur_id, 'categorie', corps.categorie_id, poste);
    return { ok: true };
  });

  app.put('/api/admin/routage/article', { preHandler: gardeParam }, async (req) => {
    const corps = (req.body ?? {}) as { article_id?: unknown; poste?: unknown };
    if (typeof corps.article_id !== 'string') throw new ErreurMetier('Article manquant', 400);
    const poste = corps.poste === null ? null : (corps.poste as PosteImpression);
    if (poste !== null && !POSTES_IMPRESSION.includes(poste)) throw new ErreurMetier('Poste inconnu', 400);
    await majRoutage(req.session!.utilisateur_id, 'article', corps.article_id, poste);
    return { ok: true };
  });

  // ---- Recettes d'inventaire (migration 0022) ----
  // « Que consomme un article vendu ? » — c'est ce qui donne leurs SORTIES aux
  // produits de comptage. Sans recette, un produit reste à 0 et son théorique
  // se réduit à initial + entrées. Réglage du catalogue, donc même garde que
  // les paramètres : aucune permission nouvelle inventée.

  app.get('/api/admin/recettes-inventaire', { preHandler: gardeParam }, async () => {
    const [produits, arts, cats, liens] = await Promise.all([
      db
        .select()
        .from(produitsInventaire)
        .where(eq(produitsInventaire.actif, true))
        .orderBy(asc(produitsInventaire.categorie), asc(produitsInventaire.ordre)),
      db
        .select({ id: articles.id, nom: articles.nom, categorie_id: articles.categorie_id })
        .from(articles)
        .where(eq(articles.actif, true)),
      db.select({ id: categories.id, nom: categories.nom }).from(categories),
      db.select().from(inventaireConsommations),
    ]);

    const parProduit = new Map<string, { article_id: string; quantite: number }[]>();
    for (const l of liens) {
      const liste = parProduit.get(l.produit_id) ?? [];
      liste.push({ article_id: l.article_id, quantite: Number(l.quantite) });
      parProduit.set(l.produit_id, liste);
    }
    const nomCat = new Map(cats.map((c) => [c.id, c.nom]));

    return {
      produits: produits.map((p) => ({
        id: p.id,
        code: p.code,
        categorie: p.categorie,
        nom: p.nom,
        unite: p.unite,
        role: p.role,
        ratio: p.ratio === null ? null : Number(p.ratio),
        recettes: parProduit.get(p.id) ?? [],
      })),
      articles: arts
        .map((a) => ({ id: a.id, nom: a.nom, categorie: nomCat.get(a.categorie_id) ?? '' }))
        .sort((a, b) => a.categorie.localeCompare(b.categorie) || a.nom.localeCompare(b.nom)),
    };
  });

  /** Crée un produit de comptage simple, prêt à recevoir ses liaisons de recette. */
  app.post('/api/admin/recettes-inventaire/produits', { preHandler: gardeParam }, async (req) => {
    const corps = valider(NouveauProduitInventaireSchema, req.body);
    return db.transaction(async (tx) => {
      const produits = await tx.select({ nom: produitsInventaire.nom, categorie: produitsInventaire.categorie, ordre: produitsInventaire.ordre })
        .from(produitsInventaire);
      if (produits.some((p) => p.categorie === corps.categorie && p.nom.toLocaleLowerCase('fr') === corps.nom.toLocaleLowerCase('fr'))) {
        throw new ErreurMetier('Ce produit existe déjà dans cette catégorie', 409);
      }

      const inventairesOuverts = await tx.select({ id: inventairesService.id, valide: inventairesService.valide })
        .from(inventairesService)
        .innerJoin(servicesCaisse, eq(servicesCaisse.id, inventairesService.service_id))
        .where(eq(servicesCaisse.statut, 'OUVERT'));
      if (inventairesOuverts.some((inv) => inv.valide)) {
        throw new ErreurMetier('Un inventaire du service en cours est déjà validé. Créez ce produit après la clôture.', 409);
      }

      const [produit] = await tx.insert(produitsInventaire).values({
        code: `POS_${randomUUID()}`,
        nom: corps.nom,
        categorie: corps.categorie,
        unite: corps.unite,
        prix: corps.prix,
        role: 'COMPTE',
        ordre: Math.max(0, ...produits.filter((p) => p.categorie === corps.categorie).map((p) => p.ordre)) + 1,
      }).returning();

      // L'inventaire peut avoir été ouvert avant la création du produit.
      for (const inv of inventairesOuverts) {
        const [ligne] = await tx.insert(inventaireLignes).values({ inventaire_id: inv.id, produit_id: produit!.id }).returning();
        await ecrireOutbox(tx, 'inventaire_lignes', 'INSERT', ligne!.id, ligne as unknown as Record<string, unknown>);
      }
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'produits_inventaire',
        entite_id: produit!.id,
        meta: { nom: corps.nom, categorie: corps.categorie, unite: corps.unite, prix: corps.prix },
      });
      return { id: produit!.id, nom: produit!.nom };
    });
  });

  /** Premier transfert des produits et recettes déjà présents sur cette caisse. */
  app.post('/api/admin/recettes-inventaire/publier', { preHandler: gardeParam }, async (req) => {
    const resultat = await publierInventaireHistorique();
    if (resultat.produits > 0 || resultat.recettes > 0) {
      await journaliser(db, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'produits_inventaire',
        meta: { publication_siege: resultat },
      });
    }
    return resultat;
  });

  /**
   * Remplace EN BLOC la recette d'un produit : c'est un écran de liste, on
   * enregistre ce qui est à l'écran. Une liste vide efface la recette — et ce
   * vide est délibéré, `appliquerRecettesDefaut()` ne le remplira pas.
   */
  app.put('/api/admin/recettes-inventaire/:produitId', { preHandler: gardeParam }, async (req) => {
    const { produitId } = req.params as { produitId: string };
    const corps = valider(RecettesSchema, req.body);

    const [produit] = await db.select().from(produitsInventaire).where(eq(produitsInventaire.id, produitId));
    if (!produit) throw new ErreurMetier('Produit d’inventaire introuvable', 404);

    // Doublon d'article : la clé unique le refuserait, autant le dire en clair.
    const vus = new Set<string>();
    for (const r of corps.recettes) {
      if (vus.has(r.article_id)) throw new ErreurMetier('Un article ne peut figurer qu’une fois dans la recette', 400);
      vus.add(r.article_id);
    }

    await db.transaction(async (tx) => {
      await tx.delete(inventaireConsommations).where(eq(inventaireConsommations.produit_id, produitId));
      if (corps.recettes.length > 0) {
        await tx.insert(inventaireConsommations).values(
          corps.recettes.map((r) => ({
            produit_id: produitId,
            article_id: r.article_id,
            quantite: String(r.quantite),
          })),
        );
      }
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'inventaire_consommations',
        entite_id: produitId,
        meta: { produit: produit.nom, articles: corps.recettes.length },
      });
    });
    return { ok: true, produit_id: produitId, recettes: corps.recettes };
  });

  /** Repose le jeu par défaut sur les produits qui n'ont AUCUNE recette. */
  app.post('/api/admin/recettes-inventaire/defaut', { preHandler: gardeParam }, async (req) => {
    const inserees = await appliquerRecettesDefaut(db);
    if (inserees > 0) {
      await journaliser(db, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'inventaire_consommations',
        meta: { recettes_defaut_posees: inserees },
      });
    }
    return { inserees };
  });

  // ---- Configuration de l'identité du restaurant (déploiement multi-restos) ----
  const gardeResto = app.exigePermission('reglages.restaurant');

  app.get('/api/admin/restaurant/config', { preHandler: gardeResto }, async () => {
    const [resto] = await db.select().from(restaurant).limit(1);
    const [p] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, 'samtrackly_restaurant_id'));
    const profil = await lireProfilRestaurant('ALA_BRAISE');
    const restaurants = [
      {
        id: `profil:${profil.code}`,
        nom: profil.restaurant.nom,
        couleur: profil.restaurant.couleur_hex,
        source: 'PROFIL_LOCAL' as const,
      },
      ...(await restaurantsSamtrackly()),
    ];
    return {
      actuel: resto ? { code: resto.code, nom: resto.nom, marque: resto.marque, couleur_hex: resto.couleur_hex } : null,
      restaurant_id: resto?.id ?? '',
      samtrackly_restaurant_id: typeof p?.valeur === 'string' ? p.valeur : '',
      restaurants,
    };
  });

  app.post('/api/admin/restaurant/config', { preHandler: gardeResto }, async (req) => {
    const corps = valider(ConfigRestaurantSchema, req.body);
    if ('profil_code' in corps) {
      await importerProfilRestaurant(corps.profil_code);
      const [cleExistante] = await db
        .select()
        .from(parametresLocaux)
        .where(eq(parametresLocaux.cle, 'cle_site'));
      await db.delete(parametresLocaux).where(eq(parametresLocaux.cle, 'cle_site'));
      await db.delete(parametresLocaux).where(eq(parametresLocaux.cle, 'samtrackly_restaurant_id'));
      await db.delete(parametresLocaux).where(eq(parametresLocaux.cle, 'mode_configuration_site'));
      await journaliser(db, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'restaurant',
        meta: { detail: 'Import profil restaurant', profil_code: corps.profil_code },
      });
      if (cleExistante) moteurSync.arreter();
      const profil = await lireProfilRestaurant(corps.profil_code);
      return {
        code: profil.code,
        nom: profil.restaurant.nom,
        marque: profil.restaurant.marque,
        couleur_hex: profil.restaurant.couleur_hex,
        sync_a_reenroler: !!cleExistante,
      };
    }
    const { samtrackly_restaurant_id } = corps;
    const remplacement = 'mode' in corps && corps.mode === 'REMPLACEMENT';
    const restaurantIdExistant = remplacement ? corps.restaurant_id_existant : null;
    const choisi = (await restaurantsSamtrackly()).find((r) => r.id === samtrackly_restaurant_id);
    if (!choisi) throw new ErreurMetier('Restaurant SamerTrackly introuvable (clé/connexion ?)', 404);

    const marque = marqueRestaurant(choisi.nom);
    const couleur = estHex(choisi.couleur) ? choisi.couleur : marque === 'AL_KAYAN' ? '#2D7D46' : marque === 'A_LA_BRAISE' ? '#D99A2B' : '#EF9F27';
    const code = marque === 'A_LA_BRAISE' ? 'ALA_BRAISE' : slug(choisi.nom);

    const [dejaPose] = await db
      .select()
      .from(parametresLocaux)
      .where(eq(parametresLocaux.cle, 'samtrackly_restaurant_id'));
    // Installation neuve : une identité cloud neuve empêche les copies de
    // l'image master de partager le même UUID. Remplacement matériel : on fait
    // exactement l'inverse et on reprend l'UUID cloud du site existant afin de
    // garder son historique et sa ligne `sites_autorises`.
    const changeDeResto = (typeof dejaPose?.valeur === 'string' ? dejaPose.valeur : '') !== samtrackly_restaurant_id;
    let identiteRegeneree = false;
    let syncInvalidee = false;

    await db.transaction(async (tx) => {
      if (remplacement) {
        const [compteCommandes] = await tx.select({ nb: count() }).from(commandes);
        const [compteServices] = await tx.select({ nb: count() }).from(servicesCaisse);
        if (Number(compteCommandes?.nb ?? 0) > 0 || Number(compteServices?.nb ?? 0) > 0) {
          throw new ErreurMetier(
            'Le remplacement doit être configuré sur une base neuve, sans vente ni service de caisse',
            409,
          );
        }
      }
      const [resto] = await tx.select().from(restaurant).limit(1);
      const champs = { code, nom: choisi.nom, marque, couleur_hex: couleur };
      if (resto) {
        if (remplacement) {
          await tx
            .update(restaurant)
            .set({ ...champs, id: restaurantIdExistant! })
            .where(eq(restaurant.id, resto.id));
          identiteRegeneree = resto.id !== restaurantIdExistant;
        } else if (changeDeResto) {
          await tx.update(restaurant).set({ ...champs, id: randomUUID() }).where(eq(restaurant.id, resto.id));
          identiteRegeneree = true;
        } else {
          await tx.update(restaurant).set(champs).where(eq(restaurant.id, resto.id));
        }
      } else {
        await tx.insert(restaurant).values(remplacement ? { ...champs, id: restaurantIdExistant! } : champs);
        identiteRegeneree = true;
      }

      // La clé de site enrôlée pointait sur l'ANCIEN restaurant_id : la garder
      // ferait remonter les ventes de ce site sous l'identité du précédent.
      // On la supprime → la synchro s'arrête jusqu'à un nouveau `pnpm site:enroler`.
      if (identiteRegeneree) {
        const supprimees = await tx
          .delete(parametresLocaux)
          .where(eq(parametresLocaux.cle, 'cle_site'))
          .returning({ cle: parametresLocaux.cle });
        syncInvalidee = supprimees.length > 0;
      }

      await tx
        .insert(parametresLocaux)
        .values({ cle: 'samtrackly_restaurant_id', valeur: samtrackly_restaurant_id as never })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: samtrackly_restaurant_id as never } });
      await tx
        .insert(parametresLocaux)
        .values({ cle: 'mode_configuration_site', valeur: (remplacement ? 'REMPLACEMENT' : 'NOUVEAU') as never })
        .onConflictDoUpdate({
          target: parametresLocaux.cle,
          set: { valeur: (remplacement ? 'REMPLACEMENT' : 'NOUVEAU') as never },
        });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'restaurant',
        meta: {
          detail: 'Configuration restaurant',
          nom: choisi.nom,
          marque,
          samtrackly_restaurant_id,
          mode: remplacement ? 'REMPLACEMENT' : 'NOUVEAU',
          restaurant_id_repris: remplacement ? restaurantIdExistant : null,
          identite_regeneree: identiteRegeneree,
          sync_a_reenroler: syncInvalidee,
        },
      });
    });

    // Coupe les boucles de synchro en cours : elles tournent avec l'ancienne clé.
    if (syncInvalidee) moteurSync.arreter();

    return {
      code,
      nom: choisi.nom,
      marque,
      couleur_hex: couleur,
      restaurant_id: restaurantIdExistant,
      identite_reprise: remplacement,
      sync_a_reenroler: syncInvalidee,
      // Même si l'image neuve ne contenait aucune clé à effacer, le poste de
      // remplacement doit recevoir/récupérer la clé du site avant la synchro.
      sync_a_activer: remplacement || syncInvalidee,
    };
  });

  // ---- Journal d'audit : lecture seule + filtres (2.7) ----
  app.get('/api/admin/audit', { preHandler: app.exigePermission('reglages.audit') }, async (req) => {
    const q = req.query as { depuis?: string; jusqua?: string; user_id?: string; action?: string; limite?: string };
    const conditions = [];
    if (q.depuis) conditions.push(gte(auditLog.created_at, new Date(q.depuis)));
    if (q.jusqua) conditions.push(lte(auditLog.created_at, new Date(q.jusqua)));
    if (q.user_id) conditions.push(eq(auditLog.user_id, q.user_id));
    if (q.action) conditions.push(eq(auditLog.action, q.action));
    const limite = Math.min(Number(q.limite ?? 200) || 200, 500);

    const lignes = await db
      .select({
        seq: auditLog.seq,
        created_at: auditLog.created_at,
        action: auditLog.action,
        entite: auditLog.entite,
        entite_id: auditLog.entite_id,
        montant: auditLog.montant,
        motif: auditLog.motif,
        meta: auditLog.meta,
        user_id: auditLog.user_id,
        user_nom: utilisateurs.nom_complet,
      })
      .from(auditLog)
      .leftJoin(utilisateurs, eq(utilisateurs.id, auditLog.user_id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.seq))
      .limit(limite);
    return lignes.map((l) => ({ ...l, created_at: l.created_at.toISOString() }));
  });

  // ---- Santé : redémarrage du service (2.7) ----
  app.post('/api/admin/redemarrer', { preHandler: app.exigePermission('reglages.sante') }, async (req) => {
    await db.transaction(async (tx) => {
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'systeme',
        meta: { detail: 'Demande de redémarrage du service' },
      });
    });
    // Le redémarrage effectif est confié au gestionnaire de processus (systemd /
    // pm2) : on sort proprement peu après avoir répondu.
    setTimeout(() => process.exit(0), 200);
    return { ok: true, message: 'Le service redémarre…' };
  });
}
