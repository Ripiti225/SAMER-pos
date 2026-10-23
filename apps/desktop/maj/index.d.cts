// Types des fondations de la mise à jour à distance (apps/desktop/maj/*.cjs).
// Tenus à la main : le code reste en CommonJS pur pour être embarqué tel
// quel dans l'asar du lanceur, sans étape de compilation.
import type { KeyObject } from 'node:crypto';

// ---------------------------------------------------------------- erreurs
export declare class ErreurMaj extends Error {
  constructor(code: string, message: string, details?: unknown);
  code: string;
  details?: unknown;
  /** Posé par une opération d'installation pour dire « inutile de retenter ». */
  definitif?: boolean;
}

// ---------------------------------------------------------------- version
export interface VersionInstallee {
  numero: number;
  version: string;
  commit: string | null;
  publie_le?: string;
  /** Vrai si VERSION.json est absent (poste de développement) : numéro 0. */
  dev: boolean;
  /** Vrai si VERSION.json existe mais n'a pas pu être lu. */
  illisible?: boolean;
}
export interface ContenuVersion {
  numero: number;
  version: string;
  commit: string;
  publie_le?: string;
}
export declare const FICHIER_VERSION: 'VERSION.json';
export declare const RE_VERSION: RegExp;
export declare const VERSION_DEV: Readonly<VersionInstallee>;
export declare function versionTexteValide(texte: unknown): boolean;
export declare function formaterVersion(date: Date, rangDuJour: number): string;
export declare function validerVersion(obj: unknown): VersionInstallee;
export declare function lireVersion(dossierApp: string): VersionInstallee;
export declare function contenuVersion(v: ContenuVersion): ContenuVersion;
export declare function comparerVersions(a: { numero: number }, b: { numero: number }): number;
export declare function deciderMontee(
  installee: { numero: number },
  candidate: { numero: number },
): 'INSTALLER' | 'DEJA_INSTALLEE' | 'REFUSEE_INFERIEURE';

// ---------------------------------------------------------------- signature
export type ClePublique = string | KeyObject;
export interface Trousseau {
  actuelle: ClePublique;
  suivante?: ClePublique | null;
}
export declare function chargerClePublique(texte: ClePublique): KeyObject;
export declare function clePubliqueBrute(cle: ClePublique): string;
export declare function empreinteCle(cle: ClePublique): string;
export declare function genererPaire(): { clePublique: KeyObject; clePrivee: KeyObject };
export declare function genererPaire(options: { phrase: string }): { clePubliquePem: string; clePriveePemChiffree: string };
export declare function signer(octets: Uint8Array | string, clePrivee: KeyObject | string, phrase?: string): string;
export declare function verifier(octets: Uint8Array | string, signatureB64: string, clePublique: ClePublique): boolean;
export declare function verifierAvecTrousseau(
  octets: Uint8Array | string,
  signatureB64: string,
  trousseau: Trousseau,
): 'actuelle' | 'suivante' | null;

// ---------------------------------------------------------------- manifeste
export interface Empreinte {
  sha256: string;
  taille: number;
}
export interface Morceau extends Empreinte {
  nom: string;
}
export interface FichierManifeste extends Empreinte {
  chemin: string;
}
interface ManifesteCommun {
  format: 1;
  publie_le: string;
  node_min: string;
  archive: Empreinte;
  morceaux: Morceau[];
  fichiers: FichierManifeste[];
}
export interface ManifesteApp extends ManifesteCommun {
  type: 'APP';
  numero: number;
  version: string;
  commit: string;
  lanceur_min: number;
  dependances: { empreinte: string };
  migrations: { derniere: string | null; nouvelles: string[]; retrocompatibles: boolean };
  notes: string;
  /** Phase 3 : nouveau PosSamer.exe, présent dans l'archive à CHEMIN_LANCEUR. */
  lanceur?: { numero: number; sha256: string; taille: number };
}
export interface ManifesteDependances extends ManifesteCommun {
  type: 'DEPENDANCES';
  /** SHA-256 du pnpm-lock.yaml. */
  empreinte: string;
  notes?: string;
}
export type Manifeste = ManifesteApp | ManifesteDependances;

