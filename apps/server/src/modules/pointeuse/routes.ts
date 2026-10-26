/**
 * Réglages › Pointeuse : adresse de l'appareil, état de la lecture, n° des
 * employés dans la pointeuse, et envoi de l'équipe vers l'appareil (le visage
 * s'enrôle ensuite sur la pointeuse elle-même).
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { parametresLocaux, pointeuseEvenements, utilisateurs } from '../../db/schema/index.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { enregistrerEmploye, enregistrerVisage, ErreurPointeuse, lireInfoAppareil } from './isapi.js';
import { photoPourPointeuse } from './photo.js';
import { etatPointeuse, lirePointeuse, reinitialiserPointeuse } from './moteur.js';
import { appliquerEvenement, chargerConfigPointeuse, CLES_POINTEUSE } from './presence.js';

const ConfigSchema = z.object({
  // Vide = pointeuse retirée : retour à l'équipe cochée à la main.
  url: z.string().trim().max(200),
  utilisateur: z.string().trim().max(64).default('admin'),
  // Absent = inchangé (le mot de passe n'est jamais renvoyé à l'écran).
  mot_de_passe: z.string().max(64).optional(),
});

const NumeroSchema = z.object({
  pointeuse_no: z
    .string()
    .trim()
    .regex(/^\d{1,16}$/, 'Le n° pointeuse est un nombre (celui affiché sur l’appareil)')
    .nullable(),
});

/** Les INCONNU récents sont relus quand on rattache leur numéro à quelqu'un. */
const RATTRAPAGE_INCONNUS_MS = 16 * 3600_000;

function messagePointeuse(e: unknown): never {
  if (e instanceof ErreurPointeuse) throw new ErreurMetier(e.message, 502);
  throw e;
}

