import {
  LIBELLES_MODES,
  LIBELLES_TYPES_COMMANDE,
  libellePartenaire,
  type ModePaiement,
  type TypeCommande,
} from '@pos/shared';
import type { Bord } from './api';
import { jourCourt } from './periode';

/** Couleur d'opérateur, déjà définie par le thème — jamais réinventée ici. */
export const COULEUR_MODE: Record<string, string> = {
  ESPECES: 'var(--pay-especes)',
  WAVE: 'var(--pay-wave)',
  ORANGE_MONEY: 'var(--pay-orange)',
  MTN_MOMO: 'var(--pay-mtn)',
  MOOV_MONEY: 'var(--pay-moov)',
  CARTE: 'var(--pay-carte)',
  DJAMO: 'var(--pay-djamo)',
};

/** Un nombre qui vient du réseau n'est jamais sûr : NULL, texte, absent. */
export const nb = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Une ligne de `BarresHorizontales` ou `BarresEcarts`, déjà triée et coupée. */
export interface LigneBarre {
  cle: string;
  libelle: string;
  valeur: number;
  detail?: string;
  couleur?: string;
}

/**
 * Ce qu'il faut savoir pour dériver une vue, en plus de la charge utile.
 *
 * `noms` est passé plutôt que lu : `vueBord` reste PURE, ce qui est toute la
 * raison de son existence. Elle est testable sans React et sans réseau.
 */
export interface ContexteVue {
  /** Le restaurant regardé, ou `null` pour le groupe entier. */
  restaurantId: string | null;
  /** Son nom, pour les en-têtes et la synthèse. */
  nom: string;
  /** `false` = ce site ne synchronise pas : tout est à zéro POUR CETTE RAISON. */
  enrole: boolean;
  /** Nom de chaque restaurant, pour les détails de ligne en vue groupe. */
  noms: Map<string, string>;
}

/** Tout ce qu'une colonne du tableau de bord a besoin de savoir. Rien de plus. */
export interface VueBord {
  restaurantId: string | null;
  nom: string;
  enrole: boolean;
  /** Aucune vente sur la période — à distinguer d'un site non enrôlé. */
  vide: boolean;

  ca: number;
  caPrecedent: number;
  commandes: number;
  commandesPrecedent: number;
  panier: number;
  depenses: number;
  retoursMontant: number;
  retoursNb: number;
  ecartCumule: number;
  heuresTravaillees: number;
  salaires: number;

  pointsJour: { cle: string; libelle: string; valeurs: Record<string, number> }[];
  heures: { heure: number; ca: number; nb: number }[];

  plats: LigneBarre[];
  modes: LigneBarre[];
  tables: LigneBarre[];
  canaux: LigneBarre[];
  retours: LigneBarre[];
  depensesCategories: LigneBarre[];
  ecarts: LigneBarre[];
  equipe: LigneBarre[];

  remises: Bord['remises'];
  annulations: Bord['annulations'];
  inventaire: Bord['inventaire'];
  livraisons: Bord['livraisons'];
  totalLivraisons: { nb: number; contacts: number };
  absents: Bord['absents'];
}

/** Cumule des lignes par clé texte, puis trie et coupe. */
function cumul<T>(source: T[], cle: (l: T) => string, valeur: (l: T) => number, limite = 10): LigneBarre[] {
  const m = new Map<string, number>();
  for (const l of source) {
    const k = cle(l);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + valeur(l));
  }
  return [...m.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limite)
    .map(([k, v]) => ({ cle: k, libelle: k, valeur: v }));
}

