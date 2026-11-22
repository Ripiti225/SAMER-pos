// Onglet « Codes promo cartes » — règles d'affichage, sans React ni réseau.
// Abidjan est à UTC+0 toute l'année : une date du jour est une date UTC.
import type { BilanLot, CanalPromo, CodePromo, LotPromo, RelancePromo } from './api';

const JOUR_MS = 24 * 3600 * 1000;

/** Autocollants par feuille de vinyle 1 m² (10 colonnes × 16 rangées, brief § 7). */
export const AUTOCOLLANTS_PAR_FEUILLE = 160;
export const DUREE_PAR_DEFAUT_JOURS = 28;

export type EtatLot = 'EN_COURS' | 'A_VENIR' | 'TERMINE' | 'ANNULE';

export const LIBELLES_ETAT: Record<EtatLot, string> = {
  EN_COURS: 'En cours',
  A_VENIR: 'À venir',
  TERMINE: 'Terminé',
  ANNULE: 'Annulé',
};

export function etatLot(lot: Pick<LotPromo, 'annule_le' | 'valide_du' | 'valide_au'>, maintenant: Date): EtatLot {
  if (lot.annule_le) return 'ANNULE';
  if (maintenant.getTime() < Date.parse(lot.valide_du)) return 'A_VENIR';
  if (maintenant.getTime() > Date.parse(lot.valide_au)) return 'TERMINE';
  return 'EN_COURS';
}

/** « encore 27 jours », « commence dans 7 jours », « terminé le 17/12 »… */
export function precisionEtat(lot: Pick<LotPromo, 'annule_le' | 'valide_du' | 'valide_au'>, maintenant: Date): string {
  const etat = etatLot(lot, maintenant);
  if (etat === 'ANNULE') return `annulé le ${jourMois(lot.annule_le!)}`;
  if (etat === 'TERMINE') return `terminé le ${jourMois(lot.valide_au)}`;
  const jours = (cible: string) => Math.max(1, Math.ceil((Date.parse(cible) - maintenant.getTime()) / JOUR_MS));
  if (etat === 'A_VENIR') {
    const n = jours(lot.valide_du);
    return n === 1 ? 'commence demain' : `commence dans ${n} jours`;
  }
  const n = jours(lot.valide_au);
  return n === 1 ? 'dernier jour' : `encore ${n} jours`;
}

