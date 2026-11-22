// Planche vinyle en PDF (brief PROMO § 7.5) : une page = une feuille, 1:1.
//
// Pour n'importe quel imprimeur, sans repère propre à une marque de traceur :
//   * impression en CMJN, polices incorporées, QR vectoriel (aucune image) ;
//   * fond perdu de 2 mm, textes et QR à 3 mm au moins du trait de coupe ;
//   * trait de coupe dans la couleur d'accompagnement « CutContour », en
//     surimpression, sur un calque « CutContour » : le RIP l'envoie au
//     traceur, il ne s'imprime pas.
// Mesures de l'autocollant reprises de la maquette validée (6 px = 1 mm).
import fontkit from '@pdf-lib/fontkit';
import qrcode from 'qrcode-generator';
import {
  appendBezierCurve,
  closePath,
  cmyk,
  lineTo,
  moveTo,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames as Ops,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSpacing,
  setLineWidth,
  stroke,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import {
  COULEURS,
  GRIS_DOUX,
  GRIS_FILET,
  GRIS_TEXTE,
  ligneAdresse,
  marqueEtSite,
  NOIR,
  textes,
  urlActivation,
  type Cmjn,
  type Marque,
} from './contenu';
import { grille, parFeuille, position, type Reglages } from './reglages';

/** Les fichiers de police, déjà chargés (voir polices.ts). */
export interface Polices {
  archivo: Uint8Array;
  inter500: Uint8Array;
  inter600: Uint8Array;
  inter700: Uint8Array;
  inter800: Uint8Array;
  kaushan: Uint8Array;
  mono: Uint8Array;
}

export interface DonneesPlanche {
  codes: string[];
  pourcentage: number;
  valideDu: string;
  valideAu: string;
  restaurant: { nom: string; marque: Marque; telephone: string | null; adresse: string | null };
  libelle: string;
}

const pt = (mm: number) => (mm * 72) / 25.4;
const couleur = (c: Cmjn) => cmyk(c[0], c[1], c[2], c[3]);

// --- Gabarit de l'autocollant 85 × 55 mm (positions relatives au trait de coupe)
const PANNEAU_L = 50;
const PANNEAU_H = 45.333;
const MARGE_G = 3.667;
const SECURITE = 3;
const QR_COTE = 22; // brief : 22 mm au moins
const QR_HAUT = 3;
const BANDEAU_LIGNE_1 = 48.8;
const BANDEAU_LIGNE_2 = 51.4;
const TAILLE_MIN = 2; // ≈ 6 pt

interface PolicesPdf {
  archivo: PDFFont;
  inter500: PDFFont;
  inter600: PDFFont;
  inter700: PDFFont;
  inter800: PDFFont;
  kaushan: PDFFont;
  mono: PDFFont;
}

/** Un dessin en millimètres, origine en haut à gauche de la feuille. */
class Feuille {
  constructor(
    readonly page: PDFPage,
    readonly hauteurMm: number,
  ) {}

  private y(mm: number) {
    return pt(this.hauteurMm - mm);
  }

  rectangle(x: number, y: number, l: number, h: number, c: Cmjn) {
    this.page.drawRectangle({ x: pt(x), y: this.y(y + h), width: pt(l), height: pt(h), color: couleur(c) });
  }

  /**
   * Rectangle arrondi plein ou en pointillés, en chemin SVG. Le chemin est mis
   * à l'échelle (1 unité = 1 mm) : épaisseur et tirets se donnent en mm.
   */
  arrondi(x: number, y: number, l: number, h: number, r: number, style: { plein?: Cmjn; trait?: Cmjn; epaisseur?: number; tirets?: number[] }) {
    const chemin = `M${r} 0H${l - r}A${r} ${r} 0 0 1 ${l} ${r}V${h - r}A${r} ${r} 0 0 1 ${l - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
    this.page.drawSvgPath(chemin, {
      x: pt(x),
      y: this.y(y),
      scale: pt(1),
      color: style.plein ? couleur(style.plein) : undefined,
      borderColor: style.trait ? couleur(style.trait) : undefined,
      borderWidth: style.trait ? (style.epaisseur ?? 0.2) : undefined,
      borderDashArray: style.tirets,
    });
  }

  ligne(x1: number, x2: number, y: number, epaisseur: number, c: Cmjn) {
    this.page.drawLine({ start: { x: pt(x1), y: this.y(y) }, end: { x: pt(x2), y: this.y(y) }, thickness: pt(epaisseur), color: couleur(c) });
  }

  /** Largeur d'un texte, en mm, espacement des lettres compris (en em). */
  static largeur(police: PDFFont, texte: string, taille: number, espacement = 0) {
    return (police.widthOfTextAtSize(texte, pt(taille)) + pt(espacement * taille) * texte.length) / pt(1);
  }

  /** Texte posé sur sa ligne de base. `x` = bord gauche, ou centre si `centre`. */
  texte(texte: string, o: { x: number; base: number; taille: number; police: PDFFont; c: Cmjn; espacement?: number; centre?: boolean }) {
    const largeur = Feuille.largeur(o.police, texte, o.taille, o.espacement);
    const x = o.centre ? o.x - largeur / 2 : o.x;
    if (o.espacement) this.page.pushOperators(setCharacterSpacing(pt(o.espacement * o.taille)));
    this.page.drawText(texte, { x: pt(x), y: this.y(o.base), size: pt(o.taille), font: o.police, color: couleur(o.c) });
    if (o.espacement) this.page.pushOperators(setCharacterSpacing(0));
  }

  /** QR en carrés vectoriels, une ligne de modules contigus = un rectangle. */
  qr(contenu: string, x: number, y: number, cote: number) {
    const q = qrcode(0, 'M');
    q.addData(contenu);
    q.make();
    const n = q.getModuleCount();
    let chemin = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; ) {
        if (!q.isDark(r, c)) {
          c++;
          continue;
        }
        let fin = c;
        while (fin < n && q.isDark(r, fin)) fin++;
        chemin += `M${c} ${r}H${fin}V${r + 1}H${c}Z`;
        c = fin;
      }
    }
    this.page.drawSvgPath(chemin, { x: pt(x), y: this.y(y), scale: pt(cote / n), color: couleur(NOIR) });
  }
}

/** Plus grande taille (≤ voulue, ≥ minimum) à laquelle le texte tient. */
function ajuster(police: PDFFont, texte: string, voulue: number, largeurMax: number, espacement = 0) {
  const l = Feuille.largeur(police, texte, voulue, espacement);
  return l <= largeurMax ? voulue : Math.max(TAILLE_MIN, (voulue * largeurMax) / l);
}

function dessinerAutocollant(f: Feuille, ox: number, oy: number, code: string, d: DonneesPlanche, p: PolicesPdf, r: Reglages, ligne1: string) {
  const marque = COULEURS[d.restaurant.marque];
  const t = textes(d.pourcentage, d.valideDu, d.valideAu);
  const { marque: nomMarque, site } = marqueEtSite(d.restaurant.nom, d.restaurant.marque);
  const fp = r.fondPerdu;

  // Panneau de marque, prolongé dans le fond perdu (haut et gauche).
  f.rectangle(ox - fp, oy - fp, PANNEAU_L + fp, PANNEAU_H + fp, marque.fond);

  // Pastille « NE ME JETTE PAS ! »
  const tPastille = 2.167;
  const lPastille = Feuille.largeur(p.archivo, t.accroche, tPastille, 0.04) + 2 * 1.833;
  const hPastille = 4.16;
  f.arrondi(ox + MARGE_G, oy + 3.333, lPastille, hPastille, hPastille / 2, { plein: marque.encre });
  f.texte(t.accroche, { x: ox + MARGE_G + 1.833, base: oy + 6.19, taille: tPastille, police: p.archivo, c: marque.fond, espacement: 0.04 });

  // −20 %
  const largeurPanneau = PANNEAU_L - MARGE_G - 2.333;
  const tRemise = ajuster(p.archivo, t.remise, 13.333, largeurPanneau, -0.04);
  f.texte(t.remise, { x: ox + MARGE_G, base: oy + 20.6, taille: tRemise, police: p.archivo, c: marque.encre, espacement: -0.04 });
  f.texte(t.sousTitre[0]!, { x: ox + MARGE_G, base: oy + 25.97, taille: 3, police: p.inter800, c: marque.encre });
  f.texte(t.sousTitre[1]!, { x: ox + MARGE_G, base: oy + 29.42, taille: 3, police: p.inter800, c: marque.encre });

  // Marque et site, en bas du panneau.
  const tMarque = 4.5;
  const lMarque = Feuille.largeur(p.kaushan, nomMarque, tMarque);
  f.texte(nomMarque, { x: ox + MARGE_G, base: oy + 41.56, taille: tMarque, police: p.kaushan, c: marque.encre });
  if (site) {
    const tSite = ajuster(p.inter700, site, 2.167, largeurPanneau - lMarque - 1.333);
    f.texte(site, { x: ox + MARGE_G + lMarque + 1.333, base: oy + 41.56, taille: tSite, police: p.inter700, c: marque.encre });
  }

  // Colonne de droite : QR, appel, code en clair.
  const centre = ox + PANNEAU_L + 2.333 + (r.autocollantL - SECURITE - PANNEAU_L - 2.333) / 2;
  f.qr(urlActivation(code), centre - QR_COTE / 2, oy + QR_HAUT, QR_COTE);
  f.texte(t.appel, { x: centre, base: oy + 29.6, taille: 2.667, police: p.inter800, c: NOIR, centre: true });
  f.texte(t.sousAppel[0]!, { x: centre, base: oy + 32.3, taille: TAILLE_MIN, police: p.inter600, c: GRIS_DOUX, centre: true });
  f.texte(t.sousAppel[1]!, { x: centre, base: oy + 34.7, taille: TAILLE_MIN, police: p.inter600, c: GRIS_DOUX, centre: true });

  const tCode = 3.5;
  const lCode = Feuille.largeur(p.mono, code, tCode, 0.06) + 3;
  const hCode = 5.4;
  f.arrondi(centre - lCode / 2, oy + PANNEAU_H - 1.667 - hCode, lCode, hCode, 1.333, { trait: NOIR, epaisseur: 0.333, tirets: [1, 0.6] });
  f.texte(code, { x: centre, base: oy + PANNEAU_H - 1.667 - hCode / 2 + 1.26, taille: tCode, police: p.mono, c: NOIR, espacement: 0.06, centre: true });

  // Bandeau du bas.
  f.ligne(ox, ox + r.autocollantL, oy + PANNEAU_H, 0.167, GRIS_FILET);
  f.texte(ligne1, { x: ox + MARGE_G, base: oy + BANDEAU_LIGNE_1, taille: TAILLE_MIN, police: p.inter700, c: GRIS_TEXTE });
  f.texte(t.conditions, { x: ox + MARGE_G, base: oy + BANDEAU_LIGNE_2, taille: TAILLE_MIN, police: p.inter500, c: GRIS_TEXTE });
}

/** Traits de coupe d'une feuille : couleur CutContour, surimpression, calque à part. */
function tracerCoupes(f: Feuille, r: Reglages, nombre: number) {
  const { grille: g } = grille(r);
  const k = 0.5523 * r.rayon;
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    PDFOperator.of(Ops.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of('Coupe')]),
    PDFOperator.of(Ops.SetGraphicsStateParams, [PDFName.of('Surimpression')]),
    PDFOperator.of(Ops.StrokingColorspace, [PDFName.of('CutContour')]),
    PDFOperator.of(Ops.StrokingColorN, [PDFNumber.of(1)]),
    setLineWidth(0.25),
  ];
  const X = (mm: number) => pt(mm);
  const Y = (mm: number) => pt(f.hauteurMm - mm);
  for (let i = 0; i < nombre; i++) {
    const { x, y } = position(r, g, i);
    const l = r.autocollantL;
    const h = r.autocollantH;
    const ry = r.rayon;
    ops.push(
      moveTo(X(x + ry), Y(y)),
      lineTo(X(x + l - ry), Y(y)),
      appendBezierCurve(X(x + l - ry + k), Y(y), X(x + l), Y(y + ry - k), X(x + l), Y(y + ry)),
      lineTo(X(x + l), Y(y + h - ry)),
      appendBezierCurve(X(x + l), Y(y + h - ry + k), X(x + l - ry + k), Y(y + h), X(x + l - ry), Y(y + h)),
      lineTo(X(x + ry), Y(y + h)),
      appendBezierCurve(X(x + ry - k), Y(y + h), X(x), Y(y + h - ry + k), X(x), Y(y + h - ry)),
      lineTo(X(x), Y(y + ry)),
      appendBezierCurve(X(x), Y(y + ry - k), X(x + ry - k), Y(y), X(x + ry), Y(y)),
      closePath(),
      stroke(),
    );
  }
  ops.push(PDFOperator.of(Ops.EndMarkedContent), popGraphicsState());
  f.page.pushOperators(...ops);
}

function ressource(page: PDFPage, doc: PDFDocument, categorie: string, nom: string, ref: PDFRef) {
  const ressources = page.node.normalizedEntries().Resources;
  let dict = ressources.lookupMaybe(PDFName.of(categorie), PDFDict);
  if (!dict) {
    dict = doc.context.obj({});
    ressources.set(PDFName.of(categorie), dict);
  }
  dict.set(PDFName.of(nom), ref);
}

export interface Planche {
  pdf: Uint8Array;
  feuilles: number;
  /** La ligne d'adresse imprimée ; raccourcie si elle ne tenait pas à 2 mm. */
  ligneAdresse: string;
  adresseRaccourcie: boolean;
}

export async function genererPlanche(d: DonneesPlanche, r: Reglages, polices: Polices): Promise<Planche> {
  const { grille: g, erreurs } = grille(r);
  if (erreurs.length) throw new Error(erreurs.join(' ; '));

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`${d.libelle} — impression et découpe`);
  doc.setCreator('Console du siège — codes promo cartes');
  doc.setProducer('pdf-lib');

  const p: PolicesPdf = {
    archivo: await doc.embedFont(polices.archivo, { subset: true }),
    inter500: await doc.embedFont(polices.inter500, { subset: true }),
    inter600: await doc.embedFont(polices.inter600, { subset: true }),
    inter700: await doc.embedFont(polices.inter700, { subset: true }),
    inter800: await doc.embedFont(polices.inter800, { subset: true }),
    kaushan: await doc.embedFont(polices.kaushan, { subset: true }),
    mono: await doc.embedFont(polices.mono, { subset: true }),
  };

  // CutContour : couleur d'accompagnement (magenta à l'écran), calque à part, surimpression.
  const ctx = doc.context;
  const teinte = ctx.register(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 1, 0, 0], N: 1 }));
  const cutContour = ctx.register(ctx.obj([PDFName.of('Separation'), PDFName.of('CutContour'), PDFName.of('DeviceCMYK'), teinte]));
  const surimpression = ctx.register(ctx.obj({ Type: 'ExtGState', OP: true, op: true, OPM: 1 }));
  const calque = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('CutContour') }));
  doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [calque], D: { Name: PDFString.of('Calques'), Order: [calque], ON: [calque] } }));

  const largeurBandeau = r.autocollantL - MARGE_G - SECURITE - 0.333;
  const { texte: ligne1, raccourcie } = ligneAdresse(
    d.restaurant.adresse,
    d.restaurant.telephone,
    (texte) => Feuille.largeur(p.inter700, texte, TAILLE_MIN),
    largeurBandeau,
  );

  const feuilles = parFeuille(d.codes, g);
  for (const codes of feuilles) {
    const page = doc.addPage([pt(r.feuilleL), pt(r.feuilleH)]);
    page.node.set(PDFName.of('TrimBox'), ctx.obj([0, 0, pt(r.feuilleL), pt(r.feuilleH)]));
    ressource(page, doc, 'ColorSpace', 'CutContour', cutContour);
    ressource(page, doc, 'ExtGState', 'Surimpression', surimpression);
    ressource(page, doc, 'Properties', 'Coupe', calque);
    const f = new Feuille(page, r.feuilleH);
    codes.forEach((code, i) => {
      const { x, y } = position(r, g, i);
      dessinerAutocollant(f, x, y, code, d, p, r, ligne1);
    });
    tracerCoupes(f, r, codes.length);
  }

  return { pdf: await doc.save({ useObjectStreams: false }), feuilles: feuilles.length, ligneAdresse: ligne1, adresseRaccourcie: raccourcie };
}