export declare const FORMAT_MANIFESTE: 1;
export declare const FICHIER_MANIFESTE: 'manifeste.json';
export declare const FICHIER_SIGNATURE: 'manifeste.json.sig';
export declare const CHEMIN_LANCEUR: '_lanceur/PosSamer.exe';
export declare const LIMITES: Readonly<{
  octetsManifeste: number;
  morceaux: number;
  fichiers: number;
  notes: number;
  octetsChemin: number;
}>;
/** Message d'erreur si le chemin est dangereux ou invalide, sinon null. */
export declare function problemeChemin(chemin: unknown): string | null;
export declare function validerManifeste(m: unknown): Manifeste;
export declare function lireManifeste(octets: Uint8Array): Manifeste;
export declare function serialiserManifeste(m: Manifeste): Buffer;
export declare function ouvrirManifesteSigne(
  octets: Uint8Array,
  signatureB64: string,
  trousseau: Trousseau,
): { manifeste: Manifeste; cle: 'actuelle' | 'suivante' };
export declare function problemesCompatibilite(m: Manifeste, poste: { lanceur: number; node: string }): string[];

// ---------------------------------------------------------------- archive
export declare const TAILLE_MORCEAU_DEFAUT: number;
export declare function ecrireArchive(options: {
  racine: string;
  chemins: string[];
  dossierSortie: string;
  prefixe?: string;
  tailleMorceau?: number;
  mtime?: number;
}): Promise<{ archive: Empreinte; morceaux: Morceau[]; fichiers: FichierManifeste[] }>;
export declare function verifierMorceaux(
  dossierMorceaux: string,
  manifeste: Manifeste,
): Promise<{ valides: string[]; invalides: { nom: string; raison: 'ABSENT' | 'TAILLE' | 'EMPREINTE' }[] }>;
export declare function extraireArchive(options: {
  dossierMorceaux: string;
  manifeste: Manifeste;
  destination: string;
}): Promise<void>;
export declare function verifierArbre(dossier: string, manifeste: Manifeste, options?: { ignorer?: string[] }): Promise<void>;

// ---------------------------------------------------------------- créneau
export type TypeSite = 'FERME_LA_NUIT' | 'H24';
export declare const TYPES_SITE: Readonly<{ FERME_LA_NUIT: 'FERME_LA_NUIT'; H24: 'H24' }>;
export interface ReglagesCreneau {
  heureInstallation: string;
  heureFilet: string;
  delaiFiletHeures: number;
  rattrapageMinutes: number;
  preavisMinutes: number;
  reportMinutes: number;
  rappelMinutes: number;
  fuseauMinutes: number;
}
export declare const REGLAGES_DEFAUT: Readonly<ReglagesCreneau>;
export interface EntreeCreneau extends Partial<ReglagesCreneau> {
  maintenant: Date;
  typeSite: TypeSite;
  pretLe: Date | null;
  auDemarrage: boolean;
  report?: { demandeLe: Date } | null;
  pause?: boolean;
  installerMaintenant?: boolean;
}
export interface DecisionCreneau {
  action: 'RIEN' | 'ATTENDRE' | 'AVERTIR' | 'INSTALLER';
  raison:
    | 'AUCUN_PAQUET'
    | 'PAUSE_SIEGE'
    | 'DEMANDE_SIEGE'
    | 'DEMARRAGE'
    | 'ECHEANCE_MANQUEE'
    | 'ECHEANCE'
    | 'FIN_DU_REPORT'
    | 'PREAVIS'
    | 'RAPPEL'
    | 'PLANIFIEE'
    | 'REPORTEE';
  echeance: Date | null;
  reportPossible: boolean;
  rappel: boolean;
  prochaineVerification: Date | null;
}
export declare function premiereOccurrence(instant: Date, heure: string, fuseauMinutes?: number): Date;
export declare function deciderCreneau(entree: EntreeCreneau): DecisionCreneau;
export declare function demanderReport(decision: DecisionCreneau, maintenant: Date): { demandeLe: Date };

