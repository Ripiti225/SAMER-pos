/**
 * Options réutilisables (migration 0020) — administration depuis la caisse.
 * Guard : permission `reglages.catalogue`, comme le reste du menu.
 *
 * Contrairement au catalogue (articles, prix), qui s'édite au SIÈGE et redescend
 * par la synchro, les options sont une donnée LOCALE : elles s'écrivent
 * directement dans la base du restaurant, fonctionnent hors ligne, et ne sont
 * jamais écrasées par une descente (elles n'y figurent pas). La remontée vers le
 * cloud est préparée — chaque écriture pose sa ligne sync_outbox — mais n'est
 * pas encore branchée côté siège.
 *
 * Les commandes déjà passées ne changent JAMAIS : le nom et le prix de l'option
 * sont figés dans commande_items.supplements au moment de l'ajout (snapshot).
 * Modifier ou supprimer une option ici est donc sans effet sur l'historique.
 */
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { CreerOptionSchema, LierOptionSchema, ModifierOptionSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { articles, categories, optionsCatalogue, optionsLiaisons } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';

/** Doublon d'option : contrainte d'unicité (nom, prix) côté base. */
function estDoublon(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}

export function routesOptionsAdmin(app: FastifyInstance): void {
  const garde = app.exigePermission('reglages.catalogue');

  /** Tout ce qu'il faut à l'écran : options, liaisons, et les cibles possibles. */
  app.get('/api/admin/options', { preHandler: garde }, async () => {
    const [opts, liens, cats, arts] = await Promise.all([
      db.select().from(optionsCatalogue).orderBy(asc(optionsCatalogue.ordre), asc(optionsCatalogue.nom)),
      db.select().from(optionsLiaisons),
      db.select().from(categories).where(eq(categories.actif, true)).orderBy(asc(categories.ordre)),
      db.select().from(articles).where(eq(articles.actif, true)).orderBy(asc(articles.nom)),
    ]);

    return {
      options: opts.map((o) => ({
        id: o.id,
        nom: o.nom,
        prix: o.prix,
        actif: o.actif,
        ordre: o.ordre,
        liaisons: liens
          .filter((l) => l.option_id === o.id)
          .map((l) => ({
            id: l.id,
            categorie_id: l.categorie_id,
            article_id: l.article_id,
            libelle: l.categorie_id
              ? `Catégorie ${cats.find((c) => c.id === l.categorie_id)?.nom ?? '(supprimée)'}`
              : arts.find((a) => a.id === l.article_id)?.nom ?? '(article supprimé)',
          })),
      })),
      categories: cats.map((c) => ({ id: c.id, nom: c.nom })),
      articles: arts.map((a) => ({ id: a.id, nom: a.nom, categorie_id: a.categorie_id })),
    };
  });

  app.post('/api/admin/options', { preHandler: garde }, async (req) => {
    const corps = valider(CreerOptionSchema, req.body);
    return db.transaction(async (tx) => {
      let cree;
      try {
        [cree] = await tx.insert(optionsCatalogue).values({ nom: corps.nom, prix: corps.prix }).returning();
      } catch (e) {
        if (estDoublon(e)) {
          throw new ErreurMetier('Cette option existe déjà avec ce prix', 409);
        }
        throw e;
      }
      await ecrireOutbox(tx, 'options_catalogue', 'INSERT', cree!.id, cree as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: 'options_catalogue',
        entite_id: cree!.id,
        montant: cree!.prix,
        meta: { op: 'creation', nom: cree!.nom },
      });
      app.diffuser('catalogue');
      return cree;
    });
  });

  app.patch('/api/admin/options/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ModifierOptionSchema, req.body);
    return db.transaction(async (tx) => {
      const [avant] = await tx.select().from(optionsCatalogue).where(eq(optionsCatalogue.id, id));
      if (!avant) throw introuvable('Option');

      let maj;
      try {
        [maj] = await tx
          .update(optionsCatalogue)
          .set({ ...corps, updated_at: new Date() })
          .where(eq(optionsCatalogue.id, id))
          .returning();
      } catch (e) {
        if (estDoublon(e)) {
          throw new ErreurMetier('Une autre option porte déjà ce nom à ce prix', 409);
        }
        throw e;
      }
      await ecrireOutbox(tx, 'options_catalogue', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: 'options_catalogue',
        entite_id: id,
        montant: maj!.prix,
        // Le prix d'avant est tracé : c'est la seule façon de reconstituer
        // pourquoi deux tickets du même jour n'affichent pas le même montant.
        meta: { op: 'modification', avant: { nom: avant.nom, prix: avant.prix, actif: avant.actif } },
      });
      app.diffuser('catalogue');
      return maj;
    });
  });

  app.delete('/api/admin/options/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    return db.transaction(async (tx) => {
      const [opt] = await tx.select().from(optionsCatalogue).where(eq(optionsCatalogue.id, id));
      if (!opt) throw introuvable('Option');
      // Les liaisons partent en cascade (ON DELETE CASCADE). Les commandes déjà
      // passées gardent leur snapshot : rien ne change dans l'historique.
      await tx.delete(optionsCatalogue).where(eq(optionsCatalogue.id, id));
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: 'options_catalogue',
        entite_id: id,
        meta: { op: 'suppression', nom: opt.nom, prix: opt.prix },
      });
      app.diffuser('catalogue');
      return { ok: true };
    });
  });

  /** Lier une option à une catégorie entière OU à un article précis. */
  app.post('/api/admin/options/:id/liaisons', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(LierOptionSchema, req.body);
    return db.transaction(async (tx) => {
      const [opt] = await tx.select().from(optionsCatalogue).where(eq(optionsCatalogue.id, id));
      if (!opt) throw introuvable('Option');

      let lien;
      try {
        [lien] = await tx
          .insert(optionsLiaisons)
          .values({
            option_id: id,
            categorie_id: corps.categorie_id ?? null,
            article_id: corps.article_id ?? null,
          })
          .returning();
      } catch (e) {
        if (estDoublon(e)) throw new ErreurMetier('Cette liaison existe déjà', 409);
        throw e;
      }
      await ecrireOutbox(tx, 'options_liaisons', 'INSERT', lien!.id, lien as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: 'options_liaisons',
        entite_id: lien!.id,
        meta: { op: 'liaison', option: opt.nom, categorie_id: corps.categorie_id, article_id: corps.article_id },
      });
      app.diffuser('catalogue');
      return lien;
    });
  });

  app.delete('/api/admin/liaisons/:liaisonId', { preHandler: garde }, async (req) => {
    const { liaisonId } = req.params as { liaisonId: string };
    return db.transaction(async (tx) => {
      const [lien] = await tx.select().from(optionsLiaisons).where(eq(optionsLiaisons.id, liaisonId));
      if (!lien) throw introuvable('Liaison');
      await tx.delete(optionsLiaisons).where(eq(optionsLiaisons.id, liaisonId));
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: 'options_liaisons',
        entite_id: liaisonId,
        meta: { op: 'deliaison', option_id: lien.option_id },
      });
      app.diffuser('catalogue');
      return { ok: true };
    });
  });
}
