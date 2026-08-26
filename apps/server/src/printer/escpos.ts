/**
 * Impression thermique ESC/POS (80 mm, 48 colonnes) via la file CUPS locale
 * (`lp -d <file> -o raw`). Le nom de la file est lu dans parametres_locaux
 * (`imprimante_thermique_queue`) : vide → repli sur la console (dev).
 *
 * Le texte est translittéré en ASCII (é→e, − →-, espaces insécables → espace)
 * pour éviter les soucis de page de code des imprimantes génériques.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { CommandeItemVue, CommandeVue, EtatStockInstant, NoteSplitVue, PosteImpression, RapportSequence, RapportZ } from '@pos/shared';
import { clePosteImprimante, estLivraisonSansEncaissement, formatFCFA, libelleCategorieInventaire, libellePartenaire, LIBELLES_MODES, LIBELLES_POSTE_IMPRESSION, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { db } from '../db/client.js';
import { parametresLocaux, restaurant } from '../db/schema/index.js';
import type { PrinterService } from './PrinterService.js';
import { ConsolePrinter } from './ConsolePrinter.js';
import { estModeLogo, logoTicket, type Marque, type ModeLogo } from './logo.js';

/**
 * Colonnes de texte du papier, en police normale. 48 est la valeur classique
 * d'une 80 mm, mais beaucoup de modèles n'impriment que 42 colonnes (zone
 * imprimable de 512 points au lieu de 576) et une 58 mm en fait 32. Se tromper
 * ne tronque pas la ligne : le surplus **passe à la ligne suivante**, ce qui
 * casse l'alignement des prix (le « 5 » de 5 000 F reste en haut, « 000 F »
 * descend). D'où un réglage par poste, calibré avec le ticket de test.
 */
export const COLONNES_DEFAUT = 48;
export const COLONNES_POSSIBLES = [32, 42, 48] as const;
export const CLE_COLONNES = 'ticket_colonnes';

/**
 * Agrandissement du texte (multiplicateurs ESC/POS, 1 à 8). Doubler la HAUTEUR
 * ne coûte que du papier ; doubler la LARGEUR divise les colonnes par autant,
 * d'où des choix différents selon le ticket :
 * - bon de préparation : lu à distance, en cuisine → gros dans les deux sens ;
 * - reçu client : largeur ×1 pour garder toutes les colonnes, donc des prix
 *   alignés à droite.
 */
const TAILLE_BON_ARTICLE = { largeur: 2, hauteur: 2 };
const TAILLE_RECU_ARTICLE = { largeur: 1, hauteur: 2 };

/** Paramètre local qui choisit l'encodage du logo (voir `printer/logo.ts`). */
export const CLE_LOGO = 'ticket_logo';

/** Nombre de colonnes retenu, quelle que soit la valeur trouvée en base. */
export function colonnesValides(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 24 && n <= 96 ? Math.floor(n) : COLONNES_DEFAUT;
}

/**
 * Horodatage court (10/08/26 17:46) : le format long dépasse 32 colonnes une
 * fois accolé au numéro de ticket, et repartirait à la ligne sur une 58 mm.
 */
function horodatage(d = new Date()): string {
  return d.toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** Translittère en ASCII imprimable (sans accents ni caractères spéciaux). */
function ascii(s: string): string {
  return s
    .replace(/−/g, '-')
    .replace(/[’‘]/g, "'")
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/[^\x20-\x7E]/g, ' ');
}