/** `2026-12-17T…` → `17/12`. */
export function jourMois(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** `2026-12-17T…` → `17/12/2026`. */
export function jourMoisAn(iso: string): string {
  return `${jourMois(iso)}/${iso.slice(0, 4)}`;
}

/** Les chiffres d'en-tête : ce qui circule, ce qui est gardé, utilisé, remisé. */
export function resumeLots(lots: LotPromo[], maintenant: Date) {
  const vivants = lots.filter((l) => {
    const e = etatLot(l, maintenant);
    return e === 'EN_COURS' || e === 'A_VENIR';
  });
  const somme = (liste: LotPromo[], champ: keyof LotPromo) => liste.reduce((s, l) => s + Number(l[champ] ?? 0), 0);
  return {
    lotsVivants: vivants.length,
    enCirculation: somme(vivants, 'quantite') - somme(vivants, 'annules') - somme(vivants, 'utilises'),
    gardes: somme(lots, 'actives'),
    codesDistribues: somme(lots, 'quantite'),
    utilises: somme(lots, 'utilises'),
    telephone: somme(lots, 'utilises_telephone'),
    site: somme(lots, 'utilises_site'),
    ca: somme(lots, 'ca'),
    remise: somme(lots, 'remise'),
  };
}

/** Feuilles de vinyle pour N codes : la dernière est partielle. */
export function feuilles(quantite: number): { nombre: number; derniere: number } {
  if (quantite <= 0) return { nombre: 0, derniere: 0 };
  const nombre = Math.ceil(quantite / AUTOCOLLANTS_PAR_FEUILLE);
  return { nombre, derniere: quantite - (nombre - 1) * AUTOCOLLANTS_PAR_FEUILLE };
}

/** « 2 feuilles de vinyle (160 + 40) ». */
export function texteFeuilles(quantite: number): string {
  const { nombre, derniere } = feuilles(quantite);
  if (nombre === 0) return '';
  if (nombre === 1) return `1 feuille de vinyle (${derniere} autocollants)`;
  const pleines = Array.from({ length: nombre - 1 }, () => AUTOCOLLANTS_PAR_FEUILLE);
  return `${nombre} feuilles de vinyle (${[...pleines, derniere].join(' + ')})`;
}

/** Dates proposées à la création : du lendemain, 28 jours, dernier jour inclus. */
export function datesParDefaut(maintenant: Date): { du: string; au: string } {
  const du = new Date(maintenant.getTime() + JOUR_MS).toISOString().slice(0, 10);
  const au = new Date(Date.parse(`${du}T00:00:00Z`) + (DUREE_PAR_DEFAUT_JOURS - 1) * JOUR_MS).toISOString().slice(0, 10);
  return { du, au };
}

const LIBELLES_STATUT: Record<CodePromo['statut'], string> = {
  DISPONIBLE: 'disponible',
  RESERVE: 'réservé',
  UTILISE: 'utilisé',
  ANNULE: 'annulé',
};
const LIBELLES_CANAL: Record<NonNullable<CodePromo['utilise_canal']>, string> = {
  SUR_PLACE: 'sur place',
  TELEPHONE: 'téléphone',
  SITE: 'site',
};

/** Une cellule CSV : guillemets doublés, et pas de formule pour le tableur. */
function cellule(v: string): string {
  const sure = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[;"\n]/.test(sure) ? `"${sure.replace(/"/g, '""')}"` : sure;
}

/**
 * CSV de contrôle d'un lot. Point-virgule : c'est ce qu'Excel attend en
 * français. Pas de numéro de client : la liste sert à vérifier l'impression.
 */
export function csvCodes(codes: CodePromo[]): string {
  const lignes = [['Code', 'Statut', 'Gardé sur un numéro', 'Utilisé le', 'Canal']];
  for (const c of codes) {
    lignes.push([
      c.code,
      LIBELLES_STATUT[c.statut],
      c.active_le ? 'oui' : 'non',
      c.utilise_le ? jourMoisAn(c.utilise_le) : '',
      c.utilise_canal ? LIBELLES_CANAL[c.utilise_canal] : '',
    ]);
  }
  return `${lignes.map((l) => l.map(cellule).join(';')).join('\r\n')}\r\n`;
}

/** CSV des numéros à relancer, pour une relance hors de la console. */
export function csvRelances(relances: RelancePromo[], nomResto: (id: string) => string): string {
  const lignes = [['Numéro', 'Restaurant', 'Code', 'Remise', 'Gardé le', 'Expire le']];
  for (const r of relances) {
    // Sans le « + » de tête : un tableur le prendrait pour le début d'une formule.
    lignes.push([telephoneLisible(r.telephone).slice(1), nomResto(r.restaurant_id), r.code_masque, `${r.pourcentage} %`, jourMoisAn(r.active_le), jourMoisAn(r.valide_au)]);
  }
  return `${lignes.map((l) => l.map(cellule).join(';')).join('\r\n')}\r\n`;
}

/** `+2250777303333` → `+225 07 77 30 33 33`. */
export function telephoneLisible(telephone: string): string {
  const n = telephone.replace(/^\+225/, '');
  return `+225 ${n.match(/.{1,2}/g)?.join(' ') ?? n}`;
}

/** « demain », « dans 2 jours », « aujourd’hui ». */
export function expireDans(valideAu: string, maintenant: Date): string {
  const jourFin = valideAu.slice(0, 10);
  const aujourdhui = maintenant.toISOString().slice(0, 10);
  const n = Math.round((Date.parse(`${jourFin}T00:00:00Z`) - Date.parse(`${aujourdhui}T00:00:00Z`)) / JOUR_MS);
  if (n <= 0) return 'aujourd’hui';
  if (n === 1) return 'demain';
  return `dans ${n} jours`;
}

/**
 * Lien WhatsApp avec le message de relance prêt, que la personne relit et
 * peut modifier avant l'envoi. Tutoiement, comme l'autocollant.
 */
export function lienWhatsApp(relance: RelancePromo, nomResto: string): string {
  const fin = new Date(relance.valide_au);
  const jour = fin.toLocaleDateString('fr-FR', { weekday: 'long', timeZone: 'UTC' });
  const message =
    `Bonjour ! Ton −${relance.pourcentage} % chez ${nomResto} expire ${jour} ${jourMois(relance.valide_au)}. ` +
    'Donne simplement ton numéro à ta prochaine commande.';
  return `https://wa.me/${relance.telephone.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`;
}

// ---------------------------------------------------------------------------
// Bilan d'un lot (PROMO-13)
// ---------------------------------------------------------------------------

/** Libellés des canaux sur l'écran du bilan. */
export const CANAUX_BILAN: Record<CanalPromo, string> = {
  SUR_PLACE: 'Caisse (sur place, à emporter)',
  TELEPHONE: 'Téléphone',
  SITE: 'Site (WhatsApp)',
};

/** Part arrondie, en pourcentage lisible ; `null` quand la base est vide. */
export function part(n: number, sur: number): string | null {
  if (sur <= 0) return null;
  const p = (n / sur) * 100;
  return `${p > 0 && p < 10 ? Math.round(p * 10) / 10 : Math.round(p)} %`.replace('.', ',');
}

/** Délai médian « gardé → utilisé » : en heures sous deux jours, en jours au-delà. */
export function delaiLisible(heures: number | null): string {
  if (heures === null) return '—';
  if (heures < 1) return 'moins d’1 h';
  if (heures < 48) return `${Math.round(heures)} h`;
  return `${Math.round(heures / 24)} jours`;
}

/** `2026-11-22T13:05:00Z` → `22/11 13:05` (Abidjan = UTC). */
export function jourHeure(iso: string): string {
  return `${jourMois(iso)} ${iso.slice(11, 16)}`;
}

/** Taille d'une barre (hauteur ou largeur) en % de la plus grande ; 0 reste à 0. */
export function proportion(n: number, max: number): string {
  return max > 0 ? `${Math.round((n / max) * 100)}%` : '0%';
}

/** CSV du bilan : une ligne par code utilisé, sans numéro de client. */
export function csvBilan(bilan: BilanLot): string {
  const lignes = [['Code', 'Utilisé le', 'Canal', 'Ticket', 'Total (FCFA)', 'Remise (FCFA)', 'Commande annulée']];
  for (const u of bilan.utilisations) {
    lignes.push([
      u.code,
      jourHeure(u.le),
      LIBELLES_CANAL[u.canal],
      u.numero_ticket === null ? '' : String(u.numero_ticket),
      u.total === null ? '' : String(u.total),
      u.remise === null ? '' : String(u.remise),
      u.annulee ? 'oui' : 'non',
    ]);
  }
  return `${lignes.map((l) => l.map(cellule).join(';')).join('\r\n')}\r\n`;
}
