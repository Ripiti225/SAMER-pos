/**
 * SPRINT 4C — QR de table (2.2). Génération du PNG (librairie `qrcode`) et du
 * PDF prêt à imprimer (pdfkit) : un carré par table, aux couleurs de la marque,
 * « Scannez pour commander et noter », nom de la table, QR.
 */
import { randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

/** Jeton QR opaque et unique posé sur une table. */
export function genererQrToken(): string {
  return `QR-${randomBytes(9).toString('base64url')}`;
}

/** URL encodée dans le QR : page téléphone /t/:qr_token (base configurable). */
export function urlQr(baseClient: string, qrToken: string): string {
  const base = (baseClient ?? '').replace(/\/+$/, '');
  return `${base}/t/${qrToken}`;
}

/** PNG (data URL) d'un QR — pour « Voir le QR » côté écran. */
export function qrDataUrl(contenu: string): Promise<string> {
  return QRCode.toDataURL(contenu, { margin: 1, width: 320 });
}

export interface TableQr {
  numero: string;
  zone: string;
  contenu: string;
}

/**
 * Construit un PDF (une page A4, grille de carrés) avec le QR de chaque table.
 * Renvoie le Buffer complet.
 */
export async function pdfQrTables(
  tables: TableQr[],
  marque: { nom: string; couleur: string },
): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 28 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const fini = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const colonnes = 2;
  const marge = 28;
  const largeur = doc.page.width - marge * 2;
  const carre = largeur / colonnes;
  const hauteurCarre = carre + 24;

  let pos = 0; // position sur la page courante
  for (const t of tables) {
    const col = pos % colonnes;
    const ligne = Math.floor(pos / colonnes);
    let y0 = marge + ligne * hauteurCarre;
    // Nouvelle page si le carré déborde
    if (y0 + hauteurCarre > doc.page.height - marge) {
      doc.addPage();
      pos = 0;
      y0 = marge;
    }
    const x0 = marge + (pos % colonnes) * carre;

    doc.roundedRect(x0 + 6, y0 + 6, carre - 12, hauteurCarre - 12, 8).strokeColor(marque.couleur).lineWidth(2).stroke();
    doc.fillColor(marque.couleur).fontSize(13).text(marque.nom, x0 + 6, y0 + 16, { width: carre - 12, align: 'center' });
    doc.fillColor('#111').fontSize(10).text('Scannez pour commander et noter', x0 + 6, y0 + 36, { width: carre - 12, align: 'center' });

    const png = await QRCode.toBuffer(t.contenu, { margin: 1, width: 220 });
    const tailleQr = carre - 90;
    doc.image(png, x0 + (carre - tailleQr) / 2, y0 + 54, { width: tailleQr, height: tailleQr });
    doc
      .fillColor('#111')
      .fontSize(14)
      .text(`${t.zone} — ${t.numero}`, x0 + 6, y0 + 54 + tailleQr + 4, { width: carre - 12, align: 'center' });

    pos += 1;
  }

  doc.end();
  return fini;
}
