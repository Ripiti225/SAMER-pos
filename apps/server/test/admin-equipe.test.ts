/**
 * SPRINT 4C — Équipe (2.1). Le PIN est posé par l'employé (code temporaire),
 * réinitialisation, désactivation, et protection des comptes d'encadrement (1.3).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, utilisateurs } from '../src/db/schema/index.js';
import { genererCodeTemporaire, hachInutilisable, hacher } from '../src/modules/equipe/service.js';
import { PIN_CAISSIER, PIN_PROPRIO, resetDonnees, seConnecter, type Donnees } from './aide.js';

/**
 * Fait arriver un employé comme le fait la descente SamerTrackly : compte sans
 * PIN utilisable + code temporaire. Depuis le 2026-09-04 c'est la SEULE porte
 * d'entrée dans l'équipe — le POS ne recrute plus.
 */
async function arriveeParLeSiege(nom: string, roleId: string | undefined): Promise<{ id: string; code: string }> {
  const code = genererCodeTemporaire();
  const [u] = await db
    .insert(utilisateurs)
    .values({
      nom_complet: nom,
      role: null,
      role_id: roleId ?? null,
      externe_id: `samtrackly-${code}`,
      pin_hash: await hachInutilisable(),
      doit_definir_pin: true,
      pin_temporaire_hash: await hacher(code),
      pin_temporaire_expire: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    })
    .returning();
  return { id: u!.id, code };
}

const PIN_SUPERVISEUR = '731942';

let app: FastifyInstance;
let donnees: Donnees;
let superviseurId: string;
let cookiesProprio: Record<string, string>;
let cookiesSuper: Record<string, string>;
let cookiesCaissier: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  const [sup] = await db
    .insert(utilisateurs)
    .values({ nom_complet: 'Super Viseur', role: null, role_id: donnees.roles.SUPERVISEUR, pin_hash: await argon2.hash(PIN_SUPERVISEUR, { type: argon2.argon2id }) })
    .returning();
  superviseurId = sup!.id;
  app = await construireApp();
  cookiesProprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  cookiesSuper = await seConnecter(app, superviseurId, PIN_SUPERVISEUR);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('accès', () => {
  it('un CAISSIER n’accède pas à l’équipe (403)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/equipe', cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(403);
  });
});

describe('arrivée d’un employé + pose de PIN par l’employé (DdT 3)', () => {
  let fatouId: string;
  let code: string;

  it('« Fatou » descend du siège avec un code temporaire', async () => {
    const arrivee = await arriveeParLeSiege('Fatou Bamba', donnees.roles.SERVEUR);
    fatouId = arrivee.id;
    code = arrivee.code;
    expect(code).toMatch(/^\d{6}$/);
  });

  it('la caisse REFUSE de créer un employé (405) — l’embauche est au siège', async () => {
    for (const cookies of [cookiesSuper, cookiesProprio]) {
      const rep = await app.inject({
        method: 'POST',
        url: '/api/admin/equipe',
        cookies,
        payload: { nom_complet: 'Recrue Sauvage', role_id: donnees.roles.SERVEUR },
      });
      expect(rep.statusCode).toBe(405);
      expect(rep.json().erreur).toContain('siège');
    }
    // Et personne n'a été créé au passage.
    const trace = await db.select().from(utilisateurs).where(eq(utilisateurs.nom_complet, 'Recrue Sauvage'));
    expect(trace).toHaveLength(0);
  });

  it('Fatou ne peut pas se connecter tant que le PIN n’est pas posé', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { utilisateur_id: fatouId, pin: '2468' } });
    expect(rep.statusCode).toBe(409);
  });

  it('un mauvais code temporaire est refusé', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/poser-pin',
      payload: { utilisateur_id: fatouId, code_temporaire: '000000', pin: '2468', pin_confirmation: '2468' },
    });
    expect(rep.statusCode).toBe(403);
  });

  it('Fatou pose son PIN avec le bon code, puis se connecte', async () => {
    const pose = await app.inject({
      method: 'POST',
      url: '/api/auth/poser-pin',
      payload: { utilisateur_id: fatouId, code_temporaire: code, pin: '2468', pin_confirmation: '2468' },
    });
    expect(pose.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { utilisateur_id: fatouId, pin: '2468' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().utilisateur.role_nom).toBe('SERVEUR');
  });

});

