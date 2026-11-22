import { describe, expect, it } from 'vitest';
import type { BilanLot, CodePromo, LotPromo, RelancePromo } from './api';
import {
  csvBilan,
  csvCodes,
  delaiLisible,
  proportion,
  jourHeure,
  part,
  csvRelances,
  datesParDefaut,
  etatLot,
  expireDans,
  feuilles,
  lienWhatsApp,
  precisionEtat,
  resumeLots,
  telephoneLisible,
  texteFeuilles,
} from './promo';

const lot = (champs: Partial<LotPromo> = {}): LotPromo => ({
  restaurant_id: 'r1',
  id: 'l1',
  libelle: 'Autocollants S48',
  pourcentage: 20,
  valide_du: '2026-11-20T00:00:00.000Z',
  valide_au: '2026-12-17T23:59:59.999Z',
  quantite: 200,
  annule_le: null,
  cree_par: 'Admin',
  cree_le: '2026-11-19T10:00:00Z',
  actives: 0,
  reserves: 0,
  utilises: 0,
  annules: 0,
  utilises_sur_place: 0,
  utilises_telephone: 0,
  utilises_site: 0,
  ca: 0,
  remise: 0,
  conflits: 0,
  ...champs,
});

describe('état d’un lot', () => {
  it('suit sa période, dernier jour inclus, et l’annulation l’emporte', () => {
    expect(etatLot(lot(), new Date('2026-11-19T18:00:00Z'))).toBe('A_VENIR');
    expect(etatLot(lot(), new Date('2026-11-20T00:00:00Z'))).toBe('EN_COURS');
    expect(etatLot(lot(), new Date('2026-12-17T23:00:00Z'))).toBe('EN_COURS');
    expect(etatLot(lot(), new Date('2026-12-18T00:00:00Z'))).toBe('TERMINE');
    expect(etatLot(lot({ annule_le: '2026-11-25T10:00:00Z' }), new Date('2026-11-26T00:00:00Z'))).toBe('ANNULE');
  });

  it('dit en clair où il en est', () => {
    expect(precisionEtat(lot(), new Date('2026-11-19T18:00:00Z'))).toBe('commence demain');
    expect(precisionEtat(lot(), new Date('2026-11-20T08:00:00Z'))).toBe('encore 28 jours');
    expect(precisionEtat(lot(), new Date('2026-12-17T08:00:00Z'))).toBe('dernier jour');
    expect(precisionEtat(lot(), new Date('2026-12-20T08:00:00Z'))).toBe('terminé le 17/12');
    expect(precisionEtat(lot({ annule_le: '2026-11-25T10:00:00Z' }), new Date('2026-11-26T00:00:00Z'))).toBe('annulé le 25/11');
  });
});

describe('chiffres d’en-tête', () => {
  it('ne comptent en circulation que les codes encore utilisables des lots vivants', () => {
    const maintenant = new Date('2026-11-25T12:00:00Z');
    const r = resumeLots(
      [
        lot({ actives: 44, utilises: 14, utilises_telephone: 4, utilises_site: 2, ca: 176500, remise: 35300 }),
        lot({ id: 'l2', annule_le: '2026-11-21T00:00:00Z', quantite: 20, actives: 2, annules: 18 }),
      ],
      maintenant,
    );
    expect(r.lotsVivants).toBe(1);
    expect(r.enCirculation).toBe(186);
    expect(r.gardes).toBe(46);
    expect(r.utilises).toBe(14);
    expect(r.telephone).toBe(4);
    expect(r.site).toBe(2);
    expect(r.ca).toBe(176500);
    expect(r.remise).toBe(35300);
  });
});

describe('feuilles de vinyle', () => {
  it('160 autocollants par feuille, la dernière partielle', () => {
    expect(feuilles(200)).toEqual({ nombre: 2, derniere: 40 });
    expect(feuilles(160)).toEqual({ nombre: 1, derniere: 160 });
    expect(feuilles(0)).toEqual({ nombre: 0, derniere: 0 });
    expect(texteFeuilles(200)).toBe('2 feuilles de vinyle (160 + 40)');
    expect(texteFeuilles(480)).toBe('3 feuilles de vinyle (160 + 160 + 160)');
    expect(texteFeuilles(20)).toBe('1 feuille de vinyle (20 autocollants)');
  });
});

describe('dates proposées', () => {
  it('du lendemain, 28 jours, dernier jour inclus, même tard le soir', () => {
    expect(datesParDefaut(new Date('2026-11-19T23:30:00Z'))).toEqual({ du: '2026-11-20', au: '2026-12-17' });
  });
});

