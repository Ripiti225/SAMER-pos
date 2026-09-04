import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, fermerDb } from '../src/db/client.js';
import { logoTicket } from '../src/printer/logo.js';
import { resetDonnees } from './aide.js';

beforeAll(async () => {
  await resetDonnees();
});

describe('marque À la Braise', () => {
  it('est acceptée par la contrainte restaurant', async () => {
    await expect(db.execute(sql`UPDATE restaurant SET marque = 'A_LA_BRAISE'`)).resolves.toBeDefined();
  });

  it.each(['raster', 'bandes'] as const)('possède son logo ticket en mode %s', (mode) => {
    const aLaBraise = logoTicket('A_LA_BRAISE' as never, mode);
    const samer = logoTicket('SAMER', mode);

    expect(aLaBraise).not.toBeNull();
    expect(aLaBraise!.length).toBeGreaterThan(100);
    expect(aLaBraise).not.toEqual(samer);
  });
});

afterAll(async () => {
  await fermerDb();
});
