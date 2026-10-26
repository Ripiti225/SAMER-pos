/**
 * Pointeuse → équipe du shift (décisions du propriétaire, 2026-10-26).
 *
 *   - L'arrivée est l'heure RÉELLE du pointage, même avant l'ouverture du
 *     shift : une Entrée pointée sans shift ouvert reste EN_ATTENTE et entre
 *     dans l'équipe à l'ouverture, avec son heure à elle.
 *   - Une Sortie puis une Entrée dans le même shift : l'absence est DÉDUITE
 *     (`secondes_absence`).
 *   - Une Sortie pointée = « parti » : la clôture ne pose plus la question
 *     pour cette personne. Les autres sont tranchés un par un à « J'ai fini ».
 *
 * Un shift déjà clôturé est figé : un pointage qui le concerne mais qui
 * arrive en retard (pointeuse injoignable un moment) est gardé dans le
 * journal sans rien changer à la paie déjà arrêtée.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { db, type DbOuTx } from '../../db/client.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { equipeService, parametresLocaux, pointeuseEvenements, servicesCaisse, utilisateurs } from '../../db/schema/index.js';
import type { ConfigPointeuse, EvenementBrut } from './isapi.js';

/** Même borne que la relève (DUREE_SERVICE_HEURES) : au-delà, ce n'est plus une arrivée. */
const FRAICHEUR_ATTENTE_MS = 8 * 3600_000;
/** Fenêtre où l'on cherche le dernier geste d'un employé avant l'ouverture. */
const FENETRE_OUVERTURE_MS = 16 * 3600_000;
/** Passages répétés d'un même employé, sans touche Entrée/Sortie : un seul compte. */
const ANTI_REBOND_MS = 2 * 60_000;

export const CLES_POINTEUSE = {
  url: 'pointeuse_url',
  utilisateur: 'pointeuse_utilisateur',
  motDePasse: 'pointeuse_mot_de_passe',
} as const;

async function param(dbx: DbOuTx, cle: string): Promise<string | null> {
  const [p] = await dbx.select().from(parametresLocaux).where(eq(parametresLocaux.cle, cle));
  return typeof p?.valeur === 'string' && p.valeur.trim() ? p.valeur.trim() : null;
}

/** Variables d'environnement prioritaires (comme la synchro), sinon Réglages › Pointeuse. */
export async function chargerConfigPointeuse(dbx: DbOuTx = db): Promise<ConfigPointeuse | null> {
  const url = process.env.POINTEUSE_URL || (await param(dbx, CLES_POINTEUSE.url));
  if (!url) return null;
  return {
    url: /^https?:\/\//i.test(url) ? url : `http://${url}`,
    utilisateur: process.env.POINTEUSE_UTILISATEUR || (await param(dbx, CLES_POINTEUSE.utilisateur)) || 'admin',
    motDePasse: process.env.POINTEUSE_MOT_DE_PASSE || (await param(dbx, CLES_POINTEUSE.motDePasse)) || '',
  };
}

/** Pointeuse en service sur ce site : l'équipe ne se coche plus à la main. */
export async function pointeuseActive(dbx: DbOuTx = db): Promise<boolean> {
  return (await chargerConfigPointeuse(dbx)) !== null;
}

type Agent = typeof utilisateurs.$inferSelect;

export function posteParDefaut(agent: Pick<Agent, 'poste' | 'poste_cuisine'>): string {
  return agent.poste ?? agent.poste_cuisine ?? 'EQUIPIER';
}

export type StatutEvenement = 'APPLIQUE' | 'EN_ATTENTE' | 'INCONNU' | 'IGNORE';

/**
 * Enregistre UN pointage lu sur l'appareil et le reporte sur l'équipe.
 * Idempotent : un pointage déjà connu (appareil + numéro) est sans effet.
 * Renvoie le statut, ou null s'il était déjà traité.
 */
