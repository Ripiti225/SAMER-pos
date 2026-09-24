import { describe, expect, it, vi } from 'vitest';
import { choisirCleSite, sqlAutorisationSite } from '../src/modules/sync/enrolement.js';

describe('clé de site lors du remplacement d’un mini-PC', () => {
  it('réutilise exactement la clé sauvegardée au lieu d’en créer une nouvelle', () => {
    const generer = vi.fn(() => 'nouvelle-cle-qui-ne-doit-pas-servir');

    const cle = choisirCleSite(undefined, 'ancienne-cle-sauvegardee-123456', generer);

    expect(cle).toBe('ancienne-cle-sauvegardee-123456');
    expect(generer).not.toHaveBeenCalled();
  });

  it('garde la clé locale en priorité quand elle existe déjà', () => {
    const generer = vi.fn(() => 'nouvelle-cle-qui-ne-doit-pas-servir');

    const cle = choisirCleSite('cle-locale-existante-123456', 'cle-env-differente-123456', generer);

    expect(cle).toBe('cle-locale-existante-123456');
    expect(generer).not.toHaveBeenCalled();
  });

  it('en remplacement, met à jour le site existant sans aucun INSERT possible', () => {
    const sql = sqlAutorisationSite({
      mode: 'REMPLACEMENT',
      restaurantId: 'cccccccc-0000-4000-8000-000000000003',
      code: 'CHEZ_SAMER_PALMERAIE',
      hash: 'hash-de-la-cle',
    });

    expect(sql).toContain('UPDATE sites_autorises');
    expect(sql).toContain("WHERE restaurant_id = 'cccccccc-0000-4000-8000-000000000003'");
    expect(sql).not.toContain('INSERT');
    expect(sql).not.toContain('ON CONFLICT');
  });
});