export function vueBord(data: Bord | undefined, ctx: ContexteVue): VueBord {
  const { restaurantId, noms } = ctx;

  /** Filtre commun : toutes les lignes portent `restaurant_id`. */
  const mien = <T extends { restaurant_id: string }>(lignes: T[] | undefined): T[] =>
    (lignes ?? []).filter((l) => !restaurantId || l.restaurant_id === restaurantId);

  const lignesVentes = (data?.restaurants ?? []).filter(
    (r) => r.restaurant_id && (!restaurantId || r.restaurant_id === restaurantId),
  );

  const ca = lignesVentes.reduce((s, l) => s + nb(l.ca), 0);
  const caPrecedent = lignesVentes.reduce((s, l) => s + nb(l.ca_precedent), 0);
  const commandes = lignesVentes.reduce((s, l) => s + nb(l.nb_commandes), 0);
  const commandesPrecedent = lignesVentes.reduce((s, l) => s + nb(l.nb_commandes_precedent), 0);

  const retoursSource = mien(data?.retours);
  const livraisons = [...mien(data?.livraisons)].sort(
    (a, b) => nb(b.nb) - nb(b.contacts) - (nb(a.nb) - nb(a.contacts)) || nb(b.nb) - nb(a.nb),
  );

  // -- Les jours ----------------------------------------------------------
  const parJour = new Map<string, Record<string, number>>();
  for (const t of mien(data?.tendance)) {
    const j = String(t.jour);
    const seau = parJour.get(j) ?? {};
    seau[t.restaurant_id] = (seau[t.restaurant_id] ?? 0) + nb(t.ca);
    parJour.set(j, seau);
  }
  const pointsJour = [...parJour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([jour, valeurs]) => ({ cle: jour, libelle: jourCourt(jour), valeurs }));

  // -- Les heures ---------------------------------------------------------
  const parHeure = new Map<number, { heure: number; ca: number; nb: number }>();
  for (const h of mien(data?.heures)) {
    const k = nb(h.heure);
    const vu = parHeure.get(k) ?? { heure: k, ca: 0, nb: 0 };
    parHeure.set(k, { heure: k, ca: vu.ca + nb(h.ca), nb: vu.nb + nb(h.nb) });
  }
  const heures = [...parHeure.values()].sort((a, b) => a.heure - b.heure);

  // -- Les plats ----------------------------------------------------------
  const parPlat = new Map<string, { q: number; t: number }>();
  for (const p of mien(data?.plats)) {
    const vu = parPlat.get(p.nom) ?? { q: 0, t: 0 };
    parPlat.set(p.nom, { q: vu.q + nb(p.quantite), t: vu.t + nb(p.total) });
  }
  const plats = [...parPlat.entries()]
    .sort(([, a], [, b]) => b.q - a.q)
    .slice(0, 10)
    .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.t, detail: `× ${v.q}` }));

  // -- Les tables ---------------------------------------------------------
  const parTable = new Map<string, { nb: number; total: number }>();
  for (const t of mien(data?.tables)) {
    const nom = t.numero ? `${t.numero}${t.zone ? ` — ${t.zone}` : ''}` : 'Table inconnue';
    const vu = parTable.get(nom) ?? { nb: 0, total: 0 };
    parTable.set(nom, { nb: vu.nb + nb(t.nb), total: vu.total + nb(t.total) });
  }
  const tables = [...parTable.entries()]
    .sort(([, a], [, b]) => b.nb - a.nb)
    .slice(0, 10)
    .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.total, detail: `${v.nb} commande(s)` }));

  // -- Les canaux ---------------------------------------------------------
  const parCanal = new Map<string, { nb: number; total: number }>();
  for (const t of mien(data?.types)) {
    const nom = t.partenaire
      ? libellePartenaire(t.partenaire)
      : (LIBELLES_TYPES_COMMANDE[t.type as TypeCommande] ?? t.type);
    const vu = parCanal.get(nom) ?? { nb: 0, total: 0 };
    parCanal.set(nom, { nb: vu.nb + nb(t.nb), total: vu.total + nb(t.total) });
  }
  const canaux = [...parCanal.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.total, detail: `${v.nb} commande(s)` }));

  // -- L'équipe -----------------------------------------------------------
  const equipeSource = mien(data?.equipe)
    .map((e) => ({ ...e, heures: nb(e.minutes) / 60 }))
    .sort((a, b) => b.heures - a.heures);

  return {
    restaurantId,
    nom: ctx.nom,
    enrole: ctx.enrole,
    vide: ca === 0 && commandes === 0,

    ca,
    caPrecedent,
    commandes,
    commandesPrecedent,
    panier: commandes > 0 ? Math.round(ca / commandes) : 0,
    depenses: mien(data?.depenses).reduce((s, d) => s + nb(d.montant), 0),
    retoursMontant: retoursSource.reduce((s, r) => s + nb(r.montant), 0),
    retoursNb: retoursSource.reduce((s, r) => s + nb(r.quantite), 0),
    ecartCumule: mien(data?.ecarts).reduce((s, e) => s + nb(e.ecart), 0),
    heuresTravaillees: equipeSource.reduce((s, e) => s + e.heures, 0),
    salaires: equipeSource.reduce((s, e) => s + nb(e.salaire), 0),

    pointsJour,
    heures,
    plats,
    tables,
    canaux,

    modes: cumul(mien(data?.modes), (m) => m.mode, (m) => nb(m.montant), 8).map((l) => ({
      ...l,
      libelle: LIBELLES_MODES[l.cle as ModePaiement] ?? l.cle,
      couleur: COULEUR_MODE[l.cle] ?? 'var(--pay-carte)',
    })),

    retours: [...retoursSource]
      .sort((a, b) => nb(b.quantite) - nb(a.quantite))
      .slice(0, 8)
      .map((r) => ({ cle: r.nom, libelle: r.nom, valeur: nb(r.montant), detail: `× ${nb(r.quantite)}` })),

    depensesCategories: cumul(mien(data?.depenses), (d) => d.categorie, (d) => nb(d.montant)),

    ecarts: mien(data?.ecarts)
      .sort((a, b) => Math.abs(nb(b.ecart)) - Math.abs(nb(a.ecart)))
      .slice(0, 10)
      .map((e) => ({
        cle: `${e.restaurant_id}:${e.caissier}`,
        libelle: e.caissier,
        valeur: nb(e.ecart),
        detail: `${nb(e.nb_services)} service(s)${restaurantId ? '' : ` · ${noms.get(e.restaurant_id) ?? ''}`}`,
      })),

    equipe: equipeSource.slice(0, 12).map((e) => ({
      cle: `${e.restaurant_id}:${e.utilisateur_id}`,
      libelle: e.nom,
      valeur: Math.round(e.heures * 10) / 10,
      detail: `${e.poste ?? 'poste non renseigné'} · ${nb(e.nb_services)} service(s)`,
    })),

    remises: mien(data?.remises),
    annulations: mien(data?.annulations),
    inventaire: mien(data?.inventaire),
    livraisons,
    totalLivraisons: livraisons.reduce(
      (t, l) => ({ nb: t.nb + nb(l.nb), contacts: t.contacts + nb(l.contacts) }),
      { nb: 0, contacts: 0 },
    ),
    absents: (data?.absents ?? []).filter((a) => !restaurantId || a.restaurant_id === restaurantId),
  };
}