export async function appliquerEvenement(
  tx: DbOuTx,
  appareil: string,
  ev: EvenementBrut,
): Promise<StatutEvenement | null> {
  const [deja] = await tx
    .select({ id: pointeuseEvenements.id })
    .from(pointeuseEvenements)
    .where(and(eq(pointeuseEvenements.appareil, appareil), eq(pointeuseEvenements.numero, ev.numero)));
  if (deja) return null;

  // Horloge de l'appareil en avance : on ne date jamais dans le futur.
  const t = new Date(Math.min(ev.pointe_le.getTime(), Date.now()));
  const [agent] = await tx
    .select()
    .from(utilisateurs)
    .where(and(eq(utilisateurs.pointeuse_no, ev.employe_no), eq(utilisateurs.actif, true)));

  const noter = async (statut: StatutEvenement, sens: 'ENTREE' | 'SORTIE', serviceId: string | null = null) => {
    await tx.insert(pointeuseEvenements).values({
      appareil,
      numero: ev.numero,
      employe_no: ev.employe_no,
      nom_appareil: ev.nom,
      utilisateur_id: agent?.id ?? null,
      sens,
      pointe_le: t,
      statut,
      service_id: serviceId,
    });
    return statut;
  };

  if (!agent) return noter('INCONNU', ev.sens ?? 'ENTREE');

  // Anti-rebond, quand l'appareil ne dit pas Entrée/Sortie : on repasse
  // souvent le doigt 3 ou 4 fois de suite (vu sur la pointeuse le 2026-10-26),
  // et chaque passage ferait basculer Entrée → Sortie → Entrée.
  if (ev.sens === null) {
    const [recent] = await tx
      .select({ id: pointeuseEvenements.id })
      .from(pointeuseEvenements)
      .where(and(
        eq(pointeuseEvenements.utilisateur_id, agent.id),
        eq(pointeuseEvenements.statut, 'APPLIQUE'),
        gt(pointeuseEvenements.pointe_le, new Date(t.getTime() - ANTI_REBOND_MS)),
        lte(pointeuseEvenements.pointe_le, t),
      ))
      .limit(1);
    if (recent) return noter('IGNORE', 'ENTREE');
  }

  // Le shift en cours au moment du pointage…
  const [pendant] = await tx
    .select()
    .from(servicesCaisse)
    .where(and(
      lte(servicesCaisse.ouvert_le, t),
      or(isNull(servicesCaisse.cloture_le), gt(servicesCaisse.cloture_le, t)),
    ))
    .orderBy(desc(servicesCaisse.ouvert_le))
    .limit(1);
  // …et, faute de shift à cette heure-là, celui qui est ouvert maintenant
  // (arrivée pointée avant l'ouverture, lue après).
  const [ouvert] = pendant ? [] : await tx.select().from(servicesCaisse).where(eq(servicesCaisse.statut, 'OUVERT'));

  const service = pendant ?? ouvert;
  if (pendant && pendant.statut !== 'OUVERT') return noter('IGNORE', ev.sens ?? 'ENTREE', pendant.id);

  const [membre] = service
    ? await tx
        .select()
        .from(equipeService)
        .where(and(eq(equipeService.service_id, service.id), eq(equipeService.utilisateur_id, agent.id)))
    : [];
  const present = !!membre?.pointe_le && !membre.depart_le;
  // Pointeuse sans touche Entrée/Sortie : on bascule selon l'état.
  const sens = ev.sens ?? (present ? 'SORTIE' : 'ENTREE');

  if (!service) return noter(sens === 'ENTREE' ? 'EN_ATTENTE' : 'IGNORE', sens);
  // Pointages d'avant l'ouverture lus après : reportés sur le shift ouvert,
  // la Sortie comme l'Entrée (sinon un « entré 7h40, sorti 7h50 » lu à 8h05
  // resterait affiché présent).

  if (sens === 'ENTREE') {
    if (present) return noter('IGNORE', sens, service.id); // double passage
    if (!membre) {
      const [ligne] = await tx
        .insert(equipeService)
        .values({
          service_id: service.id,
          utilisateur_id: agent.id,
          poste_jour: posteParDefaut(agent),
          pointe_le: t,
          source: 'POINTEUSE',
        })
        .returning();
      await ecrireOutbox(tx, 'equipe_service', 'INSERT', ligne!.id, ligne as unknown as Record<string, unknown>);
    } else {
      const retour = membre.pointe_le && membre.depart_le;
      const [ligne] = await tx
        .update(equipeService)
        .set(retour
          ? {
              // Retour après une sortie : l'absence est déduite.
              secondes_absence: membre.secondes_absence
                + Math.max(0, Math.floor((t.getTime() - membre.depart_le!.getTime()) / 1000)),
              depart_le: null,
              reste: null,
            }
          : { pointe_le: t, source: 'POINTEUSE' })
        .where(eq(equipeService.id, membre.id))
        .returning();
      await ecrireOutbox(tx, 'equipe_service', 'UPDATE', ligne!.id, ligne as unknown as Record<string, unknown>);
    }
    return noter('APPLIQUE', sens, service.id);
  }

  // SORTIE pendant le shift
  if (!present || t.getTime() < membre!.pointe_le!.getTime()) return noter('IGNORE', sens, service.id);
  const [ligne] = await tx
    .update(equipeService)
    .set({ depart_le: t, reste: false })
    .where(eq(equipeService.id, membre!.id))
    .returning();
  await ecrireOutbox(tx, 'equipe_service', 'UPDATE', ligne!.id, ligne as unknown as Record<string, unknown>);
  return noter('APPLIQUE', sens, service.id);
}

