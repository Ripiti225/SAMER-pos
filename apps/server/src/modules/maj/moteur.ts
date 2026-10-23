/**
 * Moteur de mise à jour côté SERVEUR (lot L3, plan § 3 « Sur le site »).
 *
 * Toutes les 15 min : demande au cloud la version que ce site doit avoir,
 * la télécharge en arrière-plan, vérifie signature et empreintes, l'extrait
 * dans `ROOT/maj/pret/<n>/app` et l'annonce dans `ROOT/maj/etat.json`. Il ne
 * touche JAMAIS `app/` en place : c'est le lanceur qui installe.
 *
 * Toutes les 60 s : recalcule le créneau (même fonction pure que le lanceur,
 * `situationInstallation`) pour le bandeau de la caisse — un événement
 * WebSocket `maj` part dès que la décision change (préavis à H-10, rappel).
 *
 * Comme la synchro : une panne ici ne bloque jamais une vente. Toutes les
 * erreurs finissent dans `derniereErreur` (battement → Santé des sites) et,
 * pour celles que le siège doit voir, dans un compte rendu `rapporter`.
 */
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ErreurMetier } from '../../lib/erreurs.js';
import { chargerConfigSync } from '../sync/config.js';
import {
  ErreurMaj,
  chargerTrousseau,
  chercherSuspectsGrenam,
  deciderMontee,
  demanderReport,
  ecrireEtat,
  espaceLibre,
  estRefusee,
  extraireArchive,
  lireEmpreinteDeps,
  lireEtat,
  lireJournal,
  lireMemoireLanceur,
  ouvrirManifesteSigne,
  problemesCompatibilite,
  situationInstallation,
  tailleDossier,
  type CheminsSite,
  type DecisionCreneau,
  type EtatSite,
  type JournalLu,
  type Manifeste,
  type ManifesteApp,
  type MemoireLanceur,
  type SituationInstallation,
  type Trousseau,
  type VersionInstallee,
} from './fondations.js';
import { ClientMaj, ErreurCloudMaj, type CibleMaj, type EvenementMaj } from './client.js';
import { ErreurUrlExpiree, telechargerPaquet } from './telechargement.js';
import { etatMode } from './mode.js';
import { REGLAGES_PAR_DEFAUT } from './config.js';

const MO = 1024 * 1024;
const MARGE_ESPACE = 500 * MO;
const RAPPORTS_GARDES = 100;

export type EtatMajSite = 'A_JOUR' | 'TELECHARGEMENT' | 'PRETE' | 'REPORTEE' | 'INSTALLATION' | 'ECHEC' | 'REFUSEE';
type Phase = 'INACTIF' | 'A_JOUR' | 'TELECHARGEMENT' | 'PRETE' | 'ECHEC' | 'REFUSEE';
export type EvenementWsMaj = 'maj' | 'maj_debut' | 'maj_terminee';

/** Bloc `sante.maj` du battement (contrat § 3). */
export interface BlocSanteMaj {
  etat: EtatMajSite;
  numero_installe: number;
  numero_prete: number | null;
  installation_prevue: string | null;
  report_jusqua: string | null;
  derniere_erreur: string | null;
  espace_libre_mo: number | null;
  taille_pgdata_mo: number | null;
  integrite: { suspects_grenam: number | null };
}

/** Ce que lit le bandeau de la caisse (`GET /api/maj/etat`). */
export interface VueMaj {
  actif: boolean;
  mode: typeof etatMode.mode;
  etat: EtatMajSite;
  installee: { numero: number; version: string };
  prete: { numero: number; version: string } | null;
  decision: null | {
    action: DecisionCreneau['action'];
    raison: DecisionCreneau['raison'];
    echeance: string | null;
    report_possible: boolean;
    rappel: boolean;
  };
}