// ---------------------------------------------------------------- installation
export type EtapeInstallation =
  | 'VERIFICATION'
  | 'ARRET'
  | 'SAUVEGARDE_BASE'
  | 'ECHANGE_CODE'
  | 'MIGRATIONS'
  | 'VALIDATION'
  | 'FINALISATION';
export type EtapeRetour = 'RETOUR_ARRET' | 'RETOUR_CODE' | 'RETOUR_BASE';
export type EtatInstallation = 'EN_COURS' | 'RETOUR_EN_COURS' | 'INSTALLEE' | 'REVENUE' | 'RETOUR_ECHOUE';
export interface JournalInstallation {
  format: 1;
  numero: number;
  version: string;
  etat: EtatInstallation;
  tentative: number;
  etape: EtapeInstallation | EtapeRetour | null;
  statut: 'COMMENCEE' | 'FINIE' | null;
  code_touche: boolean;
  base_touchee: boolean;
  retour: { etapes: EtapeRetour[]; tentatives: number; refuser: boolean } | null;
  erreur: { code: string; message: string; etape?: string } | null;
  refusees: number[];
  commence_le: string;
  maj_le: string;
  historique: { etape: string; statut: string; le: string }[];
  /** Champs libres ajoutés par le lanceur (chemin de la sauvegarde…). */
  [cle: string]: unknown;
}
export type JournalLu = JournalInstallation | { illisible: true; erreur: string } | null;
export type DecisionReprise =
  | { action: 'RIEN' }
  | { action: 'REPRENDRE'; depuis: EtapeInstallation; nouvelleTentative: boolean }
  | { action: 'REVENIR'; etapes: EtapeRetour[]; refuser: boolean }
  | { action: 'BLOQUE'; raison: 'JOURNAL_ILLISIBLE' | 'RETOUR_IMPOSSIBLE' | 'ETAT_INCONNU' };
export type Operations = Record<EtapeInstallation | EtapeRetour, (ctx: { journal: JournalInstallation }) => Promise<void> | void>;
export interface OptionsExecution {
  chemin: string;
  journal: JournalInstallation;
  operations: Partial<Operations>;
  horloge?: () => Date;
  ecrire?: (chemin: string, journal: JournalInstallation) => Promise<void>;
}

export declare const FICHIER_JOURNAL: 'installation.json';
export declare const ETAPES: readonly EtapeInstallation[];
export declare const ETAPES_RETOUR: readonly EtapeRetour[];
export declare const ETATS: Readonly<{ [K in EtatInstallation]: K }>;
export declare const TENTATIVES_MAX: number;
export declare const RETOURS_MAX: number;
export declare function estRefusee(journal: JournalLu, numero: number): boolean;
export declare function peutTenter(journal: JournalLu, numero: number, options?: { tentativesMax?: number }): boolean;
export declare function nouveauJournal(
  precedent: JournalLu,
  version: { numero: number; version: string; maintenant: Date },
  options?: { tentativesMax?: number },
): JournalInstallation;
export declare function marquerEtape(
  journal: JournalInstallation,
  etape: EtapeInstallation | EtapeRetour,
  statut: 'COMMENCEE' | 'FINIE',
  maintenant: Date,
): JournalInstallation;
export declare function etapesRetourPour(journal: JournalInstallation): EtapeRetour[];
export declare function deciderReprise(journal: JournalLu, options?: { tentativesMax?: number; retoursMax?: number }): DecisionReprise;
export declare function lireJournal(chemin: string): Promise<JournalLu>;
export declare function ecrireJournal(chemin: string, journal: JournalInstallation): Promise<void>;
export declare function executerInstallation(
  options: OptionsExecution & { depuis?: EtapeInstallation; tentativesMax?: number },
): Promise<{ resultat: 'INSTALLEE' | 'REVENUE' | 'RETOUR_ECHOUE'; journal: JournalInstallation }>;
export declare function executerRetour(
  options: OptionsExecution & { etapes?: EtapeRetour[]; refuser: boolean },
): Promise<JournalInstallation>;
export declare function journalPourReprise(
  journal: JournalInstallation,
  decision: { nouvelleTentative?: boolean },
  maintenant: Date,
): JournalInstallation;