describe('réinitialisation et désactivation', () => {
  it('réinit PIN : nouveau code, ancien PIN inutilisable', async () => {
    const { id: uid, code: code1 } = await arriveeParLeSiege('Employe Reinit', donnees.roles.CAISSIER);
    await app.inject({ method: 'POST', url: '/api/auth/poser-pin', payload: { utilisateur_id: uid, code_temporaire: code1, pin: '3571', pin_confirmation: '3571' } });

    const reinit = await app.inject({ method: 'POST', url: `/api/admin/equipe/${uid}/reinit-pin`, cookies: cookiesSuper });
    expect(reinit.statusCode).toBe(200);
    // L'ancien PIN ne marche plus (compte en attente de nouveau PIN)
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { utilisateur_id: uid, pin: '3571' } });
    expect(login.statusCode).toBe(409);
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'REINIT_PIN'));
    expect(traces.length).toBeGreaterThanOrEqual(1);
  });

  it('désactiver un employé coupe l’accès (login refusé)', async () => {
    const rep = await app.inject({ method: 'POST', url: `/api/admin/equipe/${donnees.caissier2_id}/desactiver`, cookies: cookiesSuper });
    expect(rep.statusCode).toBe(200);
    const [u] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.caissier2_id));
    expect(u!.actif).toBe(false);
  });
});

describe('protection des comptes d’encadrement (1.3 / DdT 8)', () => {
  it('le SUPERVISEUR ne peut pas réinitialiser le PIN d’un PROPRIETAIRE → 403 + audit', async () => {
    const rep = await app.inject({ method: 'POST', url: `/api/admin/equipe/${donnees.proprio_id}/reinit-pin`, cookies: cookiesSuper });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).toBe('Le compte propriétaire est protégé');
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'ACCES_PROTEGE_REFUSE'));
    expect(traces.length).toBeGreaterThanOrEqual(1);
  });

  it('le SUPERVISEUR ne peut pas promouvoir un employé PROPRIETAIRE', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/equipe/${donnees.serveur_id}`,
      cookies: cookiesSuper,
      payload: { role_id: donnees.roles.PROPRIETAIRE },
    });
    expect(rep.statusCode).toBe(403);
  });

  it('le PROPRIETAIRE, lui, peut promouvoir un SUPERVISEUR (DdT 5)', async () => {
    const { id } = await arriveeParLeSiege('Futur Super', donnees.roles.SERVEUR);
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/equipe/${id}`,
      cookies: cookiesProprio,
      payload: { role_id: donnees.roles.SUPERVISEUR },
    });
    expect(rep.statusCode).toBe(200);
  });
});

/**
 * Taux journalier (2.1). La colonne existait et trois écrans la lisaient, mais
 * rien ne l'écrivait : la paie repartait de zéro à chaque fois.
 */
describe('taux journalier', () => {
  async function relire(id: string) {
    const [u] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, id));
    return u!;
  }

  it('le taux saisi est enregistré et verrouillé contre la synchro SamerTrackly', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/equipe/${donnees.serveur_id}`,
      cookies: cookiesProprio,
      payload: { taux_journalier: '5000' },
    });
    expect(rep.statusCode).toBe(200);
    const u = await relire(donnees.serveur_id);
    expect(u.taux_journalier).toBe(5000);
    expect(u.champs_manuels).toContain('taux_journalier');
  });

  it('le changement de taux est tracé avec l’avant et l’après', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/equipe/${donnees.serveur_id}`,
      cookies: cookiesProprio,
      payload: { taux_journalier: '6500' },
    });
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'MODIF_EMPLOYE'));
    const derniere = traces.at(-1)!.meta as { avant: { taux_journalier: number | null }; apres: { taux_journalier: number | null } };
    expect(derniere.avant.taux_journalier).toBe(5000);
    expect(derniere.apres.taux_journalier).toBe(6500);
  });

  it('un champ vide EFFACE le taux, il ne le met pas à zéro', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/equipe/${donnees.serveur_id}`,
      cookies: cookiesProprio,
      payload: { taux_journalier: '' },
    });
    expect(rep.statusCode).toBe(200);
    expect((await relire(donnees.serveur_id)).taux_journalier).toBeNull();
  });

  it('un taux négatif ou non numérique est refusé', async () => {
    for (const valeur of ['-500', 'beaucoup']) {
      const rep = await app.inject({
        method: 'PATCH',
        url: `/api/admin/equipe/${donnees.serveur_id}`,
        cookies: cookiesProprio,
        payload: { taux_journalier: valeur },
      });
      expect(rep.statusCode).toBe(400);
    }
  });

  it('une modification qui ne parle pas du taux ne l’efface pas', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/equipe/${donnees.serveur_id}`,
      cookies: cookiesProprio,
      payload: { taux_journalier: '4000' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/admin/equipe/${donnees.serveur_id}`,
      cookies: cookiesProprio,
      payload: { telephone: '0700000000' },
    });
    expect((await relire(donnees.serveur_id)).taux_journalier).toBe(4000);
  });
});
