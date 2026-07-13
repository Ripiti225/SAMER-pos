/**
 * Synchronisation automatique de l'équipe depuis SamerTrackly (RH → POS).
 *
 * Le serveur local « tire » périodiquement (et à la demande) la liste des
 * travailleurs du restaurant depuis Supabase, et crée / met à jour les comptes
 * du POS. Rapprochement par `externe_id` (= id SamerTrackly) pour éviter tout
 * doublon ; à défaut, adoption d'un compte existant du même nom.
 *
 * Ce qui vient de SamerTrackly : nom, poste, photo, téléphone, rôle (déduit du
 * poste), actif. Ce qui reste PROPRE au POS et n'est jamais écrasé : le PIN
 * (onboarding par code temporaire) et la disponibilité (malade / congé…).
 */
import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { parametresLocaux, roles, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { journaliser } from '../audit/audit.js';
import { genererCodeTemporaire, hacher, hachInutilisable } from './service.js';

interface TravailleurST {
  id: string;
  nom: string | null;
  poste: string | null;
  photo_url: string | null;
  contact: string | null;
  actif: boolean | null;
}

type RolePos = 'MANAGER' | 'CAISSIER' | 'SERVEUR' | 'CUISINE';
type PosteCuisine = 'CUISINIER' | 'PIZZAIOLO' | null;
type Disponibilite = 'PRESENT' | 'MALADE' | 'CONGE' | 'PERMISSION';

const CODE_VALIDE_JOURS = 30;

/** Type d'absence SamerTrackly → disponibilité POS. */
function mapTypeConge(type: string | null): Disponibilite {
  const t = (type ?? '').toLowerCase();
  if (/malad|maladie|repos.?med/.test(t)) return 'MALADE';
  if (/permission/.test(t)) return 'PERMISSION';
  return 'CONGE'; // congé (défaut pour toute absence planifiée)
}

/** Déduit le rôle POS + poste cuisine à partir de l'intitulé RH SamerTrackly. */
export function mapPosteRole(poste: string | null): { role: RolePos; posteCuisine: PosteCuisine } {
  const p = (poste ?? '').toLowerCase();
  if (/pizza/.test(p)) return { role: 'CUISINE', posteCuisine: 'PIZZAIOLO' };
  if (/cuisin|plong|aide|chef.?cuis/.test(p)) return { role: 'CUISINE', posteCuisine: 'CUISINIER' };
  if (/serveu/.test(p)) return { role: 'SERVEUR', posteCuisine: null };
  if (/caiss|comptoir/.test(p)) return { role: 'CAISSIER', posteCuisine: null };
  if (/g[ée]rant|manager|responsable/.test(p)) return { role: 'MANAGER', posteCuisine: null };
  // Technicien de surface, ménagère, autres postes non-caisse : back-office.
  return { role: 'CUISINE', posteCuisine: null };
}

/** true si les identifiants SamerTrackly sont configurés (clé + URL). */
export function samtracklyConfigure(): boolean {
  return !!(process.env.SAMTRACKLY_URL && process.env.SAMTRACKLY_KEY);
}

/** Postes distincts existant dans SamerTrackly (tout le groupe). [] si hors ligne. */
export async function postesSamtrackly(): Promise<string[]> {
  const url = process.env.SAMTRACKLY_URL;
  const key = process.env.SAMTRACKLY_KEY;
  if (!url || !key) return [];
  const rep = await fetch(`${url}/rest/v1/travailleurs?select=poste&archived_at=is.null`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  }).catch(() => null);
  if (!rep?.ok) return [];
  const rows = (await rep.json()) as { poste: string | null }[];
  const set = new Set<string>();
  for (const r of rows) {
    const p = (r.poste ?? '').trim();
    if (p) set.add(p);
  }
  return [...set];
}

export interface ResultatSync {
  saute?: boolean;
  raison?: string;
  crees: number;
  maj: number;
  desactives: number;
  absents: number;
  total: number;
}

async function restaurantConfigure(): Promise<string> {
  const [p] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, 'samtrackly_restaurant_id'));
  return typeof p?.valeur === 'string' ? p.valeur : '';
}

/**
 * Lance une synchronisation. `userId` = auteur (pour l'audit), null si automatique.
 * Best-effort : lève une ErreurMetier en cas de config manquante / réponse KO.
 */
