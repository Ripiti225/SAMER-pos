import type { CommandeItemVue, CommandeVue, PosteImpression, RapportSequence, RapportZ } from '@pos/shared';
import { estLivraisonSansEncaissement, formatFCFA, libellePartenaire, LIBELLES_MODES, LIBELLES_POSTE_IMPRESSION, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import type { PrinterService } from './PrinterService.js';

const LARGEUR = 42;

function ligne(gauche: string, droite: string): string {
  const espace = Math.max(1, LARGEUR - gauche.length - droite.length);
  return gauche + ' '.repeat(espace) + droite;
}

/** Implémentation sprint 1 : « imprime » dans la console du serveur. */
export class ConsolePrinter implements PrinterService {
  /** Facture (addition) avant paiement : mêmes lignes, sans règlement. */
  async imprimerFacture(c: CommandeVue): Promise<void> {
    const lignes: string[] = [
      '='.repeat(LARGEUR),
      'FACTURE'.padStart(Math.floor((LARGEUR + 'FACTURE'.length) / 2)),
      `Ticket n° ${c.numero_ticket}`,
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
    lignes.push(ligne('TOTAL A PAYER', formatFCFA(c.total)));
    lignes.push('='.repeat(LARGEUR));
    lignes.push('Facture non acquittée — à régler en caisse');
    console.log('\n[IMPRESSION FACTURE]\n' + lignes.join('\n') + '\n');
  }

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
    if (c.paiements.length === 0 && estLivraisonSansEncaissement(c.partenaire)) {
      lignes.push(`Réglé par ${libellePartenaire(c.partenaire!)}`);
    }
    if (c.offert) {
      lignes.push('*** OFFERT — KDO ***');
      if (c.motif_offert) lignes.push(`Motif : ${c.motif_offert}`);
    }
    lignes.push('='.repeat(LARGEUR));
    lignes.push(c.offert ? 'Offert — bonne dégustation !' : 'Merci de votre visite !');
    console.log('\n[IMPRESSION TICKET]\n' + lignes.join('\n') + '\n');
  }

  async imprimerBon(c: CommandeVue, poste: PosteImpression, items: CommandeItemVue[]): Promise<void> {
    const ident = c.table_numero ? `Table ${c.table_numero}` : c.partenaire ?? '';
    const lignes: string[] = [
      '='.repeat(LARGEUR),
      `BON ${LIBELLES_POSTE_IMPRESSION[poste].toUpperCase()}`,
      `${c.code_commande ?? ''}   (n° ${c.numero_ticket})`,
      `${LIBELLES_TYPES_COMMANDE[c.type]}${ident ? ` — ${ident}` : ''}`,
      '-'.repeat(LARGEUR),
    ];
    for (const item of items) {
      if (item.statut_cuisine === 'ANNULE') continue;
      lignes.push(`${item.quantite} x ${item.nom_snapshot}`);
      for (const s of item.supplements) lignes.push(`   + ${s.nom}`);
      for (const o of item.options) if (o.choix.length) lignes.push(`   ${o.groupe}: ${o.choix.join(', ')}`);
    }
    lignes.push('='.repeat(LARGEUR));
    console.log(`\n[IMPRESSION BON ${poste}]\n` + lignes.join('\n') + '\n');
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
      'Par type :',
      ...Object.entries(z.par_type)
        .filter(([, s]) => s.nb > 0)
        .map(([t, s]) => ligne(`  ${t} (${s.nb})`, formatFCFA(s.total))),
      ...(z.remises_detail.length ? ['-'.repeat(LARGEUR), 'Remises :'] : []),
      ...z.remises_detail.map((r) => ligne(`  N°${r.numero_ticket} ${r.par_nom ?? ''} (${r.motif ?? ''})`, `-${formatFCFA(r.montant)}`)),
      '-'.repeat(LARGEUR),
      ligne('Fond de caisse', formatFCFA(z.fond_de_caisse)),
      ligne('Espèces comptées', formatFCFA(z.especes_comptees)),
      ligne('Espèces théoriques', formatFCFA(z.especes_theorique)),
      ligne('ÉCART', formatFCFA(z.ecart)),
      '-'.repeat(LARGEUR),
      'Récap partenaires :',
      ...Object.entries(z.partenaires).map(([p, s]) => ligne(`  ${libellePartenaire(p)} (${s.nb})`, formatFCFA(s.total))),
      ...(z.offerts?.total ? [ligne(`  Kdo offerts (${z.offerts.nb})`, formatFCFA(z.offerts.total))] : []),
      ...(z.depenses ? [ligne('Dépenses (registre)', formatFCFA(z.depenses))] : []),
      // Inventaire (§ 6.10) : information manager, hors vente et hors écart.
      ...(z.inventaire
        ? [
            '-'.repeat(LARGEUR),
            'Inventaire (information manager) :',
            !z.inventaire.valide && z.inventaire.debloque
              ? '  Débloqué par un manager (comptage incomplet)'
              : z.inventaire.manquants === 0 && z.inventaire.surplus === 0
                ? '  Conforme'
                : ligne(
                    `  ${z.inventaire.manquants} manquant(s), ${z.inventaire.surplus} surplus`,
                    formatFCFA(z.inventaire.montant_manquant),
                  ),
          ]
        : []),
      // Retours : articles déjà lancés en cuisine puis annulés au PIN manager.
      ...(z.retours?.nb
        ? [
            '-'.repeat(LARGEUR),
            'Retours (hors vente et hors tiroir) :',
            ...z.retours.par_produit.map((p) => ligne(`  ${p.quantite} × ${p.nom}`, formatFCFA(p.montant))),
            ligne('  Total retours', formatFCFA(z.retours.montant)),
          ]
        : []),
      ...(z.equipe?.presents
        ? [ligne('Équipe', `${z.equipe.presents} présents · ${z.equipe.restent} restent · ${z.equipe.partis} partis`)]
        : []),
      '='.repeat(LARGEUR),
    ];
    console.log('\n[IMPRESSION RAPPORT Z]\n' + lignes.join('\n') + '\n');
  }

  async imprimerRapportSequence(s: RapportSequence): Promise<void> {
    const lignes: string[] = [
      '='.repeat(LARGEUR),
      'RECAP DE SEQUENCE',
      `Ouverte le ${new Date(s.ouverte_le).toLocaleString('fr-FR')}`,
      `Rasee le   ${new Date(s.cloturee_le).toLocaleString('fr-FR')}`,
      `Par ${s.cloturee_par} — ${s.nb_shifts} shift(s)`,
      // Sans cette ligne, un total amputé des shifts laissés pour le lendemain
      // passerait pour un manque en caisse.
      ...(s.shifts_reportes > 0 ? [`${s.shifts_reportes} shift(s) reporte(s) sur la sequence suivante`] : []),
      '-'.repeat(LARGEUR),
    ];
    for (const sh of s.shifts) {
      lignes.push(`${sh.caissier} (${sh.statut === 'CLOTURE' ? 'clôturé' : 'OUVERT'})`);
      lignes.push(ligne('  Ventes', formatFCFA(sh.vente_totale ?? 0)));
      lignes.push(ligne('  Espèces comptées', formatFCFA(sh.especes_comptees ?? 0)));
      lignes.push(ligne('  Écart', formatFCFA(sh.ecart ?? 0)));
      if (sh.offerts?.total) lignes.push(ligne(`  Kdo offerts (${sh.offerts.nb})`, formatFCFA(sh.offerts.total)));
    }
    lignes.push(
      '-'.repeat(LARGEUR),
      ligne('TOTAL VENTES', formatFCFA(s.vente_totale)),
      ...(s.offerts?.total ? [ligne(`dont Kdo offerts (${s.offerts.nb})`, formatFCFA(s.offerts.total))] : []),
      ligne('Total système', formatFCFA(s.total_systeme)),
      ligne('Différence', formatFCFA(s.diff)),
      ligne('Espèces comptées', formatFCFA(s.especes_comptees)),
      ligne('Dépenses', formatFCFA(s.depenses)),
      ligne('Écart espèces', formatFCFA(s.ecart_especes)),
      '='.repeat(LARGEUR),
    );
    console.log('\n[IMPRESSION RECAP SEQUENCE]\n' + lignes.join('\n') + '\n');
  }
}
