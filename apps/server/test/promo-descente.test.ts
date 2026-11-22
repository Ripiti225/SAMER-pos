/**
 * PROMO-08 — les codes promo cartes descendent sur la caisse, et leur statut
 * n'y recule jamais (brief PROMO § 2, piège de la descente).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, fermerDb, pool } from '../src/db/client.js';
import { promoCategoriesExclues, promoCodes, promoLots } from '../src/db/schema/index.js';
import type { ClientCloud, LigneDescente } from '../src/modules/sync/cloud-client.js';
import { tirerCatalogue } from '../src/modules/sync/descente.js';
import { statutEffectif, type StatutCloud, type StatutLocal } from '../src/modules/promo/statut.js';
import { resetDonnees } from './aide.js';

const RESTO = randomUUID();
const LOT = randomUUID();
const CODE = randomUUID();
const CATEGORIE = randomUUID();

/** Ligne telle que sync-pull la renvoie : `select *` du cloud, restaurant et version compris. */
function code(statut: StatutCloud, version: number): LigneDescente {
  return {
    table_name: 'promo_codes',
    row: {
      restaurant_id: RESTO, id: CODE, lot_id: LOT, code: 'PAM-7K3QX', statut,
      telephone: '+2250777303333', active_le: '2026-11-21T09:00:00Z', consentement_relance: true,
      reserve_le: null, reserve_source: null, reserve_ref: null,
      utilise_le: null, utilise_commande_id: null, utilise_canal: null, version,
    },
  };
}

const lot: LigneDescente = {
  table_name: 'promo_lots',
  row: {
    restaurant_id: RESTO, id: LOT, libelle: 'Autocollants S48', pourcentage: 20,
    valide_du: '2026-11-20T00:00:00Z', valide_au: '2026-12-17T23:59:59.999Z', quantite: 200,
    annule_le: null, cree_par: 'Admin', cree_le: '2026-11-19T10:00:00Z', version: 1,
  },
};

const exclusion: LigneDescente = {
  table_name: 'promo_categories_exclues',
  row: { restaurant_id: RESTO, id: CATEGORIE, exclue: true, modifie_par: 'Admin', modifie_le: '2026-11-19T10:00:00Z', version: 2 },
};

/** Faux cloud : ne renvoie que le flux PROMO_CODES, et note ce qu'on lui a demandé. */
function cloud(lignes: LigneDescente[], version: number) {
  const demandes: Record<string, number>[] = [];
  const client = {
    pull: async (versions: Record<string, number>) => {
      demandes.push(versions);
      return { promo_codes: { lignes, version } };
    },
  } as unknown as ClientCloud;
  return { client, demandes };
}

describe('descente des codes promo cartes', () => {
  beforeEach(async () => {
    await resetDonnees();
  });
  afterAll(async () => {
    await fermerDb();
  });

  it('demande le flux PROMO_CODES et range lots, codes et exclusions', async () => {
    const { client, demandes } = cloud([lot, code('DISPONIBLE', 3), exclusion], 3);
    expect(await tirerCatalogue(client)).toBe(3);
    expect(demandes[0]).toHaveProperty('promo_codes', 0);

    const [l] = await db.select().from(promoLots).where(eq(promoLots.id, LOT));
    expect(l?.pourcentage).toBe(20);
    const [c] = await db.select().from(promoCodes).where(eq(promoCodes.id, CODE));
    expect(c?.statut).toBe('DISPONIBLE');
    expect(c?.telephone).toBe('+2250777303333');
    const [e] = await db.select().from(promoCategoriesExclues).where(eq(promoCategoriesExclues.id, CATEGORIE));
    expect(e?.exclue).toBe(true);

    const { rows } = await pool.query(`SELECT version FROM sync_etat WHERE flux = 'PROMO_CODES'`);
    expect(Number(rows[0]?.version)).toBe(3);
  });

  it('un code encaissé ici hors ligne ne repasse pas disponible à la descente suivante', async () => {
    await tirerCatalogue(cloud([lot, code('DISPONIBLE', 3)], 3).client);
    const commande = randomUUID();
    await db.update(promoCodes)
      .set({ local_statut: 'UTILISE', local_commande_id: commande, local_canal: 'SUR_PLACE', local_le: new Date() })
      .where(eq(promoCodes.id, CODE));

    // Le cloud, qui n'a pas encore reçu l'encaissement, renvoie le code (activé ailleurs, version suivante).
    await tirerCatalogue(cloud([code('DISPONIBLE', 4)], 4).client);
    const [c] = await db.select().from(promoCodes).where(eq(promoCodes.id, CODE));
    expect(c?.local_statut).toBe('UTILISE');
    expect(c?.local_commande_id).toBe(commande);
    expect(statutEffectif(c!.statut as StatutCloud, c!.local_statut as StatutLocal)).toBe('UTILISE');
  });

  it('un lot annulé au siège se voit en caisse', async () => {
    await tirerCatalogue(cloud([lot, code('DISPONIBLE', 3)], 3).client);
    await tirerCatalogue(cloud([{ ...lot, row: { ...lot.row, annule_le: '2026-11-25T10:00:00Z', version: 5 } }, code('ANNULE', 6)], 6).client);
    const [c] = await db.select().from(promoCodes).where(eq(promoCodes.id, CODE));
    expect(statutEffectif(c!.statut as StatutCloud, c!.local_statut as StatutLocal)).toBe('ANNULE');
  });
});

describe('statut qui compte en caisse', () => {
  it('ne recule jamais, et une vente faite reste faite même si le lot est annulé ensuite', () => {
    expect(statutEffectif('DISPONIBLE', null)).toBe('DISPONIBLE');
    expect(statutEffectif('DISPONIBLE', 'RESERVE')).toBe('RESERVE');
    expect(statutEffectif('DISPONIBLE', 'UTILISE')).toBe('UTILISE');
    expect(statutEffectif('RESERVE', null)).toBe('RESERVE');
    expect(statutEffectif('UTILISE', null)).toBe('UTILISE');
    expect(statutEffectif('ANNULE', null)).toBe('ANNULE');
    expect(statutEffectif('ANNULE', 'RESERVE')).toBe('ANNULE');
    expect(statutEffectif('ANNULE', 'UTILISE')).toBe('UTILISE');
  });
});