export async function synchroniserEquipe(userId: string | null): Promise<ResultatSync> {
  const url = process.env.SAMTRACKLY_URL;
  const key = process.env.SAMTRACKLY_KEY;
  const restaurantId = await restaurantConfigure();
  const vide: ResultatSync = { crees: 0, maj: 0, desactives: 0, absents: 0, total: 0 };
  if (!url || !key) return { ...vide, saute: true, raison: 'Clé SamerTrackly non configurée (apps/server/.env)' };
  if (!restaurantId) return { ...vide, saute: true, raison: 'Restaurant SamerTrackly non défini (paramètre samtrackly_restaurant_id)' };

  const entetes = { apikey: key, Authorization: `Bearer ${key}` };
  const requete =
    `travailleurs?restaurant_id=eq.${restaurantId}&archived_at=is.null` +
    `&select=id,nom,poste,photo_url,contact,actif`;
  const rep = await fetch(`${url}/rest/v1/${requete}`, { headers: entetes }).catch(() => null);
  if (!rep) throw new ErreurMetier('SamerTrackly injoignable (pas d’internet ?)', 503);
  if (!rep.ok) throw new ErreurMetier(`SamerTrackly a répondu ${rep.status}`, 502);
  const liste = (await rep.json()) as TravailleurST[];

  const rows = await db.select({ id: roles.id, nom: roles.nom }).from(roles);
  const roleId = new Map(rows.map((r) => [r.nom, r.id]));

  let crees = 0;
  let maj = 0;
  let desactives = 0;
  const vus: string[] = [];

  for (const t of liste) {
    const nom = (t.nom ?? '').trim();
    if (!nom) continue;
    vus.push(t.id);
    const { role, posteCuisine } = mapPosteRole(t.poste);
    const rid = roleId.get(role) ?? null;
    const champs = {
      nom_complet: nom,
      poste: t.poste?.trim() || null,
      photo_url: t.photo_url || null,
      telephone: t.contact || null,
      role_id: rid,
      role,
      poste_cuisine: posteCuisine,
      actif: t.actif ?? true,
      externe_id: t.id,
      updated_at: new Date(),
    };

    // Rapprochement : par externe_id, sinon par nom exact d'un compte non lié.
    const [parId] = await db.select().from(utilisateurs).where(eq(utilisateurs.externe_id, t.id));
    const existant =
      parId ??
      (await db
        .select()
        .from(utilisateurs)
        .where(and(sql`lower(${utilisateurs.nom_complet}) = ${nom.toLowerCase()}`, sql`${utilisateurs.externe_id} IS NULL`))
        .limit(1))[0];

    if (existant) {
      await db.transaction(async (tx) => {
        // On NE touche PAS : pin_hash, doit_definir_pin, disponibilite.
        const [u] = await tx.update(utilisateurs).set(champs).where(eq(utilisateurs.id, existant.id)).returning();
        await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', existant.id, u as unknown as Record<string, unknown>);
      });
      maj++;
    } else {
      const code = genererCodeTemporaire();
      await db.transaction(async (tx) => {
        const [u] = await tx
          .insert(utilisateurs)
          .values({
            ...champs,
            pin_hash: await hachInutilisable(),
            doit_definir_pin: true,
            pin_temporaire_hash: await hacher(code),
            pin_temporaire_expire: new Date(Date.now() + CODE_VALIDE_JOURS * 864e5),
          })
          .returning();
        await ecrireOutbox(tx, 'utilisateurs', 'INSERT', u!.id, u as unknown as Record<string, unknown>);
        await journaliser(tx, {
          user_id: userId,
          action: 'CREATION_EMPLOYE',
          entite: 'utilisateurs',
          entite_id: u!.id,
          meta: { source: 'samtrackly', nom_complet: nom, poste: t.poste },
        });
      });
      crees++;
    }
  }

  // Départs : comptes liés à SamerTrackly disparus de la liste → désactivés.
  if (vus.length > 0) {
    const orphelins = await db
      .select({ id: utilisateurs.id, nom: utilisateurs.nom_complet })
      .from(utilisateurs)
      .where(and(isNotNull(utilisateurs.externe_id), eq(utilisateurs.actif, true), notInArray(utilisateurs.externe_id, vus)));
    for (const o of orphelins) {
      await db.transaction(async (tx) => {
        const [u] = await tx
          .update(utilisateurs)
          .set({ actif: false, updated_at: new Date() })
          .where(eq(utilisateurs.id, o.id))
          .returning();
        await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', o.id, u as unknown as Record<string, unknown>);
        await journaliser(tx, {
          user_id: userId,
          action: 'DESACTIVATION_EMPLOYE',
          entite: 'utilisateurs',
          entite_id: o.id,
          meta: { source: 'samtrackly', nom_complet: o.nom },
        });
      });
      desactives++;
    }
  }

  // --- Congés / permissions : SamerTrackly pilote la disponibilité PLANIFIÉE.
  // Un « Malade » posé à la main dans le POS n'est PAS écrasé (ad hoc local).
  let absents = 0;
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const reqConges =
    `permissions_conges?restaurant_id=eq.${restaurantId}` +
    `&date_debut=lte.${aujourdhui}&date_fin=gte.${aujourdhui}&select=travailleur_id,type`;
  const repC = await fetch(`${url}/rest/v1/${reqConges}`, { headers: entetes }).catch(() => null);
  if (repC?.ok) {
    const absences = (await repC.json()) as { travailleur_id: string; type: string | null }[];
    const dispoParExterne = new Map<string, Disponibilite>();
    for (const a of absences) dispoParExterne.set(a.travailleur_id, mapTypeConge(a.type));

    const lies = await db
      .select({ id: utilisateurs.id, externe_id: utilisateurs.externe_id, disponibilite: utilisateurs.disponibilite })
      .from(utilisateurs)
      .where(isNotNull(utilisateurs.externe_id));
    for (const e of lies) {
      const cible = e.externe_id ? dispoParExterne.get(e.externe_id) : undefined;
      let nouvelle: Disponibilite | null = null;
      if (cible) {
        if (e.disponibilite !== cible) nouvelle = cible;
      } else if (e.disponibilite === 'CONGE' || e.disponibilite === 'PERMISSION') {
        // Congé/permission terminé côté RH → retour PRESENT (MALADE manuel gardé).
        nouvelle = 'PRESENT';
      }
      if (cible) absents++;
      if (nouvelle) {
        await db.transaction(async (tx) => {
          const [u] = await tx.update(utilisateurs).set({ disponibilite: nouvelle!, updated_at: new Date() }).where(eq(utilisateurs.id, e.id)).returning();
          await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', e.id, u as unknown as Record<string, unknown>);
        });
      }
    }
  }

  return { crees, maj, desactives, absents, total: liste.length };
}