export function routesPointeuse(app: FastifyInstance): void {
  const garde = app.exigePermission('reglages.parametres');

  app.get('/api/admin/pointeuse', { preHandler: garde }, async () => {
    const config = await chargerConfigPointeuse();
    const [mdp] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, CLES_POINTEUSE.motDePasse));

    const employes = await db
      .select({ id: utilisateurs.id, nom_complet: utilisateurs.nom_complet, pointeuse_no: utilisateurs.pointeuse_no })
      .from(utilisateurs)
      .where(eq(utilisateurs.actif, true))
      .orderBy(asc(utilisateurs.nom_complet));

    const inconnus = await db
      .select({
        employe_no: pointeuseEvenements.employe_no,
        nom_appareil: sql<string | null>`MAX(${pointeuseEvenements.nom_appareil})`,
        nb: sql<number>`COUNT(*)::int`,
        dernier: sql<string>`MAX(${pointeuseEvenements.pointe_le})`,
      })
      .from(pointeuseEvenements)
      .where(eq(pointeuseEvenements.statut, 'INCONNU'))
      .groupBy(pointeuseEvenements.employe_no);

    const derniers = await db
      .select({
        id: pointeuseEvenements.id,
        employe_no: pointeuseEvenements.employe_no,
        nom: sql<string>`COALESCE(${utilisateurs.nom_complet}, ${pointeuseEvenements.nom_appareil}, '')`,
        sens: pointeuseEvenements.sens,
        pointe_le: pointeuseEvenements.pointe_le,
        statut: pointeuseEvenements.statut,
      })
      .from(pointeuseEvenements)
      .leftJoin(utilisateurs, eq(utilisateurs.id, pointeuseEvenements.utilisateur_id))
      .orderBy(desc(pointeuseEvenements.pointe_le))
      .limit(30);

    return {
      config: {
        url: config?.url ?? '',
        utilisateur: config?.utilisateur ?? 'admin',
        mot_de_passe_defini: typeof mdp?.valeur === 'string' && mdp.valeur.length > 0,
        // Réglée par variable d'environnement : non modifiable depuis l'écran.
        par_environnement: !!process.env.POINTEUSE_URL,
      },
      etat: etatPointeuse(),
      employes,
      inconnus: inconnus.map((i) => ({ ...i, dernier: new Date(i.dernier).toISOString() })),
      derniers: derniers.map((d) => ({ ...d, pointe_le: d.pointe_le.toISOString() })),
    };
  });

  app.put('/api/admin/pointeuse', { preHandler: garde }, async (req) => {
    const corps = valider(ConfigSchema, req.body);
    const valeurs: [string, string][] = [
      [CLES_POINTEUSE.url, corps.url],
      [CLES_POINTEUSE.utilisateur, corps.utilisateur || 'admin'],
    ];
    if (corps.mot_de_passe !== undefined) valeurs.push([CLES_POINTEUSE.motDePasse, corps.mot_de_passe]);

    await db.transaction(async (tx) => {
      for (const [cle, valeur] of valeurs) {
        await tx
          .insert(parametresLocaux)
          .values({ cle, valeur })
          .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur, updated_at: new Date() } });
      }
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'REGLAGE_POINTEUSE',
        entite: 'parametres_locaux',
        meta: { url: corps.url, utilisateur: corps.utilisateur, mot_de_passe_change: corps.mot_de_passe !== undefined },
      });
    });
    reinitialiserPointeuse();

    if (!corps.url) return { ok: true, appareil: null };
    const config = await chargerConfigPointeuse();
    const info = await lireInfoAppareil(config!).catch(messagePointeuse);
    return { ok: true, appareil: info };
  });

  /** « Lire maintenant » : n'attend pas les 20 s de la boucle. */
  app.post('/api/admin/pointeuse/lire', { preHandler: garde }, async () => {
    const nouveaux = await lirePointeuse(() => app.diffuser('pointage')).catch(messagePointeuse);
    return { nouveaux };
  });

  app.patch('/api/admin/pointeuse/employes/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const { pointeuse_no } = valider(NumeroSchema, req.body);

    const [agent] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, id));
    if (!agent) throw introuvable('Employé');
    if (pointeuse_no) {
      const [autre] = await db
        .select({ nom: utilisateurs.nom_complet })
        .from(utilisateurs)
        .where(and(eq(utilisateurs.pointeuse_no, pointeuse_no), sql`${utilisateurs.id} <> ${id}`));
      if (autre) throw new ErreurMetier(`Le n° ${pointeuse_no} est déjà celui de ${autre.nom}`, 409);
    }

    const rattrapes = await db.transaction(async (tx) => {
      await tx.update(utilisateurs).set({ pointeuse_no, updated_at: new Date() }).where(eq(utilisateurs.id, id));
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'NUMERO_POINTEUSE',
        entite: 'utilisateurs',
        entite_id: id,
        meta: { agent: agent.nom_complet, avant: agent.pointeuse_no, apres: pointeuse_no },
      });
      if (!pointeuse_no) return 0;

      // Pointages déjà faits sous ce numéro avant qu'on le rattache : relus,
      // pour que l'arrivée de ce matin ne soit pas perdue.
      const inconnus = await tx
        .select()
        .from(pointeuseEvenements)
        .where(and(
          eq(pointeuseEvenements.statut, 'INCONNU'),
          eq(pointeuseEvenements.employe_no, pointeuse_no),
          gt(pointeuseEvenements.pointe_le, new Date(Date.now() - RATTRAPAGE_INCONNUS_MS)),
        ))
        .orderBy(asc(pointeuseEvenements.pointe_le));
      for (const ev of inconnus) {
        await tx.delete(pointeuseEvenements).where(eq(pointeuseEvenements.id, ev.id));
        await appliquerEvenement(tx, ev.appareil, {
          numero: ev.numero,
          employe_no: ev.employe_no,
          nom: ev.nom_appareil,
          sens: ev.sens as 'ENTREE' | 'SORTIE',
          pointe_le: ev.pointe_le,
        });
      }
      return inconnus.length;
    });

    if (rattrapes > 0) app.diffuser('pointage');
    return { id, pointeuse_no, pointages_rattrapes: rattrapes };
  });

  /**
   * Envoie toute l'équipe active dans la pointeuse. Qui n'a pas encore de
   * numéro en reçoit un (le plus grand + 1), et son visage est enregistré à
   * partir de sa photo SamerTrackly. Ceux dont la photo manque ou est refusée
   * sont renvoyés à l'écran : à enrôler sur l'appareil (visage ou empreinte).
   */
  app.post('/api/admin/pointeuse/envoyer-equipe', { preHandler: garde }, async (req) => {
    const config = await chargerConfigPointeuse();
    if (!config) throw new ErreurMetier('Renseignez d’abord l’adresse de la pointeuse', 409);

    const actifs = await db
      .select({ id: utilisateurs.id, nom: utilisateurs.nom_complet, no: utilisateurs.pointeuse_no, photo: utilisateurs.photo_url })
      .from(utilisateurs)
      .where(eq(utilisateurs.actif, true))
      .orderBy(asc(utilisateurs.nom_complet));
    const numeros = await db
      .select({ no: utilisateurs.pointeuse_no })
      .from(utilisateurs)
      .where(isNotNull(utilisateurs.pointeuse_no));
    let prochain = Math.max(0, ...numeros.map((n) => Number(n.no) || 0)) + 1;

    let attribues = 0;
    for (const a of actifs) {
      if (a.no) continue;
      a.no = String(prochain++);
      await db.update(utilisateurs).set({ pointeuse_no: a.no, updated_at: new Date() }).where(eq(utilisateurs.id, a.id));
      attribues++;
    }

    let envoyes = 0;
    let visages = 0;
    const echecs: { nom: string; erreur: string }[] = [];
    // Sans visage dans l'appareil (pas de photo, ou photo refusée) : à enrôler
    // sur la pointeuse — visage, ou empreinte si le visage ne passe pas.
    const aEnroler: { nom: string; numero: string; raison: string }[] = [];
    for (const a of actifs) {
      try {
        await enregistrerEmploye(config, a.no!, a.nom);
        envoyes++;
      } catch (e) {
        // Pointeuse injoignable : inutile d'insister pour les suivants.
        if (e instanceof ErreurPointeuse && /injoignable|incorrect/.test(e.message)) messagePointeuse(e);
        echecs.push({ nom: a.nom, erreur: (e as Error).message });
        continue;
      }
      if (!a.photo) {
        aEnroler.push({ nom: a.nom, numero: a.no!, raison: 'pas de photo dans SamerTrackly' });
        continue;
      }
      const photo = await photoPourPointeuse(a.photo);
      if ('raison' in photo) {
        aEnroler.push({ nom: a.nom, numero: a.no!, raison: photo.raison });
        continue;
      }
      try {
        await enregistrerVisage(config, a.no!, photo.jpeg);
        visages++;
      } catch (e) {
        if (e instanceof ErreurPointeuse && /injoignable|incorrect/.test(e.message)) messagePointeuse(e);
        aEnroler.push({ nom: a.nom, numero: a.no!, raison: `photo refusée par la pointeuse — ${(e as Error).message}` });
      }
    }

    await db.transaction((tx) =>
      journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'REGLAGE_POINTEUSE',
        entite: 'utilisateurs',
        meta: { envoi_equipe: true, envoyes, attribues, visages, a_enroler: aEnroler.length, echecs: echecs.length },
      }),
    );
    return { envoyes, attribues, visages, a_enroler: aEnroler, echecs };
  });
}