export interface MembrePointe {
  /** null = arrivée datée de l'ouverture (relève restée du shift précédent). */
  pointe_le: Date | null;
  evenements: string[];
}

/**
 * Équipe que la pointeuse donne pour un shift qui s'ouvre :
 *   - les « Reste » du shift précédent (`restants`), sauf ceux dont le dernier
 *     pointage est une Sortie ;
 *   - toute personne dont une Entrée attend (≤ 8 h) sans Sortie derrière.
 */
export async function equipePointee(dbx: DbOuTx, restants: Iterable<string>): Promise<Map<string, MembrePointe>> {
  const maintenant = Date.now();
  const attente = await dbx
    .select()
    .from(pointeuseEvenements)
    .where(and(
      eq(pointeuseEvenements.statut, 'EN_ATTENTE'),
      gt(pointeuseEvenements.pointe_le, new Date(maintenant - FRAICHEUR_ATTENTE_MS)),
    ))
    .orderBy(asc(pointeuseEvenements.pointe_le));

  const candidats = new Set<string>(restants);
  for (const e of attente) if (e.utilisateur_id) candidats.add(e.utilisateur_id);
  if (candidats.size === 0) return new Map();

  const recents = await dbx
    .select()
    .from(pointeuseEvenements)
    .where(and(
      inArray(pointeuseEvenements.utilisateur_id, [...candidats]),
      gt(pointeuseEvenements.pointe_le, new Date(maintenant - FENETRE_OUVERTURE_MS)),
    ))
    .orderBy(asc(pointeuseEvenements.pointe_le));

  const equipe = new Map<string, MembrePointe>();
  for (const id of candidats) {
    const siens = recents.filter((e) => e.utilisateur_id === id);
    const dernier = siens.at(-1);
    if (dernier?.sens === 'SORTIE') continue;
    // Arrivée = première Entrée en attente après la dernière Sortie.
    const derniereSortie = siens.filter((e) => e.sens === 'SORTIE').at(-1)?.pointe_le.getTime() ?? 0;
    const entrees = attente.filter((e) => e.utilisateur_id === id && e.pointe_le.getTime() > derniereSortie);
    equipe.set(id, {
      pointe_le: entrees[0]?.pointe_le ?? null,
      evenements: entrees.map((e) => e.id),
    });
  }
  return equipe;
}

/**
 * Filet : une Entrée lue PENDANT l'ouverture d'un shift (transaction pas
 * encore validée) a été mise en attente alors qu'un shift existe désormais.
 * Rejouée ici, elle trouve ce shift.
 */
export async function reprendreAttente(tx: DbOuTx): Promise<number> {
  const [ouvert] = await tx.select({ id: servicesCaisse.id }).from(servicesCaisse).where(eq(servicesCaisse.statut, 'OUVERT'));
  if (!ouvert) return 0;
  const enAttente = await tx
    .select()
    .from(pointeuseEvenements)
    .where(eq(pointeuseEvenements.statut, 'EN_ATTENTE'))
    .orderBy(asc(pointeuseEvenements.pointe_le));
  for (const ev of enAttente) {
    await tx.delete(pointeuseEvenements).where(eq(pointeuseEvenements.id, ev.id));
    await appliquerEvenement(tx, ev.appareil, {
      numero: ev.numero,
      employe_no: ev.employe_no,
      nom: ev.nom_appareil,
      sens: ev.sens as 'ENTREE' | 'SORTIE',
      pointe_le: ev.pointe_le,
    });
  }
  return enAttente.length;
}

/** À l'ouverture : les Entrées reprises passent APPLIQUE, les autres en attente sont écartées. */
export async function solderAttente(tx: DbOuTx, serviceId: string, repris: string[]): Promise<void> {
  if (repris.length > 0) {
    await tx
      .update(pointeuseEvenements)
      .set({ statut: 'APPLIQUE', service_id: serviceId })
      .where(inArray(pointeuseEvenements.id, repris));
  }
  await tx
    .update(pointeuseEvenements)
    .set({ statut: 'IGNORE' })
    .where(eq(pointeuseEvenements.statut, 'EN_ATTENTE'));
}
