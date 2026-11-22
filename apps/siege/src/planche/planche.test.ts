import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { ligneAdresse, marqueEtSite, telephoneImprime, textes, urlActivation, validite } from './contenu';
import { genererPlanche, type Polices } from './pdf';
import { grille, parFeuille, position, REGLAGES_PAR_DEFAUT } from './reglages';
import { svgDecoupe } from './svg';

describe('mise en page de la feuille', () => {
  it('feuille 1 m², autocollant 85 × 55 : 10 × 16 = 160 par feuille', () => {
    const { grille: g, erreurs } = grille(REGLAGES_PAR_DEFAUT);
    expect(erreurs).toEqual([]);
    expect(g).toEqual({ colonnes: 10, rangees: 16, parFeuille: 160 });
  });

  it('tout tient dans la marge de 20 mm, fond perdu compris', () => {
    const r = REGLAGES_PAR_DEFAUT;
    const { grille: g } = grille(r);
    const dernier = position(r, g, g.parFeuille - 1);
    expect(position(r, g, 0)).toEqual({ x: 20, y: 20 });
    expect(position(r, g, 10)).toEqual({ x: 20, y: 79 });
    expect(dernier.x + r.autocollantL + r.fondPerdu).toBeLessThanOrEqual(r.feuilleL - r.marge + r.fondPerdu);
    expect(dernier.y + r.autocollantH + r.fondPerdu).toBeLessThanOrEqual(r.feuilleH - r.marge + r.fondPerdu);
  });

  it('200 codes = 2 feuilles, 160 + 40, sans emplacement vide', () => {
    const { grille: g } = grille(REGLAGES_PAR_DEFAUT);
    const feuilles = parFeuille(Array.from({ length: 200 }, (_, i) => i), g);
    expect(feuilles.map((f) => f.length)).toEqual([160, 40]);
  });

  it('refuse des réglages où les fonds perdus se chevauchent ou rien ne tient', () => {
    expect(grille({ ...REGLAGES_PAR_DEFAUT, ecart: 3 }).erreurs.length).toBeGreaterThan(0);
    expect(grille({ ...REGLAGES_PAR_DEFAUT, feuilleL: 100 }).erreurs.length).toBeGreaterThan(0);
    expect(grille({ ...REGLAGES_PAR_DEFAUT, rayon: 40 }).erreurs.length).toBeGreaterThan(0);
  });
});

describe('texte de l’autocollant', () => {
  it('sépare la marque du site', () => {
    expect(marqueEtSite('Samer Palmeraie', 'SAMER')).toEqual({ marque: 'Chez Samer', site: 'Palmeraie' });
    expect(marqueEtSite('Samer Angré 7E', 'SAMER')).toEqual({ marque: 'Chez Samer', site: 'Angré 7E' });
    expect(marqueEtSite('Al Kayan KMS', 'AL_KAYAN')).toEqual({ marque: 'Al Kayan', site: 'KMS' });
    expect(marqueEtSite('À la Braise', 'A_LA_BRAISE')).toEqual({ marque: 'À la Braise', site: '' });
  });

  it('écrit le téléphone, la période et l’adresse du QR', () => {
    expect(telephoneImprime('+2250777303333')).toBe('07 77 30 33 33');
    expect(validite('2026-11-20T00:00:00.000Z', '2026-12-17T23:59:59.999Z')).toBe('Du 20/11 au 17/12/2026');
    expect(urlActivation('PAM-7K3QX')).toBe('https://samer-delivery-site.vercel.app/fr/promo?c=PAM-7K3QX');
    expect(textes(20, '2026-11-20T00:00:00.000Z', '2026-12-17T23:59:59.999Z').conditions).toBe(
      'Usage unique · Du 20/11 au 17/12/2026 · Hors Chawarma',
    );
  });

  it('raccourcit l’adresse plutôt que la police', () => {
    const largeur = (t: string) => t.length; // 1 mm par caractère
    expect(ligneAdresse('Yopougon Maroc', '+2250758648890', largeur, 80)).toEqual({
      texte: 'Yopougon Maroc · 07 58 64 88 90 · Collez-moi sur le frigo',
      raccourcie: false,
    });
    expect(ligneAdresse('Riviera Palmeraie, après le rond-point de la SODECI', '+2250777303333', largeur, 70).texte).toBe(
      'Riviera Palmeraie · 07 77 30 33 33 · Collez-moi sur le frigo',
    );
    const coupee = ligneAdresse('Riviera Palmeraie très très longue sans virgule', '+2250777303333', largeur, 60);
    expect(coupee.raccourcie).toBe(true);
    expect(coupee.texte.length).toBeLessThanOrEqual(60);
    expect(coupee.texte).toContain('…');
  });
});

describe('fichier de découpe seule', () => {
  it('un tracé arrondi par autocollant, aux mêmes positions que le PDF, en millimètres', () => {
    const svg = svgDecoupe(REGLAGES_PAR_DEFAUT, 40);
    expect(svg).toContain('width="1000mm" height="1000mm" viewBox="0 0 1000 1000"');
    expect(svg.match(/<rect /g)?.length).toBe(40);
    expect(svg).toContain('<rect x="20" y="20" width="85" height="55" rx="3" ry="3"/>');
    expect(svg).toContain('<rect x="109" y="20"');
  });
});

describe('planche PDF', () => {
  const require = createRequire(import.meta.url);
  const police = (chemin: string) => new Uint8Array(readFileSync(require.resolve(`@fontsource/${chemin}`)));
  const polices: Polices = {
    archivo: police('archivo-black/files/archivo-black-latin-400-normal.woff'),
    inter500: police('inter/files/inter-latin-500-normal.woff'),
    inter600: police('inter/files/inter-latin-600-normal.woff'),
    inter700: police('inter/files/inter-latin-700-normal.woff'),
    inter800: police('inter/files/inter-latin-800-normal.woff'),
    kaushan: police('kaushan-script/files/kaushan-script-latin-400-normal.woff'),
    mono: police('jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff'),
  };
  const donnees = (n: number) => ({
    codes: Array.from({ length: n }, (_, i) => `PAM-${String(i).padStart(5, 'A').replace(/[01]/g, 'K')}`),
    pourcentage: 20,
    valideDu: '2026-11-20T00:00:00.000Z',
    valideAu: '2026-12-17T23:59:59.999Z',
    restaurant: { nom: 'Samer Palmeraie', marque: 'SAMER' as const, telephone: '+2250777303333', adresse: 'Riviera Palmeraie, après le rond-point de la SODECI' },
    libelle: 'Essai',
  });

  it('200 codes : 2 pages de 1 m² à l’échelle 1:1, avec le calque et la couleur CutContour', async () => {
    const planche = await genererPlanche(donnees(200), REGLAGES_PAR_DEFAUT, polices);
    expect(planche.feuilles).toBe(2);
    expect(planche.adresseRaccourcie).toBe(true);
    const doc = await PDFDocument.load(planche.pdf);
    expect(doc.getPageCount()).toBe(2);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round((width * 25.4) / 72)).toBe(1000);
    expect(Math.round((height * 25.4) / 72)).toBe(1000);
    const brut = new TextDecoder('latin1').decode(planche.pdf);
    expect(brut).toContain('/Separation /CutContour /DeviceCMYK');
    expect(brut).toContain('/OCProperties');
    expect(brut).toMatch(/\/FontFile2|\/FontFile3/);
  }, 60_000);
});