describe('CSV', () => {
  it('liste les codes sans numéro de client, au format Excel français', () => {
    const codes: CodePromo[] = [
      { code: 'PAM-7K3QX', statut: 'UTILISE', active_le: '2026-11-21T09:00:00Z', utilise_le: '2026-11-24T12:00:00Z', utilise_canal: 'TELEPHONE' },
      { code: 'PAM-22ABC', statut: 'DISPONIBLE', active_le: null, utilise_le: null, utilise_canal: null },
    ];
    expect(csvCodes(codes)).toBe(
      'Code;Statut;Gardé sur un numéro;Utilisé le;Canal\r\nPAM-7K3QX;utilisé;oui;24/11/2026;téléphone\r\nPAM-22ABC;disponible;non;;\r\n',
    );
  });

  it('n’ouvre pas de formule dans le tableur', () => {
    const r: RelancePromo = {
      restaurant_id: 'r1', lot_id: 'l1', libelle: 'x', pourcentage: 20, code_masque: 'PAM-•••QX',
      telephone: '+2250700112201', active_le: '2026-11-21T09:00:00Z', valide_au: '2026-12-17T23:59:59.999Z',
    };
    expect(csvRelances([r], () => '=HACK()')).toContain(";'=HACK();");
    expect(csvRelances([r], () => 'Palmeraie')).toContain('225 07 00 11 22 01;Palmeraie;PAM-•••QX;20 %;21/11/2026;17/12/2026');
  });
});

describe('relance WhatsApp', () => {
  const r: RelancePromo = {
    restaurant_id: 'r1', lot_id: 'l1', libelle: 'x', pourcentage: 20, code_masque: 'PAM-•••QX',
    telephone: '+2250700112201', active_le: '2026-11-21T09:00:00Z', valide_au: '2026-11-22T23:59:59.999Z',
  };

  it('ouvre la conversation avec un message prêt, sans le code', () => {
    const lien = lienWhatsApp(r, 'Chez Samer Palmeraie');
    expect(lien.startsWith('https://wa.me/2250700112201?text=')).toBe(true);
    const message = decodeURIComponent(lien.split('text=')[1]!);
    expect(message).toBe('Bonjour ! Ton −20 % chez Chez Samer Palmeraie expire dimanche 22/11. Donne simplement ton numéro à ta prochaine commande.');
    expect(message).not.toContain('PAM');
  });

  it('affiche numéro et échéance lisiblement', () => {
    expect(telephoneLisible('+2250700112201')).toBe('+225 07 00 11 22 01');
    expect(expireDans(r.valide_au, new Date('2026-11-21T10:00:00Z'))).toBe('demain');
    expect(expireDans(r.valide_au, new Date('2026-11-22T10:00:00Z'))).toBe('aujourd’hui');
    expect(expireDans(r.valide_au, new Date('2026-11-19T10:00:00Z'))).toBe('dans 3 jours');
  });
});

describe('bilan d’un lot', () => {
  it('donne les parts lisibles, avec une décimale sous 10 %', () => {
    expect(part(44, 200)).toBe('22 %');
    expect(part(14, 200)).toBe('7 %');
    expect(part(3, 200)).toBe('1,5 %');
    expect(part(0, 200)).toBe('0 %');
    expect(part(3, 0)).toBeNull();
  });

  it('écrit le délai médian en heures, puis en jours', () => {
    expect(delaiLisible(null)).toBe('—');
    expect(delaiLisible(0.4)).toBe('moins d’1 h');
    expect(delaiLisible(23.6)).toBe('24 h');
    expect(delaiLisible(72.2)).toBe('3 jours');
  });

  it('dimensionne les barres sur la plus haute', () => {
    expect(proportion(9, 9)).toBe('100%');
    expect(proportion(3, 9)).toBe('33%');
    expect(proportion(0, 0)).toBe('0%');
    expect(jourHeure('2026-11-22T13:05:41Z')).toBe('22/11 13:05');
  });

  it('exporte une ligne par code utilisé, sans numéro de client', () => {
    const bilan = {
      utilisations: [
        { code: 'PAM-7K3QX', le: '2026-11-22T13:05:00Z', canal: 'TELEPHONE', numero_ticket: 1042, total: 12000, remise: 2400, annulee: false },
        { code: 'PAM-H4M2P', le: '2026-11-23T09:00:00Z', canal: 'SITE', numero_ticket: null, total: null, remise: null, annulee: false },
      ],
    } as unknown as BilanLot;

    expect(csvBilan(bilan)).toBe(
      'Code;Utilisé le;Canal;Ticket;Total (FCFA);Remise (FCFA);Commande annulée\r\n' +
        'PAM-7K3QX;22/11 13:05;téléphone;1042;12000;2400;non\r\n' +
        'PAM-H4M2P;23/11 09:00;site;;;;non\r\n',
    );
  });
});
