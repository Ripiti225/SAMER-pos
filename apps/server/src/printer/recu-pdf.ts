/**
 * Reçu PDF pour le client qui a commandé au QR de sa table.
 *
 * Le papier thermique part avec le serveur ; le client, lui, repart avec son
 * téléphone. Ce PDF est la MÊME pièce que le ticket ESC/POS (`imprimerTicket`)
 * — mêmes lignes, mêmes remises, mêmes modes de paiement — mais au format
 * ticket 80 mm dématérialisé, lisible et imprimable partout.
 *
 * Pas de translittération ASCII ici, contrairement à l'ESC/POS : un PDF gère
 * les accents, et « Frites supplémentaires » doit rester écrit correctement.
 */
import PDFDocument from 'pdfkit';
import type { CommandeVue, NoteSplitVue } from '@pos/shared';
import {
  estLivraisonSansEncaissement,
  formatFCFA,
  libellePartenaire,
  LIBELLES_MODES,
  LIBELLES_TYPES_COMMANDE,
} from '@pos/shared';

/** Largeur d'un ticket 80 mm en points PDF (72 pt = 1 pouce). */
const LARGEUR = 226;
const MARGE = 14;
const UTILE = LARGEUR - MARGE * 2;

export interface EnteteRecu {
  nom: string;
  entete: string;
  pied: string;
  couleur_hex: string;
}

export interface FideliteRecu {
  /** Points gagnés (ou qui auraient été gagnés) sur cette vente. */
  points: number;
  /** Faux quand le client n'a pas donné son numéro : on lui montre le manque. */
  rattache: boolean;
  /** Solde après cette vente — seulement si le client est identifié. */
  solde: number | null;
}