/** Heure seule (17:46) : suffit quand la date est déjà imprimée au-dessus. */
function heure(d: Date): string {
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Quantités d'inventaire : jamais des entiers (grammes, pots, sachets). */
function quantite(n: number): string {
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

/** Constructeur de flux ESC/POS, pour un papier de `papier` colonnes. */
class Ruban {
  private o: number[] = [];
  /** Multiplicateur de largeur courant : les colonnes utiles en dépendent. */
  private largeur = 1;
  constructor(private readonly papier: number = COLONNES_DEFAUT) {}
  private push(...b: (number | string)[]): void {
    for (const x of b) {
      if (typeof x === 'string') for (const c of Buffer.from(ascii(x), 'latin1')) this.o.push(c);
      else this.o.push(x);
    }
  }
  init(): this { this.push(0x1b, 0x40); this.largeur = 1; return this; }
  gauche(): this { this.push(0x1b, 0x61, 0x00); return this; }
  centre(): this { this.push(0x1b, 0x61, 0x01); return this; }
  gras(on: boolean): this { this.push(0x1b, 0x45, on ? 0x01 : 0x00); return this; }
  /**
   * Taille du texte (GS ! n) : multiplicateurs 1 à 8, largeur puis hauteur.
   * `taille(2)` = double dans les deux sens, `taille(1, 2)` = double hauteur
   * seule. Appelée sans argument, revient au normal.
   */
  taille(largeur = 1, hauteur = largeur): this {
    const l = Math.min(8, Math.max(1, Math.round(largeur)));
    const h = Math.min(8, Math.max(1, Math.round(hauteur)));
    this.largeur = l;
    this.push(0x1d, 0x21, ((l - 1) << 4) | (h - 1));
    return this;
  }
  /** Colonnes réellement disponibles à la taille courante (moitié en ×2…). */
  private get colonnes(): number { return Math.floor(this.papier / this.largeur); }
  texte(s: string): this { this.push(s); return this; }
  ligne(s = ''): this { this.push(s, 0x0a); return this; }
  /** Insère des octets ESC/POS bruts (ex. logo raster). */
  brut(b: Buffer): this { for (const x of b) this.o.push(x); return this; }
  /**
   * Ligne à deux colonnes : libellé à gauche, montant collé à droite.
   *
   * Si l'ensemble ne tient pas, on ne laisse SURTOUT pas l'imprimante gérer le
   * débordement : elle renvoie le surplus à la ligne, ce qui coupe le montant
   * en deux (le « 5 » en haut, « 000 F » en dessous). Le libellé est donc
   * replié par mots, et le montant reste seul aligné à droite sur la dernière
   * ligne — quitte à s'y trouver seul.
   */
  duo(g: string, d: string, remplissage = ' '): this {
    const gauche = ascii(g), droite = ascii(d);
    const max = this.colonnes;
    const aDroite = (texte: string, avant = ''): string => {
      const vide = Math.max(1, max - avant.length - texte.length);
      // Points de conduite : un espace de part et d'autre, sinon le nom et le
      // chiffre se collent aux points et la ligne devient illisible. Sous 3
      // caractères de vide il n'y a plus la place : on retombe sur des espaces.
      if (remplissage !== ' ' && avant !== '' && vide >= 3) {
        return `${avant} ${remplissage.repeat(vide - 2)} ${texte}`;
      }
      return avant + ' '.repeat(vide) + texte;
    };

    if (gauche.length + droite.length + 1 <= max) return this.ligne(aDroite(droite, gauche));

    // Repli par mots ; un mot plus long que la ligne est coupé net.
    const lignes: string[] = [];
    let courante = '';
    for (const mot of gauche.split(' ').filter(Boolean)) {
      const essai = courante ? `${courante} ${mot}` : mot;
      if (essai.length <= max) { courante = essai; continue; }
      if (courante) lignes.push(courante);
      courante = mot;
      while (courante.length > max) {
        lignes.push(courante.slice(0, max));
        courante = courante.slice(max);
      }
    }
    if (courante) lignes.push(courante);

    const derniere = lignes.pop() ?? '';
    for (const l of lignes) this.ligne(l);
    // Le montant rejoint la dernière ligne s'il y tient, sinon il prend la sienne.
    if (derniere.length + droite.length + 1 <= max) return this.ligne(aDroite(droite, derniere));
    if (derniere) this.ligne(derniere);
    return this.ligne(aDroite(droite));
  }
  tiret(): this { return this.ligne('-'.repeat(this.colonnes)); }
  couper(): this { this.push(0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00); return this; }
  buffer(): Buffer { return Buffer.from(this.o); }
}

/** Envoi RAW multi-plateforme : Windows (spooler par nom, ou UNC) ou CUPS (lp). */
export function envoyerRaw(queue: string, data: Buffer): Promise<void> {
  return process.platform === 'win32' ? envoyerRawWindows(queue, data) : envoyerRawUnix(queue, data);
}

/** macOS / Linux : file CUPS via `lp -d <file> -o raw` (stdin). */
function envoyerRawUnix(queue: string, data: Buffer): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn('lp', ['-d', queue, '-o', 'raw']);
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`lp a renvoyé ${code}`))));
    p.stdin.on('error', () => undefined);
    p.stdin.write(data);
    p.stdin.end();
  });
}

/**
 * Windows : deux cas selon le paramètre `imprimante_thermique_queue`.
 * - Chemin UNC `\\host\partage` (commence par `\\`) → `copy /b` vers le partage.
 * - Sinon → NOM d'imprimante Windows (ex. « RONGTA 80mm Series Printer ») :
 *   envoi RAW direct par le spooler (winspool WritePrinter). Aucune obligation
 *   de partager l'imprimante — c'est ce qui permet de tout configurer depuis le
 *   menu Réglages sans partage manuel poste par poste.
 */
async function envoyerRawWindows(cible: string, data: Buffer): Promise<void> {
  if (cible.startsWith('\\\\')) return envoyerRawWindowsUNC(cible, data);
  return envoyerRawWindowsSpooler(cible, data);
}