// ---------------------------------------------------------------- rétention
export declare function nomSauvegarde(numero: number, date: Date): string;
export declare function lireNomSauvegarde(nom: string): { nom: string; numero: number; le: Date } | null;
export declare function choisirSauvegardesASupprimer(
  sauvegardes: { nom: string; le: Date }[],
  maintenant: Date,
  options?: { joursConservation?: number; minimum?: number; proteger?: string[] },
): string[];

// ---------------------------------------------------------------- disque
export declare function ecrireJsonAtomique(chemin: string, objet: unknown): Promise<void>;
export declare function renommerAvecReprises(source: string, cible: string, options?: { essais?: number; delaiMs?: number }): Promise<void>;
export declare function sha256Fichier(chemin: string): Promise<string>;
export declare function sha256(octets: Uint8Array | string): string;
export declare function attendre(ms: number): Promise<void>;

// ---------------------------------------------------------------- clés embarquées (L4)
export declare const FICHIER_CLES: 'cles-publiques.json';
export declare const MOTIF_SANS_CLE: string;
/** `trousseau` null = mise à jour désactivée, `motif` dit pourquoi. Ne lève jamais. */
export declare function chargerTrousseau(chemin?: string): { trousseau: Trousseau | null; motif: string | null };

// ---------------------------------------------------------------- dossier du site (contrat § 4)
export interface CheminsSite {
  racine: string;
  app: string;
  appPrecedente: string;
  data: string;
  pgdata: string;
  sauvegardes: string;
  maj: string;
  etat: string;
  journal: string;
  lanceur: string;
  telechargement: string;
  pret: string;
}
export interface ReglagesMaj {
  type_site: TypeSite;
  heure_installation: string;
  heure_filet: string;
  pause: boolean;
  installer_maintenant: string | null;
  reessayer: string | null;
}
export interface DependancesPretes {
  empreinte: string;
  /** Relatif au ROOT : `maj/pret/deps-<e>/node_modules`. */
  dossier: string;
  /** Ajouts au contrat minimal : de quoi revérifier les dépendances avant installation. */
  manifeste?: string;
  signature?: string;
}
export interface VersionPrete {
  numero: number;
  version: string;
  /** Relatif au ROOT : `maj/pret/<n>/app`. */
  dossier: string;
  pret_le: string;
  manifeste: string;
  signature: string;
  dependances: DependancesPretes | null;
}
export interface EtatSite {
  format: 1;
  pret: VersionPrete | null;
  reglages: ReglagesMaj | null;
  report: { demande_le: string; par: string; par_id?: string | null; numero: number } | null;
  jetons_traites: { installer_maintenant: string | null; reessayer: string | null };
  /** Champs libres du serveur (rapports déjà envoyés, dernière erreur…). */
  [cle: string]: unknown;
}
export interface MemoireLanceur {
  format: 1;
  jetons_traites: { installer_maintenant: string | null; reessayer: string | null };
}
export declare const FORMAT_ETAT: 1;
export declare const FICHIER_EMPREINTE_DEPS: '.empreinte-deps';
export declare const TAILLE_GRENAM: 533504;
export declare function cheminsSite(racine: string): CheminsSite;
export declare function resoudreDansRacine(racine: string, relatif: unknown): string | null;
export declare function etatVide(): EtatSite;
export declare function lireEtat(chemin: string): Promise<EtatSite>;
export declare function ecrireEtat(chemin: string, etat: EtatSite): Promise<void>;
export declare function lireMemoireLanceur(chemin: string): Promise<MemoireLanceur>;
export declare function lireEmpreinteDeps(dossierApp: string): string | null;
export declare function tailleDossier(dossier: string): Promise<number>;
export declare function espaceLibre(chemin: string): Promise<number | null>;
export declare function chercherSuspectsGrenam(racine: string, options?: { limite?: number; ignorer?: string[] }): Promise<string[]>;

