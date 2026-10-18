import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandeItemVue, CommandeVue, PosteImpression } from '@pos/shared';
import { EscposPrinter } from '../src/printer/escpos.js';
import { MODES_SONNERIE, modeSonnerieEnregistre, type ModeSonnerie } from '@pos/shared';
import { commandeSonnerie } from '../src/printer/sonnerie.js';

// Capturer le travail RAW sans accéder à la base ni à une vraie imprimante.
type ConstructionImpression = {
  infosResto(): Promise<{
    nom: string; entete: string; pied: string; marque: 'SAMER'; logo: 'aucun'; colonnes: number;
    sonneries: Record<PosteImpression, ModeSonnerie>;
  }>;
  envoyer(construire: () => Buffer, repli: () => Promise<void>, poste?: PosteImpression): Promise<void>;
};

afterEach(() => vi.restoreAllMocks());

describe('Signal sonore des bons cuisine', () => {
  it.each(['CUISINE', 'CAISSE', 'BAR'] as const)('bon %s : son uniquement en cuisine, après la coupe', async (poste) => {
    const imprimante = new EscposPrinter();
    const construction = imprimante as unknown as ConstructionImpression;
    vi.spyOn(construction, 'infosResto').mockResolvedValue({
      nom: 'Restaurant test', entete: '', pied: '', marque: 'SAMER', logo: 'aucun', colonnes: 48,
      sonneries: { CUISINE: 'esc_b', CAISSE: 'aucun', BAR: 'aucun' },
    });
    const travaux: Buffer[] = [];
    const envoyer = vi.spyOn(construction, 'envoyer').mockImplementation(async (construire) => {
      travaux.push(construire());
    });
    const item = {
      quantite: 2, nom_snapshot: 'Poulet', statut_cuisine: 'A_PREPARER', supplements: [], options: [],
    } as unknown as CommandeItemVue;
    const commande = {
      numero_ticket: 42, code_commande: 'A42', type: 'SUR_PLACE', table_numero: '3', partenaire: null,
    } as unknown as CommandeVue;

    await imprimante.imprimerBon(commande, poste, [item]);

    expect(envoyer).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), poste);
    expect(travaux).toHaveLength(1);
    const flux = travaux[0]!;
    expect(flux.toString('latin1')).toContain('2 x Poulet');
    const coupe = Buffer.from([0x1d, 0x56, 0x00]);
    const son = Buffer.from([0x1b, 0x42, 0x02, 0x03]);
    if (poste === 'CUISINE') {
      expect(flux.subarray(-7)).toEqual(Buffer.concat([coupe, son]));
      expect(flux.indexOf(son)).toBe(flux.lastIndexOf(son));
    } else {
      expect(flux.includes(son)).toBe(false);
      expect(flux.subarray(-3)).toEqual(coupe);
    }
  });
  it.each(MODES_SONNERIE)('utilise le mode enregistré %s pour chaque bon', async (mode) => {
    const imprimante = new EscposPrinter();
    const construction = imprimante as unknown as ConstructionImpression;
    vi.spyOn(construction, 'infosResto').mockResolvedValue({
      nom: 'Test', entete: '', pied: '', marque: 'SAMER', logo: 'aucun', colonnes: 48,
      sonneries: { CUISINE: mode, CAISSE: 'aucun', BAR: 'aucun' },
    });
    let flux: Buffer = Buffer.alloc(0);
    vi.spyOn(construction, 'envoyer').mockImplementation(async (construire) => { flux = construire(); });
    await imprimante.imprimerBon({ numero_ticket: 1, type: 'SUR_PLACE' } as CommandeVue, 'CUISINE', []);
    const fin = Buffer.concat([Buffer.from([0x1d, 0x56, 0]), commandeSonnerie(mode)]);
    expect(flux.subarray(-fin.length)).toEqual(fin);
  });
  it('mémorise par imprimante et respecte la désactivation', () => {
    expect(modeSonnerieEnregistre({ queue: 'Cuisine', mode: 'epson' }, 'Cuisine', 'CUISINE')).toBe('epson');
    expect(modeSonnerieEnregistre({ queue: 'Cuisine', mode: 'epson' }, 'Nouvelle', 'CUISINE')).toBe('aucun');
    expect(modeSonnerieEnregistre({ queue: 'Cuisine', mode: 'aucun' }, 'Cuisine', 'CUISINE')).toBe('aucun');
    expect(modeSonnerieEnregistre({ queue: 'Cuisine', mode: 'invalide' }, 'Cuisine', 'CUISINE')).toBe('aucun');
    expect(modeSonnerieEnregistre(undefined, '', 'CUISINE')).toBe('aucun');
    expect(modeSonnerieEnregistre(undefined, 'Cuisine', 'CUISINE')).toBe('esc_b');
    expect(modeSonnerieEnregistre(undefined, 'Bar', 'BAR')).toBe('aucun');
  });
});