function horodatage(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Construit le PDF complet en mémoire. La hauteur de page est volontairement
 * généreuse et la page se prolonge d'elle-même si la commande est longue :
 * pdfkit ajoute une page plutôt que de tronquer.
 */
export function construireRecuPdf(
  c: CommandeVue,
  resto: EnteteRecu,
  fidelite: FideliteRecu,
  numeroPaiement?: number,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: [LARGEUR, 800], margin: MARGE, info: { Title: `Recu ${c.numero_ticket}${numeroPaiement ? ` paiement ${numeroPaiement}` : ''}` } });
  const morceaux: Buffer[] = [];
  doc.on('data', (m: Buffer) => morceaux.push(m));
  const fini = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(morceaux))));

  /** Ligne « libellé …… montant » : montant collé à droite, libellé replié. */
  const duo = (gauche: string, droite: string, gras = false, taille = 8): void => {
    doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(taille);
    const largeurDroite = doc.widthOfString(droite) + 4;
    const y = doc.y;
    doc.text(gauche, MARGE, y, { width: UTILE - largeurDroite });
    doc.text(droite, MARGE, y, { width: UTILE, align: 'right' });
    doc.y = Math.max(doc.y, y + doc.currentLineHeight());
  };
  const centre = (s: string, taille = 8, gras = false): void => {
    doc.font(gras ? 'Helvetica-Bold' : 'Helvetica').fontSize(taille).text(s, MARGE, doc.y, { width: UTILE, align: 'center' });
  };
  const tiret = (): void => {
    doc.moveTo(MARGE, doc.y + 3).lineTo(LARGEUR - MARGE, doc.y + 3).strokeColor('#999999').lineWidth(0.5).stroke();
    doc.y += 7;
  };

  // En-tête : nom du restaurant à la couleur de la marque.
  doc.fillColor(resto.couleur_hex);
  centre(resto.nom, 15, true);
  doc.fillColor('#000000');
  if (resto.entete) for (const l of resto.entete.split('\n')) centre(l, 7);
  doc.moveDown(0.4);
  centre('REÇU', 10, true);
  if (c.code_commande) centre(c.code_commande, 14, true);
  const sous = `${LIBELLES_TYPES_COMMANDE[c.type]}${c.table_numero ? ` – Table ${c.table_numero}` : ''}`;
  centre(sous, 8);
  centre(`Ticket ${c.numero_ticket}${numeroPaiement ? ` – Paiement ${numeroPaiement}` : ''} – ${horodatage(c.created_at)}`, 7);
  tiret();

  // Articles (une ligne annulée n'est pas vendue : elle ne figure pas au reçu).
  for (const item of c.items) {
    if (item.statut_cuisine === 'ANNULE') continue;
    duo(`${item.quantite} × ${item.nom_snapshot}`, formatFCFA(item.total_ligne), true, 9);
    for (const s of item.supplements) {
      duo(`   + ${s.nom}`, s.prix > 0 ? formatFCFA(s.prix) : '', false, 7);
    }
    for (const o of item.options) {
      if (o.choix.length) doc.font('Helvetica').fontSize(7).text(`   ${o.groupe} : ${o.choix.join(', ')}`, MARGE, doc.y, { width: UTILE });
    }
  }
  tiret();

  duo('Sous-total', formatFCFA(c.sous_total));
  if (c.promo_montant > 0) duo(`Promo ${c.promo_nom ?? ''}`.trim(), `-${formatFCFA(c.promo_montant)}`);
  if (c.remise_montant > 0) duo('Remise', `-${formatFCFA(c.remise_montant)}`);
  if (c.fidelite_montant > 0) duo('Points utilisés', `-${formatFCFA(c.fidelite_montant)}`);
  duo('TOTAL', formatFCFA(c.total), true, 12);
  tiret();

  for (const p of c.paiements) duo(LIBELLES_MODES[p.mode], formatFCFA(p.montant));
  if (c.paiements.length === 0 && estLivraisonSansEncaissement(c.partenaire)) {
    centre(`Réglé par ${libellePartenaire(c.partenaire!)}`, 8);
  }
  if (c.offert) {
    centre('*** OFFERT ***', 9, true);
    if (c.motif_offert) centre(c.motif_offert, 7);
  }

  // Fidélité : le seul endroit où le client voit ce que sa visite lui rapporte,
  // ou ce qu'elle lui aurait rapporté s'il avait laissé son numéro.
  tiret();
  doc.fillColor(resto.couleur_hex);
  if (fidelite.rattache) {
    centre(`+ ${fidelite.points} point${fidelite.points > 1 ? 's' : ''} de fidélité`, 10, true);
    doc.fillColor('#000000');
    if (fidelite.solde !== null) centre(`Nouveau solde : ${fidelite.solde} points`, 8);
  } else {
    centre(`${fidelite.points} point${fidelite.points > 1 ? 's' : ''} non crédités`, 10, true);
    doc.fillColor('#000000');
    centre('Donnez votre numéro à la prochaine commande pour les cumuler.', 7);
  }
  doc.fillColor('#000000');

  tiret();
  centre(c.offert ? 'Offert – bonne dégustation !' : 'Payé – merci de votre visite !', 8, true);
  if (resto.pied) centre(resto.pied, 7);

  doc.end();
  return fini;
}

/** PDF d'une sous-note : aucune ligne ni aucun règlement d'un autre convive. */
export function construireRecuSousNotePdf(
  commande: CommandeVue,
  note: NoteSplitVue,
  resto: EnteteRecu,
  fidelite: FideliteRecu,
): Promise<Buffer> {
  const parId = new Map(commande.items.map((item) => [item.id, item]));
  const vue: CommandeVue = {
    ...commande,
    sous_total: note.sous_total,
    promo_montant: note.promo_montant,
    remise_montant: note.remise_montant,
    fidelite_montant: note.fidelite_montant,
    client_fidelite_id: note.client_fidelite_id,
    total: note.montant,
    paye: note.paye,
    reste: note.reste,
    paiements: note.paiements,
    items: note.items.map((allocation) => {
      const source = parId.get(allocation.commande_item_id)!;
      return {
        ...source,
        quantite: allocation.quantite,
        quantite_reservee: 0,
        quantite_payee: allocation.quantite,
        quantite_disponible: 0,
        total_ligne: allocation.montant_brut,
      };
    }),
  };
  return construireRecuPdf(vue, resto, fidelite, note.numero);
}