// ---------------------------------------------------------------- opérations réelles (L4)
export interface ProcessusLanceur {
  arreterApi(): Promise<void>;
  arreterVite(): Promise<void>;
  arreterServeur(): Promise<void>;
  arreterPg(): Promise<void>;
  demarrerPg(): Promise<void>;
  migrer(): Promise<void>;
  demarrerServeur(o: { validation: boolean }): Promise<{ vivant(): boolean }>;
  validerServeur(): Promise<void>;
  serveurActif(): boolean;
}
export declare const DELAIS_DEFAUT: Readonly<{
  santeTotalMs: number;
  santeVivantApresMs: number;
  santeIntervalleMs: number;
  renommageEssais: number;
  renommageDelaiMs: number;
}>;
export declare const MARQUEUR_COMPLET: 'COMPLET';
export declare function creerOperations(o: {
  racine: string;
  trousseau: Trousseau | null;
  numeroLanceur: number;
  versionNode: () => Promise<string>;
  processus: ProcessusLanceur;
  port: number;
  delais?: Partial<typeof DELAIS_DEFAUT>;
  margeEspaceOctets?: number;
  horloge?: () => Date;
  log?: (m: string) => void;
  progression?: (texte: string) => void;
  pointCoupure?: (point: string) => Promise<void> | void;
  mesurerEspace?: (chemin: string) => Promise<number | null>;
}): { operations: Operations; nettoyer(o?: { numero?: number; proteger?: string[] }): Promise<void> };
export declare function controlerSante(o: {
  port: number;
  hote?: string;
  numero: number;
  estVivant?: () => boolean;
  totalMs?: number;
  vivantApresMs?: number;
  intervalleMs?: number;
  maintenant?: () => number;
}): Promise<void>;
export declare function rafraichirCopiesPos(arbre: string): Promise<number>;
export declare function fichiersPropresAuSite(arbre: string): Promise<string[]>;
export declare function emplacementsNodeModules(arbre: string): Promise<string[]>;

// ---------------------------------------------------------------- orchestration (L4)
export interface SituationInstallation {
  pret: VersionPrete | null;
  decision: DecisionCreneau | null;
  raison: string | null;
  installerMaintenant: string | null;
}
export declare function situationInstallation(e: {
  etat: EtatSite;
  journal: JournalLu;
  memoire: MemoireLanceur | null;
  installee: { numero: number };
  maintenant: Date;
  auDemarrage: boolean;
  tentativesMax?: number;
}): SituationInstallation;
export type ResultatLanceur =
  | { action: 'RIEN'; raison: string | null; decision: DecisionCreneau | null }
  | { action: 'OCCUPE' }
  | { action: 'BLOQUE'; raison: string; journal: JournalLu }
  | { action: 'REPRISE' | 'INSTALLATION'; resultat: 'INSTALLEE' | 'REVENUE' | 'RETOUR_ECHOUE'; journal: JournalInstallation }
  | { action: 'RETOUR'; resultat: EtatInstallation; journal: JournalInstallation };
export declare function creerLanceurMaj(o: {
  racine: string;
  trousseau: Trousseau | null;
  motifSansCle?: string | null;
  operations: Operations;
  nettoyer?: (o: { numero?: number; proteger?: string[] }) => Promise<void>;
  horloge?: () => Date;
  log?: (m: string) => void;
  avantInstallation?: (info: { numero: number; version: string; reprise: boolean; auDemarrage: boolean }) => void | Promise<void>;
}): {
  auDemarrage(): Promise<ResultatLanceur>;
  verifierCreneau(): Promise<ResultatLanceur>;
  examiner(o: { auDemarrage: boolean }): Promise<SituationInstallation & { motif?: string | null }>;
  readonly enCours: boolean;
};
