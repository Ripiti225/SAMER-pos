/**
 * Ordre du siège `REINIT_PIN` : la console remet un employé en « PIN à poser »
 * sans passer par la caisse. Le code arrive haché ; l'employé le tape sur la
 * caisse comme un code d'arrivée, puis pose son nouveau PIN.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, syncOutbox, utilisateurs } from '../src/db/schema/index.js';
import { executerOrdre, type EffetsOrdre } from '../src/modules/sync/ordres.js';
import type { OrdreSiege } from '../src/modules/sync/cloud-client.js';
import { resetDonnees, seConnecter, type Donnees } from './aide.js';

/**
 * Empreinte du code « 042917 » calculée par `hash-wasm` — la bibliothèque de la
 * fonction `siege` (Deno). Elle prouve que le poste lit ce que le siège produit.
 */
const HASH_SIEGE_042917 =
  '$argon2id$v=19$m=19456,t=2,p=1$az4kvwueDTwsvVXGrO2Jsw$N+9l01wmzrxrcNG1Zy+RGhZbOGA6uPejIHpv0Q2+yWM';

const ANCIEN_PIN = '6283';

let app: FastifyInstance;
let donnees: Donnees;
let deconnectes: string[];
let effets: EffetsOrdre;

function ordre(params: Record<string, unknown>, expire = new Date(Date.now() + 3600_000)): OrdreSiege {
  return {
    id: randomUUID(),
    type: 'REINIT_PIN',
    params,
    demandeur: 'SAMER Zreik',
    demandeur_id: null,
    cree_le: new Date().toISOString(),
    expire_le: expire.toISOString(),
  };
}

async function employeLie(externeId: string, roleId: string): Promise<string> {
  const [u] = await db
    .insert(utilisateurs)
    .values({
      nom_complet: `Employé ${externeId}`,
      role: null,
      role_id: roleId,
      externe_id: externeId,
      pin_hash: await argon2.hash(ANCIEN_PIN, { type: argon2.argon2id }),
    })
    .returning();
  return u!.id;
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('ordre REINIT_PIN', () => {
  it('remet le compte en « PIN à poser » avec le code du siège, coupe ses sessions, trace', async () => {
    deconnectes = [];
    effets = { imprimerRapportSequence: async () => {}, diffuser: () => {}, deconnecter: (id) => deconnectes.push(id) };
    const id = await employeLie('st-fatou', donnees.roles.CAISSIER!);
    await seConnecter(app, id, ANCIEN_PIN);

    const o = ordre({ externe_id: 'st-fatou', code_hash: HASH_SIEGE_042917 });
    const acq = await executerOrdre(o, effets);
    expect(acq?.statut).toBe('EXECUTE');
    expect(deconnectes).toEqual([id]);

    // L'ancien PIN ne passe plus : le compte attend son nouveau PIN.
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { utilisateur_id: id, pin: ANCIEN_PIN } });
    expect(login.statusCode).toBe(409);

    // Le code donné par le siège permet de poser le nouveau PIN.
    const pose = await app.inject({
      method: 'POST',
      url: '/api/auth/poser-pin',
      payload: { utilisateur_id: id, code_temporaire: '042917', pin: '5813', pin_confirmation: '5813' },
    });
    expect(pose.statusCode).toBe(200);

    const [trace] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'REINIT_PIN'), eq(auditLog.entite_id, id)));
    expect(trace!.meta).toMatchObject({ origine: 'SIEGE', demandeur: 'SAMER Zreik' });
    const outbox = await db.select().from(syncOutbox).where(eq(syncOutbox.record_id, id));
    expect(outbox.length).toBeGreaterThan(0);

    // Rejoué (redémarrage avant l'acquittement) : rien n'est refait.
    expect(await executerOrdre(o, effets)).toBeNull();
  });

  it('refuse le compte propriétaire, un employé absent du site, un ordre périmé ou sans code', async () => {
    const proprio = await employeLie('st-patron', donnees.roles.PROPRIETAIRE!);
    const refus = await executerOrdre(ordre({ externe_id: 'st-patron', code_hash: HASH_SIEGE_042917 }), effets);
    expect(refus).toMatchObject({ statut: 'ECHEC' });
    expect(refus?.erreur).toMatch(/propriétaire est protégé/);
    const [p] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, proprio));
    expect(p!.doit_definir_pin).toBe(false);

    const absent = await executerOrdre(ordre({ externe_id: 'st-inconnu', code_hash: HASH_SIEGE_042917 }), effets);
    expect(absent?.erreur).toMatch(/synchronisez l’équipe/);

    const perime = await executerOrdre(
      ordre({ externe_id: 'st-fatou', code_hash: HASH_SIEGE_042917 }, new Date(Date.now() - 1000)),
      effets,
    );
    expect(perime?.erreur).toMatch(/périmé/);

    const sansCode = await executerOrdre(ordre({ externe_id: 'st-fatou', code_hash: '042917' }), effets);
    expect(sansCode?.erreur).toMatch(/incomplet/);
  });
});
