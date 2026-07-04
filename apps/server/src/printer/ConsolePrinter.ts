import type { CommandeVue, RapportZ } from '@pos/shared';
import { formatFCFA, LIBELLES_MODES, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import type { PrinterService } from './PrinterService.js';

const LARGEUR = 42;

function ligne(gauche: string, droite: string): string {
  const espace = Math.max(1, LARGEUR - gauche.length - droite.length);
  return gauche + ' '.repeat(espace) + droite;
}

/** Implémentation sprint 1 : « imprime » le ticket dans la console du serveur. */
export class ConsolePrinter implements PrinterService {
  async imprimerTicket(c: CommandeVue): Promise<void> {
    const lignes: string[] = [
      '='.repeat(LARGEUR),
      `TICKET N° ${c.numero_ticket}`.padStart(Math.floor((LARGEUR + `TICKET N° ${c.numero_ticket}`.length) / 2)),
      `${LIBELLES_TYPES_COMMANDE[c.type]}${c.table_numero ? ` — Table ${c.table_numero}` : ''}${c.partenaire ? ` — ${c.partenaire}` : ''}`,
      '-'.repeat(LARGEUR),
    ];
    for (const item of c.items) {
      if (item.statut_cuisine === 'ANNULE') continue;
      lignes.push(ligne(`${item.quantite} x ${item.nom_snapshot}`, formatFCFA(item.total_ligne)));
      for (const s of item.supplements) lignes.push(`   + ${s.nom} (${formatFCFA(s.prix)})`);
      for (const o of item.options) if (o.choix.length) lignes.push(`   ${o.groupe}: ${o.choix.join(', ')}`);
    }
    lignes.push('-'.repeat(LARGEUR));
    lignes.push(ligne('Sous-total', formatFCFA(c.sous_total)));
    if (c.promo_montant > 0) lignes.push(ligne(`Promo ${c.promo_nom ?? ''}`, `-${formatFCFA(c.promo_montant)}`));
    if (c.remise_montant > 0) lignes.push(ligne('Remise', `-${formatFCFA(c.remise_montant)}`));
    lignes.push(ligne('TOTAL', formatFCFA(c.total)));
    lignes.push('-'.repeat(LARGEUR));
    for (const p of c.paiements) lignes.push(ligne(LIBELLES_MODES[p.mode], formatFCFA(p.montant)));
    lignes.push('='.repeat(LARGEUR));
    lignes.push('Merci de votre visite !');
    console.log('\n[IMPRESSION TICKET]\n' + lignes.join('\n') + '\n');
  }

  async imprimerRapportZ(z: RapportZ): Promise<void> {
    const lignes: string[] = [
      '='.repeat(LARGEUR),
      `RAPPORT Z — ${z.caissier}`,
      `Service du ${new Date(z.ouvert_le).toLocaleString('fr-FR')}`,
      '-'.repeat(LARGEUR),
      ligne('Commandes encaissées', String(z.nb_commandes_payees)),
      ligne('Commandes annulées', String(z.nb_commandes_annulees)),
      ligne('Total ventes', formatFCFA(z.total_ventes)),
      ligne('Total remises', formatFCFA(z.total_remises)),
      ligne('Total promotions', formatFCFA(z.total_promos)),
      '-'.repeat(LARGEUR),
      ...Object.entries(z.par_mode)
        .filter(([, montant]) => montant > 0)
        .map(([mode, montant]) => ligne(mode, formatFCFA(montant))),
      '-'.repeat(LARGEUR),
      ligne('Fond de caisse', formatFCFA(z.fond_de_caisse)),
      ligne('Espèces comptées', formatFCFA(z.especes_comptees)),
      ligne('Espèces théoriques', formatFCFA(z.especes_theorique)),
      ligne('ÉCART', formatFCFA(z.ecart)),
      '-'.repeat(LARGEUR),
      'Récap partenaires :',
      ...Object.entries(z.partenaires).map(([p, s]) => ligne(`  ${p} (${s.nb})`, formatFCFA(s.total))),
      '='.repeat(LARGEUR),
    ];
    console.log('\n[IMPRESSION RAPPORT Z]\n' + lignes.join('\n') + '\n');
  }
}
