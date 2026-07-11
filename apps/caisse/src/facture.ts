import type { CommandeVue } from '@pos/shared';
import { formatFCFA, LIBELLES_MODES, LIBELLES_TYPES_COMMANDE } from '@pos/shared';

const echap = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Convertit un texte multi-lignes en HTML (échappé, sauts de ligne conservés). */
const multiligne = (s: string): string => echap(s).replace(/\n/g, '<br>');

interface InfosResto {
  nom: string;
  marque: 'SAMER' | 'AL_KAYAN';
  entete?: string;
  pied?: string;
}

/** FACTURE = addition avant paiement ; REÇU = ticket acquitté après paiement. */
export type ModeRecu = 'FACTURE' | 'RECU';

/**
 * Imprime un reçu 80 mm via le navigateur, vers l'imprimante par défaut du
 * terminal. Le document s'imprime LUI-MÊME une fois chargé (logo compris),
 * ce qui est bien plus fiable qu'un print() déclenché depuis la page.
 */
export function imprimerRecuNavigateur(commande: CommandeVue, resto: InfosResto, mode: ModeRecu): void {
  const items = commande.items.filter((i) => i.statut_cuisine !== 'ANNULE');
  const lignesItems = items
    .map((item) => {
      const supp = item.supplements
        .map((s) => `<div class="sous">+ ${echap(s.nom)} (${formatFCFA(s.prix)})</div>`)
        .join('');
      const opts = item.options
        .filter((o) => o.choix.length > 0)
        .map((o) => `<div class="sous">${echap(o.groupe)} : ${echap(o.choix.join(', '))}</div>`)
        .join('');
      return `
        <div class="ligne">
          <span>${item.quantite}× ${echap(item.nom_snapshot)}</span>
          <span>${formatFCFA(item.total_ligne)}</span>
        </div>${supp}${opts}`;
    })
    .join('');

  const entete = commande.table_numero
    ? `Table ${echap(commande.table_numero)}`
    : `Ticket n° ${commande.numero_ticket}`;

  const remises = [
    commande.promo_montant > 0 ? `<div class="ligne petit"><span>Promo ${echap(commande.promo_nom ?? '')}</span><span>−${formatFCFA(commande.promo_montant)}</span></div>` : '',
    commande.remise_montant > 0 ? `<div class="ligne petit"><span>Remise</span><span>−${formatFCFA(commande.remise_montant)}</span></div>` : '',
    commande.fidelite_montant > 0 ? `<div class="ligne petit"><span>Fidélité</span><span>−${formatFCFA(commande.fidelite_montant)}</span></div>` : '',
  ].join('');

  // Reçu acquitté : lignes de règlement (mode + montant).
  const paiements =
    mode === 'RECU' && commande.paiements.length
      ? '<hr>' +
        commande.paiements
          .map((p) => `<div class="ligne petit"><span>${echap(LIBELLES_MODES[p.mode])}</span><span>${formatFCFA(p.montant)}</span></div>`)
          .join('')
      : '';

  const titre = mode === 'RECU' ? 'REÇU' : 'FACTURE';
  const noteBas =
    mode === 'RECU'
      ? 'Payé — merci de votre visite !'
      : 'Facture non acquittée — à régler en caisse';

  const logo = resto.marque === 'AL_KAYAN' ? '/logo-alkayan.png' : '/logo-samer.png';
  const blocEntete = resto.entete ? `<div class="centre petit contact">${multiligne(resto.entete)}</div>` : '';
  const blocPied = resto.pied ? `<div class="pied">${multiligne(resto.pied)}</div>` : '';

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${titre}</title>
    <style>
      @page { size: 80mm auto; margin: 0; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { width: 80mm; padding: 4mm 3mm; font-family: 'Courier New', monospace; font-size: 12px; color: #000; }
      .centre { text-align: center; }
      .gras { font-weight: bold; }
      .nom { font-size: 14px; font-weight: bold; }
      .logo { display: block; margin: 0 auto 4px; max-width: 58mm; max-height: 22mm; object-fit: contain; }
      .contact { margin: 2px 0; }
      hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
      .ligne { display: flex; justify-content: space-between; gap: 6px; margin: 2px 0; }
      .sous { padding-left: 10px; font-size: 11px; }
      .petit { font-size: 11px; }
      .total { font-size: 15px; font-weight: bold; }
      .pied { margin-top: 8px; text-align: center; font-size: 11px; }
    </style>
    <script>
      // Auto-impression une fois la page (et le logo) chargée, puis nettoyage.
      window.onload = function () {
        window.focus();
        window.print();
        setTimeout(function () {
          if (window.frameElement && window.frameElement.remove) window.frameElement.remove();
        }, 2000);
      };
    </script></head><body>
      <img class="logo" src="${logo}" alt="" onerror="this.style.display='none'">
      <div class="centre nom">${echap(resto.nom)}</div>
      ${blocEntete}
      <hr>
      <div class="centre gras">${titre}</div>
      <div class="centre petit">${entete} · ${echap(LIBELLES_TYPES_COMMANDE[commande.type])}${commande.partenaire ? ' · ' + echap(commande.partenaire) : ''}</div>
      <div class="centre petit">${new Date().toLocaleString('fr-FR')}</div>
      <hr>
      ${lignesItems}
      <hr>
      <div class="ligne petit"><span>Sous-total</span><span>${formatFCFA(commande.sous_total)}</span></div>
      ${remises}
      <div class="ligne total"><span>TOTAL</span><span>${formatFCFA(commande.total)}</span></div>
      ${paiements}
      <hr>
      <div class="pied">${noteBas}</div>
      ${blocPied}
    </body></html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close(); // déclenche le chargement → window.onload → impression
}

/** Facture (addition) avant paiement. */
export function imprimerFactureNavigateur(commande: CommandeVue, resto: InfosResto): void {
  imprimerRecuNavigateur(commande, resto, 'FACTURE');
}