export interface DependancesMoteur {
  chemins: CheminsSite;
  /** Client cloud, null si la synchro n'est pas configurée (site non enrôlé). */
  client: () => Promise<ClientMaj | null>;
  trousseau: () => { trousseau: Trousseau | null; motif: string | null };
  versionInstallee: VersionInstallee;
  lanceurNumero: number;
  versionNode: string;
  debitMax: number;
  diffuser: (type: EvenementWsMaj) => void;
  horloge?: () => Date;
  mesurerEspace?: (chemin: string) => Promise<number | null>;
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

const existe = (p: string) => stat(p).then(() => true, () => false);
const jour = (d: Date) => d.toISOString().slice(0, 10);

/** Une erreur « attendue » (réseau, stockage) n'est pas un incident à remonter au siège à chaque cycle. */
function estPassagere(e: unknown): boolean {
  return e instanceof ErreurUrlExpiree || (e instanceof ErreurMaj && e.code === 'RESEAU') || (e instanceof ErreurCloudMaj && e.statut === 0);
}

export class MoteurMaj {
  phase: Phase = 'INACTIF';
  derniereErreur: string | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private arrete = true;
  private cycleEnCours: Promise<void> | null = null;
  private verrouEtat: Promise<unknown> = Promise.resolve();
  private signatureCreneau = '';
  private suspectsGrenam: number | null = null;
  private taillePg: { valeur: number; le: number } | null = null;
  private readonly horloge: () => Date;
  private readonly log: (m: string) => void;

  constructor(private readonly d: DependancesMoteur) {
    this.horloge = d.horloge ?? (() => new Date());
    this.log = d.log ?? ((m) => console.log(`[maj] ${m}`));
  }

  // ------------------------------------------------------------------ boucles

  demarrer(intervalleMs: number): void {
    this.arrete = false;
    const boucle = async () => {
      await this.cycle();
      this.planifier(boucle, intervalleMs);
    };
    const creneau = async () => {
      await this.tickCreneau().catch((e) => this.log(`créneau : ${(e as Error).message}`));
      this.planifier(creneau, 60_000);
    };
    const integrite = async () => {
      await this.analyserIntegrite();
      this.planifier(integrite, 6 * 3600_000);
    };
    // Premier passage peu après le démarrage : pas en même temps que le
    // rechargement des sessions et la première synchro.
    this.planifier(boucle, 60_000);
    this.planifier(creneau, 5_000);
    this.planifier(integrite, 120_000);
  }

