/**
 * Écran « Mises à jour » — formes renvoyées par l'action `maj_historique` de la
 * fonction `siege` (supabase/functions/siege/maj.ts), et ce que l'écran en tire.
 * Logique pure, testée par vitest ; l'écran ne fait qu'afficher.
 */

export type StatutVersion = 'BROUILLON' | 'PILOTE' | 'GENERALE' | 'RETIREE';

export interface VersionMaj {
  numero: number;
  version: string;
  commit_git: string;
  statut: StatutVersion;
  taille_octets: number;
  dependances_empreinte: string;
  lanceur_min: number;
  migrations: { derniere?: string | null; nouvelles?: string[]; retrocompatibles?: boolean } | null;
  notes: string;
  cle_empreinte: string | null;
  publie_le: string;
  publie_par: string | null;
  pilote_le: string | null;
  generale_le: string | null;
  retiree_le: string | null;
  retiree_motif: string | null;
  fichiers_purges_le: string | null;
}

export interface ReglagesMaj {
  type_site: 'FERME_LA_NUIT' | 'H24';
  heure_installation: string;
  heure_filet: string;
  anneau: 'PILOTE' | 'GENERAL';
  pause: boolean;
  version_epinglee: number | null;
  installer_maintenant: string | null;
  reessayer: string | null;
  installer_maintenant_le?: string | null;
  reessayer_le?: string | null;
  maj_le?: string | null;
  maj_par?: string | null;
}

export interface SiteMaj {
  restaurant_id: string;
  code: string;
  actif: boolean;
  reglages: ReglagesMaj;
  cible: { numero: number; version: string; raison: 'EPINGLEE' | 'PILOTE' | 'GENERALE' } | null;
}

export interface RapportMaj {
  id: number;
  restaurant_id: string;
  numero: number | null;
  evenement: string;
  detail: Record<string, unknown>;
  recu_le: string;
}

export interface ReponseHistorique {
  migration_absente: boolean;
  proprietaire: boolean;
  cle_publique_empreinte: string | null;
  versions: VersionMaj[];
  dependances: { empreinte: string; taille_octets: number; publie_le: string; publie_par: string | null; fichiers_purges_le: string | null }[];
  rapports: RapportMaj[];
  sites: SiteMaj[];
}

export const LIBELLE_STATUT: Record<StatutVersion, { texte: string; classe: string }> = {
  BROUILLON: { texte: 'Brouillon', classe: 'bg-carte-douce text-doux' },
  PILOTE: { texte: 'Pilote', classe: 'bg-info-tint text-info-txt' },
  GENERALE: { texte: 'Générale', classe: 'bg-ok-tint text-ok-txt' },
  RETIREE: { texte: 'Retirée', classe: 'bg-alerte-tint text-alerte-txt' },
};

/** Les événements du contrat (docs/MAJ_CONTRAT.md § 2), en français courant. */
export const LIBELLE_EVENEMENT: Record<string, { texte: string; grave: boolean }> = {
  TELECHARGEMENT: { texte: 'Téléchargement commencé', grave: false },
  PRET: { texte: 'Prête à installer', grave: false },
  AVERTI: { texte: 'Caisse prévenue', grave: false },
  REPORTE: { texte: 'Reportée par le gérant', grave: false },
  DEBUT: { texte: 'Installation commencée', grave: false },
  INSTALLE: { texte: 'Installée', grave: false },
  ECHEC_RETOUR_ARRIERE: { texte: 'Échec : retour à l’ancienne version', grave: true },
  REFUSEE: { texte: 'Refusée par le poste', grave: true },
  BLOQUE: { texte: 'Poste bloqué : intervention nécessaire', grave: true },
  ESPACE_INSUFFISANT: { texte: 'Disque plein', grave: true },
  LANCEUR_TROP_ANCIEN: { texte: 'PosSamer.exe trop ancien', grave: true },
  SIGNATURE_INVALIDE: { texte: 'Signature invalide', grave: true },
  ERREUR: { texte: 'Erreur', grave: true },
};

export function libelleEvenement(e: string): { texte: string; grave: boolean } {
  return LIBELLE_EVENEMENT[e] ?? { texte: e, grave: false };
}

/** Taille lisible : « 3,4 Mo ». */
export function taille(octets: number | null | undefined): string {
  if (!octets || octets < 0) return '—';
  if (octets < 1024 * 1024) return `${Math.max(1, Math.round(octets / 1024))} Ko`;
  return `${(octets / (1024 * 1024)).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
}

/** Ce que le propriétaire peut faire d'une version, dans l'ordre du cycle de vie. */
export function actionsPossibles(v: Pick<VersionMaj, 'statut'>): ('PILOTE' | 'GENERALE' | 'RETIRER')[] {
  if (v.statut === 'BROUILLON') return ['PILOTE', 'RETIRER'];
  if (v.statut === 'PILOTE') return ['GENERALE', 'RETIRER'];
  if (v.statut === 'GENERALE') return ['RETIRER'];
  return [];
}

/** Une phrase courte tirée du détail d'un compte rendu (cause, étape, erreur…). */
export function resumeDetail(detail: Record<string, unknown> | null | undefined): string | null {
  if (!detail) return null;
  for (const cle of ['message', 'cause', 'erreur', 'raison', 'etape', 'extrait']) {
    const v = detail[cle];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
  }
  return null;
}

/** Les versions qu'on peut épingler sur un site (jamais un brouillon ni une retirée). */
export function versionsEpinglables(versions: VersionMaj[]): VersionMaj[] {
  return versions.filter((v) => (v.statut === 'PILOTE' || v.statut === 'GENERALE') && !v.fichiers_purges_le);
}
