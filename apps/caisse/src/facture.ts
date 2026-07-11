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

// Précharge les logos pour qu'ils soient prêts à l'impression (cache navigateur).
if (typeof window !== 'undefined') {
  for (const s of ['/logo-samer.png', '/logo-alkayan.png']) {
    const i = new Image();
    i.src = s;
  }
}

// Feuille de style d'impression : n'affiche QUE le reçu, en 80 mm.
const CSS_IMPRESSION = `
  #recu-impression { display: none; }
  @media print {
    @page { size: 80mm auto; margin: 0; }
    html, body { width: 80mm; margin: 0; padding: 0; background: #fff; }
    body > *:not(#recu-impression) { display: none !important; }
    #recu-impression {
      display: block !important;
      width: 80mm; padding: 4mm 3mm;
      font-family: 'Courier New', monospace; font-size: 12px; color: #000;
    }
    #recu-impression .centre { text-align: center; }
    #recu-impression .gras { font-weight: bold; }
    #recu-impression .nom { font-size: 14px; font-weight: bold; }
    #recu-impression .logo { display: block; margin: 0 auto 4px; max-width: 58mm; max-height: 22mm; object-fit: contain; }
    #recu-impression .contact { margin: 2px 0; }
    #recu-impression hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
    #recu-impression .ligne { display: flex; justify-content: space-between; gap: 6px; margin: 2px 0; }
    #recu-impression .sous { padding-left: 10px; font-size: 11px; }
    #recu-impression .petit { font-size: 11px; }
    #recu-impression .total { font-size: 15px; font-weight: bold; }
    #recu-impression .pied { margin-top: 8px; text-align: center; font-size: 11px; }
  }
`;

function corpsRecu(commande: CommandeVue, resto: InfosResto, mode: ModeRecu): string {
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
      return `<div class="ligne"><span>${item.quantite}× ${echap(item.nom_snapshot)}</span><span>${formatFCFA(item.total_ligne)}</span></div>${supp}${opts}`;
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

  const paiements =
    mode === 'RECU' && commande.paiements.length
      ? '<hr>' +
        commande.paiements
          .map((p) => `<div class="ligne petit"><span>${echap(LIBELLES_MODES[p.mode])}</span><span>${formatFCFA(p.montant)}</span></div>`)
          .join('')
      : '';

  const titre = mode === 'RECU' ? 'REÇU' : 'FACTURE';
  const noteBas = mode === 'RECU' ? 'Payé — merci de votre visite !' : 'Facture non acquittée — à régler en caisse';
  const logo = resto.marque === 'AL_KAYAN' ? '/logo-alkayan.png' : '/logo-samer.png';
  const blocEntete = resto.entete ? `<div class="centre petit contact">${multiligne(resto.entete)}</div>` : '';
  const blocPied = resto.pied ? `<div class="pied">${multiligne(resto.pied)}</div>` : '';

  return `
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
    ${blocPied}`;
}

/**
 * Imprime un reçu 80 mm via le navigateur. On imprime la PAGE elle-même (pas
 * une iframe cachée, dont le dialogue d'impression ne s'ouvre pas de façon
 * fiable) : une superposition masque tout sauf le reçu le temps de l'impression.
 * À appeler dans le geste utilisateur (clic) pour que le dialogue s'ouvre.
 */
export function imprimerRecuNavigateur(commande: CommandeVue, resto: InfosResto, mode: ModeRecu): void {
  document.getElementById('recu-impression')?.remove();
  document.getElementById('recu-impression-style')?.remove();

  const style = document.createElement('style');
  style.id = 'recu-impression-style';
  style.textContent = CSS_IMPRESSION;
  const div = document.createElement('div');
  div.id = 'recu-impression';
  div.innerHTML = corpsRecu(commande, resto, mode);
  document.body.appendChild(style);
  document.body.appendChild(div);

  const nettoyer = () => {
    div.remove();
    style.remove();
    window.removeEventListener('afterprint', nettoyer);
  };
  window.addEventListener('afterprint', nettoyer);
  setTimeout(nettoyer, 60_000); // filet si afterprint ne se déclenche pas

  // Laisse le navigateur peindre la superposition avant d'ouvrir le dialogue.
  window.requestAnimationFrame(() => window.print());
}

/** Facture (addition) avant paiement. */
export function imprimerFactureNavigateur(commande: CommandeVue, resto: InfosResto): void {
  imprimerRecuNavigateur(commande, resto, 'FACTURE');
}