  arreter(): void {
    this.arrete = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private planifier(fn: () => Promise<void>, delai: number): void {
    if (this.arrete) return;
    const t = setTimeout(() => void fn(), delai);
    t.unref?.();
    this.timers.push(t);
  }

  async analyserIntegrite(): Promise<number> {
    try {
      this.suspectsGrenam = (await chercherSuspectsGrenam(this.d.chemins.racine)).length;
    } catch (e) {
      this.log(`sentinelle Grenam : ${(e as Error).message}`);
    }
    return this.suspectsGrenam ?? 0;
  }

  // ------------------------------------------------------------------ etat.json

  /** Lecture-modification-écriture d'etat.json, une à la fois (la boucle et les routes écrivent). */
  private modifierEtat<T>(fn: (etat: EtatSite) => T | Promise<T>): Promise<T> {
    const suite = this.verrouEtat.then(async () => {
      await mkdir(this.d.chemins.maj, { recursive: true });
      const etat = await lireEtat(this.d.chemins.etat);
      const r = await fn(etat);
      await ecrireEtat(this.d.chemins.etat, etat);
      return r;
    });
    this.verrouEtat = suite.catch(() => undefined);
    return suite;
  }

  private async lire(): Promise<{ etat: EtatSite; journal: JournalLu; memoire: MemoireLanceur }> {
    const [etat, journal, memoire] = await Promise.all([
      lireEtat(this.d.chemins.etat),
      lireJournal(this.d.chemins.journal),
      lireMemoireLanceur(this.d.chemins.lanceur),
    ]);
    return { etat, journal, memoire };
  }

  async situation(): Promise<{ etat: EtatSite; journal: JournalLu; s: SituationInstallation }> {
    const { etat, journal, memoire } = await this.lire();
    const s = situationInstallation({
      etat,
      journal,
      memoire,
      installee: this.d.versionInstallee,
      maintenant: this.horloge(),
      auDemarrage: false,
    });
    return { etat, journal, s };
  }

  // ------------------------------------------------------------------ rapports

  /** Envoie un compte rendu une seule fois par `cle` (retenté au cycle suivant s'il n'est pas parti). */
  private async rapporterUneFois(
    client: ClientMaj | null,
    cle: string,
    numero: number,
    evenement: EvenementMaj,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    if (!client) return;
    const etat = await lireEtat(this.d.chemins.etat);
    const envoyes = Array.isArray(etat.rapports_envoyes) ? (etat.rapports_envoyes as string[]) : [];
    if (envoyes.includes(cle)) return;
    try {
      await client.rapporter(numero, evenement, detail);
    } catch (e) {
      this.log(`rapport ${evenement} non envoyé : ${(e as Error).message}`);
      return;
    }
    await this.modifierEtat((e) => {
      const liste = Array.isArray(e.rapports_envoyes) ? (e.rapports_envoyes as string[]) : [];
      e.rapports_envoyes = [...liste.filter((c) => c !== cle), cle].slice(-RAPPORTS_GARDES);
    });
  }

  /** Comptes rendus de ce qu'a fait le LANCEUR (il ne parle pas au cloud). */
  async rapporterJournal(client: ClientMaj | null): Promise<void> {
    const j = await lireJournal(this.d.chemins.journal);
    if (!j) return;
    if ('illisible' in j) {
      await this.rapporterUneFois(client, `journal-illisible:${jour(this.horloge())}`, this.d.versionInstallee.numero, 'BLOQUE', { cause: 'JOURNAL_ILLISIBLE', erreur: j.erreur });
      return;
    }
    const duree_s = Math.round((Date.parse(j.maj_le) - Date.parse(j.commence_le)) / 1000);
    const detail = { version: j.version, tentative: j.tentative, etape: j.erreur?.etape ?? j.etape, erreur: j.erreur, duree_s };
    if (j.etat === 'INSTALLEE') {
      await this.rapporterUneFois(client, `installe:${j.numero}`, j.numero, 'INSTALLE', detail);
    } else if (j.etat === 'REVENUE') {
      const code = j.erreur?.code;
      const evenement: EvenementMaj = code === 'SIGNATURE_INVALIDE' ? 'SIGNATURE_INVALIDE' : code === 'ESPACE_INSUFFISANT' ? 'ESPACE_INSUFFISANT' : 'ECHEC_RETOUR_ARRIERE';
      await this.rapporterUneFois(client, `revenue:${j.numero}:${j.tentative}:${j.commence_le}`, j.numero, evenement, detail);
      if (estRefusee(j, j.numero)) await this.rapporterUneFois(client, `refusee:${j.numero}`, j.numero, 'REFUSEE', detail);
    } else if (j.etat === 'RETOUR_ECHOUE') {
      await this.rapporterUneFois(client, `bloque:${j.numero}:${j.commence_le}`, j.numero, 'BLOQUE', detail);
    }
  }

  // ------------------------------------------------------------------ cycle

  /** Un passage complet (exposé pour les tests). Jamais deux en même temps. */
  cycle(): Promise<void> {
    if (!this.cycleEnCours) {
      this.cycleEnCours = this.cycleInterne()
        .catch((e) => {
          this.derniereErreur = (e as Error).message;
          this.log(`cycle : ${(e as Error).stack ?? e}`);
        })
        .finally(() => {
          this.cycleEnCours = null;
        });
    }
    return this.cycleEnCours;
  }

  private async cycleInterne(): Promise<void> {
    if (etatMode.mode !== 'NORMAL') return;
    const client = await this.d.client();
    if (!client) {
      this.phase = 'INACTIF';
      this.derniereErreur = 'Mise à jour à distance inactive : ce poste n’est pas relié au cloud.';
      return;
    }
    await this.rapporterJournal(client);
    const installee = this.d.versionInstallee;
    let reponse = await client.consulter({ numero: installee.numero, version: installee.version }, this.d.lanceurNumero);
    for (let essai = 0; ; essai++) {
      await this.enregistrerReponse(reponse);
      try {
        await this.traiterCible(client, reponse.cible);
        return;
      } catch (e) {
        // Lien signé expiré (1 h) au milieu d'un long téléchargement : on
        // redemande des liens frais, une fois par cycle.
        if (e instanceof ErreurUrlExpiree && essai === 0) {
          reponse = await client.consulter({ numero: installee.numero, version: installee.version }, this.d.lanceurNumero);
          continue;
        }
        throw e;
      }
    }
  }

  private async enregistrerReponse(reponse: { reglages?: EtatSite['reglages'] }): Promise<void> {
    const memoire = await lireMemoireLanceur(this.d.chemins.lanceur);
    await this.modifierEtat((e) => {
      e.reglages = { ...REGLAGES_PAR_DEFAUT, ...(reponse.reglages ?? {}) };
      e.jetons_traites = { ...memoire.jetons_traites };
      e.consulte_le = this.horloge().toISOString();
    });
  }

  private async abandonnerPret(): Promise<void> {
    await this.modifierEtat((e) => {
      e.pret = null;
      e.report = null;
    });
  }

  private async traiterCible(client: ClientMaj, cible: CibleMaj | null): Promise<void> {
    const installee = this.d.versionInstallee;
    if (!cible || cible.numero <= installee.numero) {
      // Rien à faire (ou plus rien : version retirée par le siège).
      const { etat } = await this.lire();
      if (etat.pret) await this.abandonnerPret();
      await this.nettoyer(null, null);
      this.phase = 'A_JOUR';
      this.derniereErreur = null;
      return;
    }
    const n = cible.numero;
    const { trousseau, motif } = this.d.trousseau();
    if (!trousseau) {
      this.phase = 'ECHEC';
      this.derniereErreur = motif;
      await this.rapporterUneFois(client, `cle-absente:${n}`, n, 'ERREUR', { cause: 'CLE_PUBLIQUE_ABSENTE', message: motif });
      return;
    }

    let m: ManifesteApp;
    try {
      const ouvert = ouvrirManifesteSigne(Buffer.from(cible.manifeste ?? '', 'utf8'), cible.signature, trousseau).manifeste;
      if (ouvert.type !== 'APP' || ouvert.numero !== n) throw new ErreurMaj('MANIFESTE_INVALIDE', 'Le manifeste ne correspond pas à la version annoncée par le cloud.');
      m = ouvert;
    } catch (e) {
      this.phase = 'ECHEC';
      this.derniereErreur = (e as Error).message;
      const signature = e instanceof ErreurMaj && e.code === 'SIGNATURE_INVALIDE';
      await this.rapporterUneFois(client, `${signature ? 'signature' : 'manifeste'}:${n}`, n, signature ? 'SIGNATURE_INVALIDE' : 'ERREUR', {
        cause: (e as ErreurMaj).code ?? 'ERREUR',
        message: (e as Error).message,
      });
      return;
    }
    if (deciderMontee(installee, m) !== 'INSTALLER') return;

    const { etat, journal, memoire } = await this.lire();
    const jetonReessai = etat.reglages?.reessayer;
    const reessaiEnAttente = !!jetonReessai && jetonReessai !== memoire.jetons_traites.reessayer;
    if (journal && !('illisible' in journal) && estRefusee(journal, n) && !reessaiEnAttente) {
      this.phase = 'REFUSEE';
      this.derniereErreur = journal.erreur?.message ?? 'Version refusée sur ce poste.';
      return;
    }

    const problemes = problemesCompatibilite(m, { lanceur: this.d.lanceurNumero, node: this.d.versionNode });
    if (problemes.length > 0) {
      this.phase = 'ECHEC';
      this.derniereErreur = problemes.join(' ');
      const lanceur = !(this.d.lanceurNumero >= m.lanceur_min);
      await this.rapporterUneFois(client, `${lanceur ? 'lanceur' : 'node'}:${n}`, n, lanceur ? 'LANCEUR_TROP_ANCIEN' : 'ERREUR', {
        lanceur_numero: this.d.lanceurNumero,
        lanceur_min: m.lanceur_min,
        node: this.d.versionNode,
        message: this.derniereErreur,
      });
      return;
    }

    // Dépendances : seulement si l'empreinte du pnpm-lock change.
    const besoinDeps = m.dependances.empreinte !== lireEmpreinteDeps(this.d.chemins.app);
    let mDeps: Manifeste | null = null;
    if (besoinDeps) {
      if (!cible.dependances) {
        this.phase = 'ECHEC';
        this.derniereErreur = 'Cette version demande de nouvelles dépendances, mais le cloud ne les fournit pas.';
        await this.rapporterUneFois(client, `deps-absentes:${n}`, n, 'ERREUR', { cause: 'DEPENDANCES_ABSENTES' });
        return;
      }
      try {
        mDeps = ouvrirManifesteSigne(Buffer.from(cible.dependances.manifeste ?? '', 'utf8'), cible.dependances.signature, trousseau).manifeste;
        if (mDeps.type !== 'DEPENDANCES' || mDeps.empreinte !== m.dependances.empreinte) {
          throw new ErreurMaj('MANIFESTE_INVALIDE', 'Le paquet de dépendances ne correspond pas à cette version.');
        }
      } catch (e) {
        this.phase = 'ECHEC';
        this.derniereErreur = (e as Error).message;
        const signature = e instanceof ErreurMaj && e.code === 'SIGNATURE_INVALIDE';
        await this.rapporterUneFois(client, `deps-${signature ? 'signature' : 'manifeste'}:${n}`, n, signature ? 'SIGNATURE_INVALIDE' : 'ERREUR', {
          cause: (e as ErreurMaj).code,
          paquet: 'DEPENDANCES',
          message: (e as Error).message,
        });
        return;
      }
    }

    const relApp = `maj/pret/${n}/app`;
    const dossierApp = join(this.d.chemins.pret, String(n), 'app');
    const empreinteDeps = mDeps && mDeps.type === 'DEPENDANCES' ? mDeps.empreinte : null;
    const racineDeps = empreinteDeps ? join(this.d.chemins.pret, `deps-${empreinteDeps}`) : null;

    // Déjà prêt ? (le lanceur revérifiera tout de toute façon)
    if (
      etat.pret?.numero === n &&
      (await existe(dossierApp)) &&
      (!racineDeps || (await existe(join(racineDeps, 'node_modules'))))
    ) {
      this.phase = 'PRETE';
      this.derniereErreur = null;
      await this.nettoyer(n, empreinteDeps);
      return;
    }
    if (etat.pret && etat.pret.numero !== n) await this.abandonnerPret();

    // Espace disque : morceaux + arbre extrait (+ dépendances) + la future
    // sauvegarde de pgdata que fera le lanceur, et une marge.
    const tailleArbre = (x: Manifeste) => x.archive.taille + x.fichiers.reduce((s, f) => s + f.taille, 0);
    const besoin = tailleArbre(m) + (mDeps ? tailleArbre(mDeps) : 0) + (await this.taillePgdata()) + MARGE_ESPACE;
    const libre = await (this.d.mesurerEspace ?? espaceLibre)(this.d.chemins.racine);
    if (libre !== null && libre < besoin) {
      this.phase = 'ECHEC';
      this.derniereErreur = `Espace disque insuffisant pour la mise à jour : ${Math.round(libre / MO)} Mo libres, ${Math.round(besoin / MO)} Mo nécessaires.`;
      await this.rapporterUneFois(client, `espace:${n}:${jour(this.horloge())}`, n, 'ESPACE_INSUFFISANT', {
        libre_mo: Math.round(libre / MO),
        besoin_mo: Math.round(besoin / MO),
      });
      return;
    }

    this.phase = 'TELECHARGEMENT';
    this.derniereErreur = null;
    await this.rapporterUneFois(client, `telechargement:${n}`, n, 'TELECHARGEMENT', { version: m.version, deps: besoinDeps });
    try {
      await this.nettoyer(n, empreinteDeps);
      // 1. dépendances (rares, lourdes) d'abord : une version n'est « prête »
      //    que si tout ce qu'il lui faut est là.
      if (mDeps && racineDeps && empreinteDeps && cible.dependances) {
        if (!(await existe(join(racineDeps, 'node_modules')))) {
          const dlDeps = join(this.d.chemins.telechargement, `deps-${empreinteDeps}`);
          await mkdir(dlDeps, { recursive: true });
          await telechargerPaquet(dlDeps, mDeps, new Map(cible.dependances.morceaux.map((x) => [x.nom, x.url])), {
            debitMax: this.d.debitMax,
            fetch: this.d.fetch,
          });
          await this.extraireVers(dlDeps, mDeps, racineDeps);
          await rm(dlDeps, { recursive: true, force: true });
        }
      }
      // 2. le code
      const dl = join(this.d.chemins.telechargement, String(n));
      await mkdir(dl, { recursive: true });
      await telechargerPaquet(dl, m, new Map(cible.morceaux.map((x) => [x.nom, x.url])), { debitMax: this.d.debitMax, fetch: this.d.fetch });
      await this.extraireVers(dl, m, dossierApp);
    } catch (e) {
      if (e instanceof ErreurUrlExpiree) throw e;
      this.derniereErreur = `Téléchargement de la mise à jour : ${(e as Error).message}`;
      if (!estPassagere(e)) {
        this.phase = 'ECHEC';
        await this.rapporterUneFois(client, `erreur:${n}:${(e as ErreurMaj).code ?? 'ERREUR'}:${jour(this.horloge())}`, n, 'ERREUR', {
          cause: (e as ErreurMaj).code ?? 'ERREUR',
          message: (e as Error).message,
        });
      }
      return;
    }

    const pret_le = this.horloge().toISOString();
    await this.modifierEtat((e) => {
      e.pret = {
        numero: n,
        version: m.version,
        dossier: relApp,
        pret_le,
        manifeste: cible.manifeste,
        signature: cible.signature,
        dependances:
          empreinteDeps && cible.dependances
            ? {
                empreinte: empreinteDeps,
                dossier: `maj/pret/deps-${empreinteDeps}/node_modules`,
                manifeste: cible.dependances.manifeste,
                signature: cible.dependances.signature,
              }
            : null,
      };
      if (e.report && e.report.numero !== n) e.report = null;
    });
    // Le téléchargement est vérifié et extrait : les morceaux ne servent plus.
    await rm(join(this.d.chemins.telechargement, String(n)), { recursive: true, force: true }).catch(() => {});
    this.phase = 'PRETE';
    this.log(`version ${m.version} prête`);
    await this.rapporterUneFois(client, `pret:${n}`, n, 'PRET', { version: m.version, pret_le });
    this.d.diffuser('maj');
  }

  /** Extraction via un dossier `.partiel`, renommé seulement une fois tout vérifié. */
  private async extraireVers(dossierMorceaux: string, manifeste: Manifeste, destination: string): Promise<void> {
    const partiel = `${destination}.partiel`;
    await rm(partiel, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
    await mkdir(join(destination, '..'), { recursive: true });
    await extraireArchive({ dossierMorceaux, manifeste, destination: partiel });
    await rename(partiel, destination);
  }

  /** Supprime les préparations et téléchargements d'autres versions : on ne garde que la plus haute (la cible). */
  private async nettoyer(numero: number | null, empreinteDeps: string | null): Promise<void> {
    const garder = new Set<string>();
    if (numero !== null) garder.add(String(numero));
    if (empreinteDeps) garder.add(`deps-${empreinteDeps}`);
    const { etat } = await this.lire();
    if (etat.pret) garder.add(String(etat.pret.numero));
    if (etat.pret?.dependances) garder.add(`deps-${etat.pret.dependances.empreinte}`);
    for (const dossier of [this.d.chemins.pret, this.d.chemins.telechargement]) {
      let noms: string[] = [];
      try {
        noms = await readdir(dossier);
      } catch {
        continue;
      }
      for (const nom of noms) {
        if (!garder.has(nom.replace(/\.partiel$/, ''))) await rm(join(dossier, nom), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private async taillePgdata(): Promise<number> {
    const maintenant = Date.now();
    if (!this.taillePg || maintenant - this.taillePg.le > 3600_000) {
      this.taillePg = { valeur: await tailleDossier(this.d.chemins.pgdata), le: maintenant };
    }
    return this.taillePg.valeur;
  }

  // ------------------------------------------------------------------ créneau, report

  private etatSite(journal: JournalLu, s: SituationInstallation): EtatMajSite {
    if (etatMode.mode === 'ARRET') return 'INSTALLATION';
    if (journal && !('illisible' in journal) && (journal.etat === 'EN_COURS' || journal.etat === 'RETOUR_EN_COURS')) return 'INSTALLATION';
    if (s.pret && s.decision) {
      return ['REPORTEE', 'RAPPEL', 'FIN_DU_REPORT'].includes(s.decision.raison) ? 'REPORTEE' : 'PRETE';
    }
    if (s.raison === 'REFUSEE' || s.raison === 'TENTATIVES_EPUISEES' || this.phase === 'REFUSEE') return 'REFUSEE';
    if (this.phase === 'ECHEC') return 'ECHEC';
    if (this.phase === 'TELECHARGEMENT') return 'TELECHARGEMENT';
    return 'A_JOUR';
  }

  /** Toutes les 60 s : prévient les caisses quand la décision change (bandeau à H-10, rappel). */
  async tickCreneau(): Promise<void> {
    if (etatMode.mode !== 'NORMAL') return;
    const { s } = await this.situation();
    const d = s.decision;
    const signature = d ? `${s.pret?.numero}|${d.action}|${d.raison}|${d.echeance?.toISOString()}|${d.reportPossible}` : `${s.raison}`;
    if (signature === this.signatureCreneau) return;
    this.signatureCreneau = signature;
    this.d.diffuser('maj');
    if (d && s.pret && d.action === 'AVERTIR') {
      const client = await this.d.client().catch(() => null);
      await this.rapporterUneFois(client, `averti:${s.pret.numero}:${d.echeance?.toISOString()}`, s.pret.numero, 'AVERTI', {
        echeance: d.echeance?.toISOString() ?? null,
        rappel: d.rappel,
      });
    }
  }

  /** « Pas maintenant » : un seul report de 30 min, seulement pendant le préavis. */
  async reporter(par: { nom: string; id: string | null }): Promise<VueMaj> {
    const { etat, s } = await this.situation();
    const d = s.decision;
    if (!s.pret || !d) throw new ErreurMetier('Aucune mise à jour n’est prévue sur ce poste', 409);
    if (etat.report && etat.report.numero === s.pret.numero) {
      throw new ErreurMetier('La mise à jour a déjà été reportée une fois : elle ne peut plus l’être', 409);
    }
    if (d.action !== 'AVERTIR') {
      throw new ErreurMetier('La mise à jour ne peut être reportée que dans les 10 minutes qui précèdent son heure', 409);
    }
    let report;
    try {
      report = demanderReport(d, this.horloge());
    } catch (e) {
      throw new ErreurMetier((e as Error).message, 409);
    }
    const numero = s.pret.numero;
    await this.modifierEtat((e) => {
      e.report = { demande_le: report.demandeLe.toISOString(), par: par.nom, par_id: par.id, numero };
    });
    this.signatureCreneau = '';
    this.d.diffuser('maj');
    void this.d
      .client()
      .then((c) => this.rapporterUneFois(c, `reporte:${numero}`, numero, 'REPORTE', { par: par.nom, demande_le: report.demandeLe.toISOString() }))
      .catch(() => {});
    return this.vue();
  }

  // ------------------------------------------------------------------ lanceur

  /** Le lanceur annonce l'installation (route d'arrêt) : compte rendu DEBUT. */
  async surArret(): Promise<void> {
    const j = await lireJournal(this.d.chemins.journal);
    if (!j || 'illisible' in j) return;
    const client = await this.d.client().catch(() => null);
    await this.rapporterUneFois(client, `debut:${j.numero}:${j.tentative}:${j.commence_le}`, j.numero, 'DEBUT', { version: j.version, tentative: j.tentative });
  }

  /** Sortie du mode validation : la nouvelle version tourne, compte rendu INSTALLE. */
  async surValidation(): Promise<void> {
    const j = await lireJournal(this.d.chemins.journal);
    const v = this.d.versionInstallee;
    const detail: Record<string, unknown> = { version: v.version };
    if (j && !('illisible' in j) && j.numero === v.numero) {
      detail.tentative = j.tentative;
      detail.duree_s = Math.round((this.horloge().getTime() - Date.parse(j.commence_le)) / 1000);
    }
    const client = await this.d.client().catch(() => null);
    await this.rapporterUneFois(client, `installe:${v.numero}`, v.numero, 'INSTALLE', detail);
  }

  // ------------------------------------------------------------------ lectures

  async vue(): Promise<VueMaj> {
    const { journal, s } = await this.situation();
    const d = s.decision;
    return {
      actif: this.d.trousseau().trousseau !== null,
      mode: etatMode.mode,
      etat: this.etatSite(journal, s),
      installee: { numero: this.d.versionInstallee.numero, version: this.d.versionInstallee.version },
      prete: s.pret ? { numero: s.pret.numero, version: s.pret.version } : null,
      decision: d
        ? {
            action: d.action,
            raison: d.raison,
            echeance: d.echeance?.toISOString() ?? null,
            report_possible: d.reportPossible,
            rappel: d.rappel,
          }
        : null,
    };
  }

  async blocSante(): Promise<BlocSanteMaj> {
    const { journal, s } = await this.situation();
    const d = s.decision;
    const etat = this.etatSite(journal, s);
    const libre = await (this.d.mesurerEspace ?? espaceLibre)(this.d.chemins.racine).catch(() => null);
    const pg = await this.taillePgdata().catch(() => null);
    return {
      etat,
      numero_installe: this.d.versionInstallee.numero,
      numero_prete: s.pret && d ? s.pret.numero : null,
      installation_prevue: d?.echeance?.toISOString() ?? null,
      report_jusqua: etat === 'REPORTEE' ? (d?.echeance?.toISOString() ?? null) : null,
      // Sinon, l'échec d'installation d'une version toujours pas en place.
      derniere_erreur:
        this.derniereErreur ??
        (journal && !('illisible' in journal) && journal.etat !== 'INSTALLEE' && journal.numero > this.d.versionInstallee.numero
          ? (journal.erreur?.message ?? null)
          : null),
      espace_libre_mo: libre === null ? null : Math.round(libre / MO),
      taille_pgdata_mo: pg === null ? null : Math.round(pg / MO),
      integrite: { suspects_grenam: this.suspectsGrenam },
    };
  }
}

// ---------------------------------------------------------------------------
// Instance du serveur
// ---------------------------------------------------------------------------

let instance: MoteurMaj | null = null;

/** Construit le moteur réel (null sans POS_RACINE : poste de développement). */
export async function moteurMajDuSite(diffuser: (type: EvenementWsMaj) => void): Promise<MoteurMaj | null> {
  if (instance) return instance;
  const { cheminsDuSite, VERSION_DEMARREE, numeroLanceur, DEBIT_MAX_OCTETS_S } = await import('./config.js');
  const chemins = cheminsDuSite();
  if (!chemins) return null;
  instance = new MoteurMaj({
    chemins,
    client: async () => {
      const cfg = await chargerConfigSync();
      return cfg.url && cfg.cleSite ? new ClientMaj(cfg.url, cfg.cleSite) : null;
    },
    trousseau: () => chargerTrousseau(),
    versionInstallee: VERSION_DEMARREE,
    lanceurNumero: numeroLanceur(),
    versionNode: process.version,
    debitMax: DEBIT_MAX_OCTETS_S,
    diffuser,
  });
  return instance;
}

/** Instance déjà construite (routes, battement), ou null. */
export function moteurMajCourant(): MoteurMaj | null {
  return instance;
}