/** Windows : impression RAW vers un partage via `copy /b <fichier> \\host\partage`. */
async function envoyerRawWindowsUNC(partage: string, data: Buffer): Promise<void> {
  // Le chemin passe par cmd.exe (copy) : on rejette tout métacaractère
  // (& | > < ^ " % ( ) …) pour empêcher toute injection de commande.
  if (!/^[\\A-Za-z0-9 ._$-]+$/.test(partage)) {
    throw new Error('Chemin de partage invalide (caractères non autorisés)');
  }
  const tmp = join(tmpdir(), `pos-ticket-${randomBytes(6).toString('hex')}.bin`);
  await writeFile(tmp, data);
  try {
    await new Promise<void>((res, rej) => {
      const p = spawn('cmd', ['/c', 'copy', '/b', tmp, partage], { windowsHide: true });
      p.on('error', rej);
      p.on('close', (code) => (code === 0 ? res() : rej(new Error(`copy a renvoyé ${code}`))));
    });
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

// Script PowerShell (P/Invoke winspool) qui envoie des octets RAW à une
// imprimante par son NOM, sans partage. Écrit une fois dans le dossier temp.
const SCRIPT_RAW_PS1 = `param([Parameter(Mandatory=$true)][string]$Printer,[Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PosRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);
}
"@
$h = [IntPtr]::Zero
if (-not [PosRawPrinter]::OpenPrinter($Printer, [ref]$h, [IntPtr]::Zero)) { throw "Imprimante introuvable ou inaccessible : $Printer" }
try {
  $di = New-Object PosRawPrinter+DOCINFO
  $di.pDocName = 'POS Ticket'; $di.pDataType = 'RAW'
  if (-not [PosRawPrinter]::StartDocPrinter($h, 1, [ref]$di)) { throw 'Le spooler a refuse le document (StartDocPrinter).' }
  try {
    [void][PosRawPrinter]::StartPagePrinter($h)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $written = 0
    if (-not [PosRawPrinter]::WritePrinter($h, $bytes, $bytes.Length, [ref]$written)) { throw 'Echec de l ecriture vers l imprimante (WritePrinter).' }
    [void][PosRawPrinter]::EndPagePrinter($h)
  } finally { [void][PosRawPrinter]::EndDocPrinter($h) }
} finally { [void][PosRawPrinter]::ClosePrinter($h) }
`;

let cheminScriptRaw: string | null = null;
async function scriptRawPret(): Promise<string> {
  if (cheminScriptRaw) return cheminScriptRaw;
  const p = join(tmpdir(), 'pos-raw-print.ps1');
  await writeFile(p, SCRIPT_RAW_PS1, 'utf8');
  cheminScriptRaw = p;
  return p;
}

/** Windows : impression RAW par NOM d'imprimante via le spooler (winspool). */
async function envoyerRawWindowsSpooler(nom: string, data: Buffer): Promise<void> {
  const script = await scriptRawPret();
  const tmp = join(tmpdir(), `pos-ticket-${randomBytes(6).toString('hex')}.bin`);
  await writeFile(tmp, data);
  try {
    await new Promise<void>((res, rej) => {
      // Nom et chemin passés en arguments (argv) au script : pas de shell,
      // donc aucune injection possible même si le nom contient des espaces.
      const p = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Printer', nom, '-Path', tmp],
        { windowsHide: true },
      );
      let err = '';
      p.stderr.on('data', (b) => (err += b.toString()));
      p.on('error', rej);
      p.on('close', (code) => {
        if (code === 0) return res();
        const detail = err.trim().split('\n')[0] || `code ${code}`;
        rej(new Error(detail));
      });
    });
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** Une imprimante détectée sur ce poste (pour le menu Réglages). */
export interface ImprimanteSysteme {
  nom: string;
  port: string;
  partagee: boolean;
  nom_partage: string | null;
  virtuelle: boolean;
}

// Imprimantes « logicielles » (PDF, XPS, fax…) : listées mais signalées comme
// non pertinentes pour un ticket de caisse.
const NOMS_VIRTUELS = /(XPS|PDF|OneNote|Fax|Send To OneNote)/i;

/** Liste les imprimantes installées sur ce poste (Windows: Get-Printer, sinon CUPS). */
export async function listerImprimantes(): Promise<ImprimanteSysteme[]> {
  return process.platform === 'win32' ? listerImprimantesWindows() : listerImprimantesUnix();
}

function listerImprimantesWindows(): Promise<ImprimanteSysteme[]> {
  return new Promise((res) => {
    const cmd =
      '$ErrorActionPreference="Stop"; ' +
      '@(Get-Printer | Select-Object Name,PortName,Shared,ShareName) | ConvertTo-Json -Compress';
    const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (b) => (out += b.toString()));
    p.on('error', () => res([]));
    p.on('close', () => {
      try {
        const brut = JSON.parse(out.trim() || '[]');
        const arr = Array.isArray(brut) ? brut : [brut];
        res(
          arr
            .filter((x) => x && typeof x.Name === 'string')
            .map((x) => ({
              nom: x.Name as string,
              port: typeof x.PortName === 'string' ? x.PortName : '',
              partagee: Boolean(x.Shared),
              nom_partage: typeof x.ShareName === 'string' ? x.ShareName : null,
              virtuelle: NOMS_VIRTUELS.test(x.Name as string),
            })),
        );
      } catch {
        res([]);
      }
    });
  });
}

function listerImprimantesUnix(): Promise<ImprimanteSysteme[]> {
  return new Promise((res) => {
    const p = spawn('lpstat', ['-e']);
    let out = '';
    p.stdout.on('data', (b) => (out += b.toString()));
    p.on('error', () => res([]));
    p.on('close', () =>
      res(
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((nom) => ({ nom, port: '', partagee: false, nom_partage: null, virtuelle: false })),
      ),
    );
  });
}

/**
 * En-tête commun (logo + nom + contact + type/table/ticket).
 * Le logo n'est imprimé que si un mode compatible a été choisi dans Réglages →
 * Imprimantes (`ticket_logo`) : par défaut `aucun`, car une commande image non
 * reconnue sort en charabia juste avant les articles.
 */
function entete(r: Ruban, resto: { nom: string; entete: string; marque: Marque; logo: ModeLogo }, c: CommandeVue, titre: string): void {
  r.init().centre();
  const logo = logoTicket(resto.marque, resto.logo);
  if (logo) r.brut(logo).ligne();
  r.taille(2).gras(true).ligne(resto.nom).taille().gras(false);
  if (resto.entete) for (const l of resto.entete.split('\n')) r.ligne(l);
  r.ligne().gras(true).ligne(titre).gras(false);
  if (c.code_commande) r.taille(2).gras(true).ligne(c.code_commande).taille().gras(false);
  const sous = `${LIBELLES_TYPES_COMMANDE[c.type]}${c.table_numero ? ` - Table ${c.table_numero}` : ''}${c.partenaire ? ` - ${c.partenaire}` : ''}`;
  r.ligne(sous).ligne(`Ticket ${c.numero_ticket} - ${horodatage()}`);
  r.gauche().tiret();
}

function corpsArticles(r: Ruban, c: CommandeVue): void {
  for (const item of c.items) {
    if (item.statut_cuisine === 'ANNULE') continue;
    // Le plat et son prix en grand ; suppléments et options restent en normal
    // (détails secondaires) pour ne pas noyer la ligne principale.
    r.taille(TAILLE_RECU_ARTICLE.largeur, TAILLE_RECU_ARTICLE.hauteur);
    r.duo(`${item.quantite} x ${item.nom_snapshot}`, formatFCFA(item.total_ligne));
    r.taille();
    // Une option offerte (prix 0) s'imprime sans montant : « + Pâte à l'ail
    // (0 FCFA) » sur un reçu client fait désordre.
    for (const s of item.supplements) {
      r.ligne(s.prix > 0 ? `   + ${s.nom} (${formatFCFA(s.prix)})` : `   + ${s.nom}`);
    }
    for (const o of item.options) if (o.choix.length) r.ligne(`   ${o.groupe}: ${o.choix.join(', ')}`);
  }
  r.tiret();
  r.duo('Sous-total', formatFCFA(c.sous_total));
  if (c.promo_montant > 0) r.duo(`Promo ${c.promo_nom ?? ''}`, `-${formatFCFA(c.promo_montant)}`);
  if (c.remise_montant > 0) r.duo('Remise', `-${formatFCFA(c.remise_montant)}`);
  if (c.fidelite_montant > 0) r.duo('Fidelite', `-${formatFCFA(c.fidelite_montant)}`);
  r.gras(true).taille(2).duo('TOTAL', formatFCFA(c.total)).taille().gras(false);
}

/**
 * Imprimante thermique : ESC/POS si une file est configurée, sinon console.
 * La décision est prise À CHAQUE impression (le nom de file peut changer dans
 * Réglages sans redémarrer le serveur).
 */
/**
 * Imprimante configurée pour un poste (CAISSE/CUISINE/BAR), lue dans
 * parametres_locaux à chaque impression. La CAISSE retombe sur l'ancienne clé
 * `imprimante_thermique_queue` si `imprimante_poste_caisse` n'est pas encore
 * renseignée (compat : déploiements antérieurs au routage). Vide → null.
 */
export async function queuePoste(poste: PosteImpression): Promise<string | null> {
  const cles = poste === 'CAISSE'
    ? [clePosteImprimante('CAISSE'), 'imprimante_thermique_queue']
    : [clePosteImprimante(poste)];
  const lignes = await db.select().from(parametresLocaux);
  for (const cle of cles) {
    const p = lignes.find((x) => x.cle === cle);
    const nom = typeof p?.valeur === 'string' ? p.valeur.trim() : '';
    if (nom) return nom;
  }
  return null;
}

export class EscposPrinter implements PrinterService {
  private console = new ConsolePrinter();

  /** Imprime sur le poste demandé (CAISSE par défaut : reçu/facture/rapport Z). */
  private async envoyer(
    construire: () => Buffer,
    replConsole: () => Promise<void>,
    poste: PosteImpression = 'CAISSE',
  ): Promise<void> {
    const q = await queuePoste(poste);
    if (!q) return replConsole();
    try {
      await envoyerRaw(q, construire());
    } catch (e) {
      console.error(`Impression ${poste} échouée, repli console :`, (e as Error).message);
      await replConsole();
    }
  }

  private async infosResto(): Promise<{ nom: string; entete: string; pied: string; marque: Marque; logo: ModeLogo; colonnes: number }> {
    const params = await db.select().from(parametresLocaux);
    const val = (cle: string): string => {
      const p = params.find((x) => x.cle === cle);
      return typeof p?.valeur === 'string' ? p.valeur : '';
    };
    const brut = params.find((x) => x.cle === CLE_COLONNES)?.valeur;
    const [resto] = await db.select().from(restaurant).limit(1);
    const logo = val(CLE_LOGO);
    return {
      nom: resto?.nom ?? 'Chez Samer',
      entete: val('ticket_entete'),
      pied: val('ticket_pied'),
      marque: (resto?.marque as Marque) ?? 'SAMER',
      logo: estModeLogo(logo) ? logo : 'aucun',
      colonnes: colonnesValides(brut),
    };
  }

  async imprimerFacture(c: CommandeVue): Promise<void> {
    const info = await this.infosResto();
    await this.envoyer(
      () => {
        const r = new Ruban(info.colonnes);
        entete(r, info, c, 'FACTURE');
        corpsArticles(r, c);
        r.tiret().centre().ligne('Facture non acquittee - a regler en caisse');
        if (info.pied) r.ligne(info.pied);
        r.couper();
        return r.buffer();
      },
      () => this.console.imprimerFacture(c),
    );
  }

  async imprimerTicket(c: CommandeVue): Promise<void> {
    const info = await this.infosResto();
    await this.envoyer(
      () => {
        const r = new Ruban(info.colonnes);
        entete(r, info, c, 'RECU');
        corpsArticles(r, c);
        r.tiret();
        for (const p of c.paiements) r.duo(LIBELLES_MODES[p.mode], formatFCFA(p.montant));
        if (c.paiements.length === 0 && estLivraisonSansEncaissement(c.partenaire)) {
          r.ligne(`Regle par ${libellePartenaire(c.partenaire!)}`);
        }
        // Kdo : le ticket dit clairement que rien n'a été encaissé, et pourquoi.
        // C'est la pièce qu'un gérant retrouvera en cas de doute.
        if (c.offert) {
          r.ligne('*** OFFERT - KDO ***');
          if (c.motif_offert) r.ligne(`Motif : ${c.motif_offert}`);
        }
        r.tiret().centre().ligne(c.offert ? 'Offert - bonne degustation !' : 'Paye - merci de votre visite !');
        if (info.pied) r.ligne(info.pied);
        r.couper();
        return r.buffer();
      },
      () => this.console.imprimerTicket(c),
    );
  }

  async imprimerSousNote(c: CommandeVue, note: NoteSplitVue): Promise<void> {
    const info = await this.infosResto();
    await this.envoyer(
      () => {
        const r = new Ruban(info.colonnes);
        r.init().centre();
        r.gras(true).ligne(info.nom).gras(false);
        r.ligne(`Ticket ${c.numero_ticket} - Paiement ${note.numero}`);
        r.gauche().tiret();
        for (const item of note.items) {
          r.duo(`${item.quantite} x ${item.nom_snapshot}`, formatFCFA(item.montant_brut));
          for (const s of item.supplements) r.ligne(`   + ${s.nom} (${formatFCFA(s.prix)})`);
          for (const o of item.options) if (o.choix.length) r.ligne(`   ${o.groupe}: ${o.choix.join(', ')}`);
        }
        r.tiret().duo('Sous-total', formatFCFA(note.sous_total));
        if (note.promo_montant > 0) r.duo('Promotion', `-${formatFCFA(note.promo_montant)}`);
        if (note.remise_montant > 0) r.duo('Remise', `-${formatFCFA(note.remise_montant)}`);
        if (note.fidelite_montant > 0) r.duo('Fidelite', `-${formatFCFA(note.fidelite_montant)}`);
        r.gras(true).duo('TOTAL', formatFCFA(note.montant)).gras(false).tiret();
        for (const p of note.paiements) r.duo(LIBELLES_MODES[p.mode], formatFCFA(p.montant));
        r.centre().ligne('Paye - merci de votre visite !').couper();
        return r.buffer();
      },
      () => this.console.imprimerSousNote(c, note),
    );
  }

  async imprimerBon(c: CommandeVue, poste: PosteImpression, items: CommandeItemVue[]): Promise<void> {
    const info = await this.infosResto();
    const ident = c.table_numero ? `Table ${c.table_numero}` : c.partenaire ?? '';
    await this.envoyer(
      () => {
        const r = new Ruban(info.colonnes);
        r.init().centre();
        r.gras(true).ligne(info.nom).gras(false);
        r.ligne().gras(true).ligne(`BON ${LIBELLES_POSTE_IMPRESSION[poste].toUpperCase()}`).gras(false);
        // Code TRÈS gros : c'est le repère qui accompagne le plat en salle.
        r.taille(2).gras(true).ligne(c.code_commande ?? `#${c.numero_ticket}`).taille().gras(false);
        r.ligne(`${LIBELLES_TYPES_COMMANDE[c.type]}${ident ? ` - ${ident}` : ''}`);
        r.ligne(`Ticket ${c.numero_ticket} - ${horodatage()}`);
        r.gauche().tiret();
        for (const item of items) {
          if (item.statut_cuisine === 'ANNULE') continue;
          // Bon lu à distance en cuisine : le plat en très gros, ses précisions
          // (suppléments, options) en double hauteur seule pour rester lisibles.
          r.taille(TAILLE_BON_ARTICLE.largeur, TAILLE_BON_ARTICLE.hauteur).gras(true);
          r.ligne(`${item.quantite} x ${item.nom_snapshot}`);
          r.gras(false).taille(1, TAILLE_BON_ARTICLE.hauteur);
          for (const s of item.supplements) r.ligne(`  + ${s.nom}`);
          for (const o of item.options) if (o.choix.length) r.ligne(`  ${o.groupe}: ${o.choix.join(', ')}`);
          r.taille();
        }
        r.couper();
        return r.buffer();
      },
      () => this.console.imprimerBon(c, poste, items),
      poste,
    );
  }

  async imprimerRapportZ(z: RapportZ): Promise<void> {
    const info = await this.infosResto();
    await this.envoyer(
      () => {
        const r = new Ruban(info.colonnes);
        r.init().centre().gras(true).taille(2).ligne('RAPPORT Z').taille().gras(false);
        r.ligne(z.caissier).ligne(horodatage(new Date(z.ouvert_le))).gauche().tiret();
        r.duo('Commandes encaissees', String(z.nb_commandes_payees));
        r.duo('Commandes annulees', String(z.nb_commandes_annulees));
        r.duo('Total ventes', formatFCFA(z.total_ventes));
        r.duo('Total remises', formatFCFA(z.total_remises));
        r.duo('Total promotions', formatFCFA(z.total_promos));
        r.tiret();
        for (const [mode, montant] of Object.entries(z.par_mode)) if (montant > 0) r.duo(mode, formatFCFA(montant));

        // Livraisons partenaires : le montant, puis le décompte
        // commandes/contacts. C'est cette seconde ligne que le gérant regarde —
        // 5 courses Yango dont 4 seulement portent un téléphone, c'est une
        // course qu'on ne saura rattacher à personne en cas de litige.
        if (Object.keys(z.partenaires ?? {}).length > 0) {
          r.tiret();
          r.gras(true).ligne('LIVRAISONS PARTENAIRES').gras(false);
          for (const [p, s] of Object.entries(z.partenaires)) {
            r.duo(`${libellePartenaire(p)} (${s.nb})`, formatFCFA(s.total));
            // Mots entiers si le papier les porte, forme courte sinon : sur une
            // 58 mm la ligne longue repartirait à la ligne et le second ratio
            // atterrirait sous le premier, illisible.
            const detail = `   contacts ${s.contacts ?? 0}/${s.nb}  no partenaire ${s.refs ?? 0}/${s.nb}`;
            const court = `   contacts ${s.contacts ?? 0}/${s.nb}  no ${s.refs ?? 0}/${s.nb}`;
            r.ligne(detail.length <= info.colonnes ? detail : court);
          }
        }

        r.tiret();
        r.duo('Fond de caisse', formatFCFA(z.fond_de_caisse));
        r.duo('Especes comptees', formatFCFA(z.especes_comptees));
        r.duo('Especes theoriques', formatFCFA(z.especes_theorique));
        r.gras(true).duo('ECART', formatFCFA(z.ecart)).gras(false);
        // Kdo : comptés dans « Total ventes » plus haut, absents du tiroir. La
        // ligne explique l'écart apparent entre les deux.
        if (z.offerts?.total) {
          r.tiret();
          r.duo(`Kdo offerts (${z.offerts.nb})`, formatFCFA(z.offerts.total));
        }
        if (z.depenses) r.duo('Depenses', formatFCFA(z.depenses));

        if (z.sous_notes_incompletes?.length) {
          r.tiret();
          r.gras(true).ligne('PAIEMENTS INCOMPLETS').gras(false);
          for (const n of z.sous_notes_incompletes) {
            r.ligne(`Ticket ${n.numero_ticket} - Paiement ${n.numero_paiement}`);
            r.duo('Recu', formatFCFA(n.montant_recu));
            r.duo('Reste', formatFCFA(n.reste));
          }
        }

        // Bloc Inventaire (DESIGN_V2 § 6.10). Placé APRÈS l'écart de caisse et
        // explicitement marqué information : le manquant de stock n'entre ni
        // dans la vente ni dans l'écart du tiroir — sans cette mention, le
        // manager additionnerait deux chiffres qui n'ont rien à voir.
        if (z.inventaire) {
          r.tiret();
          r.gras(true).ligne('INVENTAIRE').gras(false);
          if (!z.inventaire.valide && z.inventaire.debloque) {
            r.ligne('Debloque par un manager');
            r.ligne('(comptage incomplet)');
          } else if (z.inventaire.manquants === 0 && z.inventaire.surplus === 0) {
            r.ligne('Conforme');
          } else {
            r.duo('Produits manquants', String(z.inventaire.manquants));
            if (z.inventaire.surplus > 0) r.duo('Produits en surplus', String(z.inventaire.surplus));
            r.duo('Montant manquant', formatFCFA(z.inventaire.montant_manquant));
          }
          r.ligne('Information manager -');
          r.ligne('sans effet sur la vente.');
        }

        // Bloc RETOURS : articles déjà partis en cuisine puis supprimés au PIN
        // manager. Même statut que l'inventaire — information, hors vente et
        // hors tiroir. Imprimé parce qu'un retour non imprimé se discute.
        if (z.retours?.nb) {
          r.tiret();
          r.gras(true).ligne('RETOURS').gras(false);
          for (const p of z.retours.par_produit) {
            r.duo(`${p.quantite} x ${p.nom}`, formatFCFA(p.montant));
          }
          r.gras(true).duo('Total retours', formatFCFA(z.retours.montant)).gras(false);
          r.ligne('Deja lances en cuisine,');
          r.ligne('annules au PIN manager.');
          r.ligne('Hors vente et hors tiroir.');
        }

        // Présents / restent / partis : le décompte de la paie du lendemain.
        if (z.equipe?.presents) {
          r.tiret();
          r.duo('Equipe presente', String(z.equipe.presents));
          r.duo('Restent', String(z.equipe.restent));
          r.duo('Partis', String(z.equipe.partis));
        }
        r.couper();
        return r.buffer();
      },
      () => this.console.imprimerRapportZ(z),
    );
  }

  /**
   * Tirage du stock à l'instant T (§ 6.9). Le stock est le SEUL chiffre en
   * gros, relié au nom par des points de conduite ; le détail qui l'explique
   * (initial, entrées, sorties) tient sur la ligne du dessous. Un gérant lit ce
   * papier debout dans une réserve : la colonne de droite doit s'attraper d'un
   * coup d'œil, sans suivre la ligne au doigt.
   */
  async imprimerEtatStock(etat: EtatStockInstant): Promise<void> {
    const info = await this.infosResto();
    await this.envoyer(
      () => {
        const r = new Ruban(info.colonnes);
        r.init().centre().gras(true).ligne(info.nom).gras(false);
        r.taille(1, 2).gras(true).ligne('ETAT DU STOCK').gras(false).taille();
        r.ligne(horodatage(new Date(etat.genere_le)));
        r.ligne(`${etat.genere_par} - service de ${heure(new Date(etat.service_ouvert_le))}`);
        r.gauche();

        let categorie: string | null = null;
        for (const l of etat.lignes) {
          if (l.categorie !== categorie) {
            categorie = l.categorie;
            r.tiret().gras(true).ligne(libelleCategorieInventaire(categorie).toUpperCase()).gras(false);
          }
          r.gras(true).duo(`${l.nom} (${l.unite})`, quantite(l.stock), '.').gras(false);
          // Le détail sous le chiffre, jamais à côté : sur 32 colonnes il
          // repousserait le stock hors de la ligne. Les mots entiers d'abord ;
          // s'ils ne tiennent pas sur ce papier, la forme courte — mieux vaut
          // abréger que laisser l'imprimante renvoyer la moitié à la ligne.
          const detail =
            `   Initial ${quantite(l.stock_initial)}  Entrees +${quantite(l.entrees)}`
            + `  Sorties -${quantite(l.sorties)}`;
          const court =
            `   Init ${quantite(l.stock_initial)}  +${quantite(l.entrees)}  -${quantite(l.sorties)}`;
          r.ligne((detail.length <= info.colonnes ? detail : court) + (l.compte ? ' *' : ''));
        }

        r.tiret();
        // L'étoile n'a de sens qu'expliquée, et seulement s'il y en a une.
        if (etat.lignes.some((l) => l.compte)) r.ligne('* stock compte physiquement');
        r.centre();
        // Un tirage n'est pas un inventaire validé : sans cette phrase, un
        // papier ramassé sur le comptoir passerait pour la clôture du soir.
        if (etat.inventaire_valide) r.ligne('Inventaire du service deja valide.');
        else if (etat.nb_theoriques > 0) {
          r.ligne(`${etat.nb_theoriques} ligne(s) non comptee(s) :`);
          r.ligne('stock theorique.');
        }
        r.ligne('Photo du stock - ne vaut pas');
        r.ligne('inventaire valide.');
        if (info.pied) r.ligne(info.pied);
        r.couper();
        return r.buffer();
      },
      () => this.console.imprimerEtatStock(etat),
    );
  }

  /**
   * Récap remis au gérant au rasage de la séquence : le détail de CHAQUE shift
   * (celui que le gérant doit pouvoir contrôler caissier par caissier), puis
   * les totaux consolidés de la journée.
   */
  async imprimerRapportSequence(s: RapportSequence): Promise<void> {
    const info = await this.infosResto();
    await this.envoyer(
      () => {
        const r = new Ruban(info.colonnes);
        r.init().centre();
        r.taille(2).gras(true).ligne('RECAP').ligne('SEQUENCE').taille().gras(false);
        r.ligne(info.nom);
        r.gauche().tiret();
        r.duo('Ouverte', horodatage(new Date(s.ouverte_le)));
        r.duo('Rasee', horodatage(new Date(s.cloturee_le)));
        r.duo('Par', s.cloturee_par);
        r.duo('Shifts', String(s.nb_shifts));
        // Shifts laissés pour le lendemain (encore ouverts, ou rangés dans la
        // journée suivante par le gérant) : sans cette ligne, un total amputé
        // passerait pour un manque en caisse.
        if (s.shifts_reportes > 0) r.duo('Reportes', `${s.shifts_reportes} shift(s)`);

        // Un bloc par caissier : c'est le cœur du document pour le gérant.
        for (const sh of s.shifts) {
          r.tiret();
          r.gras(true).ligne(sh.caissier).gras(false);
          const debut = horodatage(new Date(sh.ouvert_le));
          const fin = sh.cloture_le ? horodatage(new Date(sh.cloture_le)) : 'EN COURS';
          r.duo(' Debut', debut);
          r.duo(' Fin', fin);
          r.duo(' Fond de caisse', formatFCFA(sh.fond_de_caisse));
          r.duo(' Ventes', formatFCFA(sh.vente_totale ?? 0));
          if (sh.depenses) r.duo(' Depenses', formatFCFA(sh.depenses));
          r.duo(' Especes comptees', formatFCFA(sh.especes_comptees ?? 0));
          for (const [mode, montant] of Object.entries(sh.modes_declares)) {
            if (montant > 0) r.duo(` ${LIBELLES_MODES[mode as keyof typeof LIBELLES_MODES] ?? mode}`, formatFCFA(montant));
          }
          for (const [part, montant] of Object.entries(sh.livraisons)) {
            if (montant > 0) r.duo(` ${libellePartenaire(part)}`, formatFCFA(montant));
          }
          // Les Kdo comptent dans les ventes du shift mais pas dans le tiroir :
          // sans cette ligne, le gérant verrait un manquant inexpliqué.
          if (sh.offerts?.total) r.duo(` Kdo offerts (${sh.offerts.nb})`, formatFCFA(sh.offerts.total));
          r.gras(true).duo(' Ecart', formatFCFA(sh.ecart ?? 0)).gras(false);
        }

        r.tiret();
        r.gras(true).ligne('TOTAL DE LA JOURNEE').gras(false);
        r.duo('Especes comptees', formatFCFA(s.especes_comptees));
        for (const [mode, montant] of Object.entries(s.modes)) {
          if (montant > 0) r.duo(LIBELLES_MODES[mode as keyof typeof LIBELLES_MODES] ?? mode, formatFCFA(montant));
        }
        for (const [part, montant] of Object.entries(s.livraisons)) {
          if (montant > 0) r.duo(libellePartenaire(part), formatFCFA(montant));
        }
        if (s.offerts?.total) r.duo(`Kdo offerts (${s.offerts.nb})`, formatFCFA(s.offerts.total));
        if (s.depenses) r.duo('Depenses', formatFCFA(s.depenses));
        r.tiret();
        r.gras(true).taille(1, 2).duo('VENTE TOTALE', formatFCFA(s.vente_totale)).taille().gras(false);
        if (s.offerts?.total) r.duo(`dont Kdo offerts (${s.offerts.nb})`, formatFCFA(s.offerts.total));
        r.duo('Total systeme', formatFCFA(s.total_systeme));
        r.gras(true).duo('DIFFERENCE', formatFCFA(s.diff)).gras(false);
        r.duo('Ecart especes', formatFCFA(s.ecart_especes));
        r.tiret().centre().ligne('Signature du gerant').ligne().ligne();
        r.couper();
        return r.buffer();
      },
      () => this.console.imprimerRapportSequence(s),
    );
  }
}

/**
 * Imprime un ticket de TEST sur une imprimante donnée. Contrairement aux
 * impressions normales (qui replient sur la console en cas d'échec), le test
 * PROPAGE l'erreur pour que le menu Réglages affiche un message clair.
 * `queue` = nom d'imprimante Windows, chemin UNC `\\host\partage`, ou file CUPS.
 *
 * Le test imprime AUSSI le logo dans ses deux encodages, étiquetés A et B :
 * c'est le seul moyen de savoir lequel cette imprimante comprend (une commande
 * image non reconnue sort en charabia). On choisit ensuite le mode gagnant dans
 * Réglages → Imprimantes, sans jamais risquer un vrai ticket client.
 */
export async function imprimerTest(
  queue: string,
  nomResto = 'Chez Samer',
  marque: Marque = 'SAMER',
  colonnes: number = COLONNES_DEFAUT,
): Promise<void> {
  await envoyerRaw(queue, construireTest(queue, nomResto, marque, colonnes));
}

/** Construit le ticket de test (séparé de l'envoi : rend le rendu vérifiable). */
export function construireTest(
  queue: string,
  nomResto = 'Chez Samer',
  marque: Marque = 'SAMER',
  colonnes: number = COLONNES_DEFAUT,
): Buffer {
  const r = new Ruban(colonnes);
  r.init().centre();
  r.taille(2).gras(true).ligne(nomResto).taille().gras(false);
  r.ligne().gras(true).ligne('TEST IMPRESSION').gras(false);
  r.ligne(horodatage());
  r.gauche().ligne('-'.repeat(COLONNES_POSSIBLES[0]));
  r.duo('Imprimante', queue.length > 20 ? queue.slice(0, 20) : queue);

  // 1) Largeur du papier. Chaque essai imprime une ligne de la longueur testée,
  //    bornée par des crochets : celle qui tient sur UNE seule ligne donne le
  //    bon réglage. Si un essai déborde, sa fin bascule à la ligne suivante —
  //    c'est exactement ce qui décale les montants des vrais tickets.
  // Tout le texte d'explication tient en 32 colonnes : ce ticket doit rester
  // lisible AVANT que la largeur ne soit correctement réglée.
  r.ligne().gras(true).ligne('1) LARGEUR DU PAPIER').gras(false);
  r.ligne('Gardez le plus grand essai').ligne('qui tient sur UNE ligne :').ligne();
  for (const n of COLONNES_POSSIBLES) {
    const etiquette = ` ${n} `;
    const reste = n - 2 - etiquette.length;
    r.ligne(`[${etiquette}${'='.repeat(Math.max(0, reste))}]`);
  }

  // 2) Logo : une commande image non reconnue s'imprime comme du texte, donc on
  //    compare les deux encodages sur papier plutôt que de deviner le modèle.
  r.ligne().gras(true).ligne('2) LOGO').gras(false);
  r.ligne('Gardez le mode qui affiche').ligne('le logo, sans charabia :').ligne();
  for (const [etiquette, mode] of [['A', 'raster'], ['B', 'bandes']] as const) {
    r.gras(true).ligne(`--- MODE ${etiquette} (${mode}) ---`).gras(false);
    const image = logoTicket(marque, mode);
    if (image) r.brut(image).ligne();
    else r.ligne('(logo introuvable sur ce poste)');
    r.ligne();
  }

  r.ligne('-'.repeat(COLONNES_POSSIBLES[0]));
  r.centre().ligne('Reglages > Imprimantes').ligne('pour enregistrer vos choix.');
  r.couper();
  return r.buffer();
}
