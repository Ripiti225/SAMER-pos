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
import type { CommandeVue, RapportZ } from '@pos/shared';
import { formatFCFA, LIBELLES_MODES, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { db } from '../db/client.js';
import { parametresLocaux, restaurant } from '../db/schema/index.js';
import type { PrinterService } from './PrinterService.js';
import { ConsolePrinter } from './ConsolePrinter.js';
import { rasterLogo } from './logo.js';

const LARGEUR = 48;

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

/** Constructeur de flux ESC/POS. */
class Ruban {
  private o: number[] = [];
  private push(...b: (number | string)[]): void {
    for (const x of b) {
      if (typeof x === 'string') for (const c of Buffer.from(ascii(x), 'latin1')) this.o.push(c);
      else this.o.push(x);
    }
  }
  init(): this { this.push(0x1b, 0x40); return this; }
  gauche(): this { this.push(0x1b, 0x61, 0x00); return this; }
  centre(): this { this.push(0x1b, 0x61, 0x01); return this; }
  gras(on: boolean): this { this.push(0x1b, 0x45, on ? 0x01 : 0x00); return this; }
  /** Taille : 0 = normal, 1 = double hauteur+largeur. */
  taille(grande: boolean): this { this.push(0x1d, 0x21, grande ? 0x11 : 0x00); return this; }
  texte(s: string): this { this.push(s); return this; }
  ligne(s = ''): this { this.push(s, 0x0a); return this; }
  /** Insère des octets ESC/POS bruts (ex. logo raster). */
  brut(b: Buffer): this { for (const x of b) this.o.push(x); return this; }
  /** Ligne à deux colonnes (gauche + droite) alignée sur 48 caractères. */
  duo(g: string, d: string): this {
    const gauche = ascii(g), droite = ascii(d);
    const espace = Math.max(1, LARGEUR - gauche.length - droite.length);
    return this.ligne(gauche + ' '.repeat(espace) + droite);
  }
  tiret(): this { return this.ligne('-'.repeat(LARGEUR)); }
  couper(): this { this.push(0x0a, 0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x00); return this; }
  buffer(): Buffer { return Buffer.from(this.o); }
}

/** Envoi RAW multi-plateforme : Windows (copy /b) ou CUPS (lp). */
function envoyerRaw(queue: string, data: Buffer): Promise<void> {
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
 * Windows : impression RAW via `copy /b <fichier> \\localhost\<partage>`.
 * Le paramètre `imprimante_thermique_queue` = le NOM DE PARTAGE de l'imprimante
 * (imprimante partagée dans Windows), ou un chemin UNC complet `\\host\partage`.
 */
async function envoyerRawWindows(partage: string, data: Buffer): Promise<void> {
  // Le nom de partage passe par cmd.exe (copy) : on rejette tout métacaractère
  // (& | > < ^ " % ( ) …) pour empêcher toute injection de commande. Seuls les
  // caractères légitimes d'un nom de partage / chemin UNC sont autorisés.
  if (!/^[\\A-Za-z0-9 ._$-]+$/.test(partage)) {
    throw new Error('Nom de file d’impression invalide (caractères non autorisés)');
  }
  const tmp = join(tmpdir(), `pos-ticket-${randomBytes(6).toString('hex')}.bin`);
  await writeFile(tmp, data);
  try {
    await new Promise<void>((res, rej) => {
      const dest = partage.startsWith('\\\\') ? partage : `\\\\localhost\\${partage}`;
      const p = spawn('cmd', ['/c', 'copy', '/b', tmp, dest], { windowsHide: true });
      p.on('error', rej);
      p.on('close', (code) => (code === 0 ? res() : rej(new Error(`copy a renvoyé ${code}`))));
    });
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

/** En-tête commun (logo + nom + contact + type/table/ticket). */
function entete(r: Ruban, resto: { nom: string; entete: string; marque: 'SAMER' | 'AL_KAYAN' }, c: CommandeVue, titre: string): void {
  r.init().centre();
  const logo = rasterLogo(resto.marque);
  if (logo) r.brut(logo).ligne();
  r.taille(true).gras(true).ligne(resto.nom).taille(false).gras(false);
  if (resto.entete) for (const l of resto.entete.split('\n')) r.ligne(l);
  r.ligne().gras(true).ligne(titre).gras(false);
  const sous = `${LIBELLES_TYPES_COMMANDE[c.type]}${c.table_numero ? ` - Table ${c.table_numero}` : ''}${c.partenaire ? ` - ${c.partenaire}` : ''}`;
  r.ligne(sous).ligne(`Ticket n ${c.numero_ticket}   ${new Date().toLocaleString('fr-FR')}`);
  r.gauche().tiret();
}

function corpsArticles(r: Ruban, c: CommandeVue): void {
  for (const item of c.items) {
    if (item.statut_cuisine === 'ANNULE') continue;
    r.duo(`${item.quantite} x ${item.nom_snapshot}`, formatFCFA(item.total_ligne));
    for (const s of item.supplements) r.ligne(`   + ${s.nom} (${formatFCFA(s.prix)})`);
    for (const o of item.options) if (o.choix.length) r.ligne(`   ${o.groupe}: ${o.choix.join(', ')}`);
  }
  r.tiret();
  r.duo('Sous-total', formatFCFA(c.sous_total));
  if (c.promo_montant > 0) r.duo(`Promo ${c.promo_nom ?? ''}`, `-${formatFCFA(c.promo_montant)}`);
  if (c.remise_montant > 0) r.duo('Remise', `-${formatFCFA(c.remise_montant)}`);
  if (c.fidelite_montant > 0) r.duo('Fidelite', `-${formatFCFA(c.fidelite_montant)}`);
  r.gras(true).taille(true).duo('TOTAL', formatFCFA(c.total)).taille(false).gras(false);
}

/**
 * Imprimante thermique : ESC/POS si une file est configurée, sinon console.
 * La décision est prise À CHAQUE impression (le nom de file peut changer dans
 * Réglages sans redémarrer le serveur).
 */
export class EscposPrinter implements PrinterService {
  private console = new ConsolePrinter();

  private async queue(): Promise<string | null> {
    const [p] = await db
      .select()
      .from(parametresLocaux)
      .where(eq(parametresLocaux.cle, 'imprimante_thermique_queue'));
    const nom = typeof p?.valeur === 'string' ? p.valeur.trim() : '';
    return nom || null;
  }

  private async envoyer(construire: () => Buffer, replConsole: () => Promise<void>): Promise<void> {
    const q = await this.queue();
    if (!q) return replConsole();
    try {
      await envoyerRaw(q, construire());
    } catch (e) {
      console.error('Impression thermique échouée, repli console :', (e as Error).message);
      await replConsole();
    }
  }

  private async infosResto(): Promise<{ nom: string; entete: string; pied: string; marque: 'SAMER' | 'AL_KAYAN' }> {
    const params = await db.select().from(parametresLocaux);
    const val = (cle: string): string => {
      const p = params.find((x) => x.cle === cle);
      return typeof p?.valeur === 'string' ? p.valeur : '';
    };
    const [resto] = await db.select().from(restaurant).limit(1);
    return {
      nom: resto?.nom ?? 'Chez Samer',
      entete: val('ticket_entete'),
      pied: val('ticket_pied'),
      marque: (resto?.marque as 'SAMER' | 'AL_KAYAN') ?? 'SAMER',
    };
  }

  async imprimerFacture(c: CommandeVue): Promise<void> {
    const info = await this.infosResto();
    await this.envoyer(
      () => {
        const r = new Ruban();
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
        const r = new Ruban();
        entete(r, info, c, 'RECU');
        corpsArticles(r, c);
        r.tiret();
        for (const p of c.paiements) r.duo(LIBELLES_MODES[p.mode], formatFCFA(p.montant));
        r.tiret().centre().ligne('Paye - merci de votre visite !');
        if (info.pied) r.ligne(info.pied);
        r.couper();
        return r.buffer();
      },
      () => this.console.imprimerTicket(c),
    );
  }

  async imprimerRapportZ(z: RapportZ): Promise<void> {
    await this.envoyer(
      () => {
        const r = new Ruban();
        r.init().centre().gras(true).taille(true).ligne('RAPPORT Z').taille(false).gras(false);
        r.ligne(z.caissier).ligne(new Date(z.ouvert_le).toLocaleString('fr-FR')).gauche().tiret();
        r.duo('Commandes encaissees', String(z.nb_commandes_payees));
        r.duo('Commandes annulees', String(z.nb_commandes_annulees));
        r.duo('Total ventes', formatFCFA(z.total_ventes));
        r.duo('Total remises', formatFCFA(z.total_remises));
        r.duo('Total promotions', formatFCFA(z.total_promos));
        r.tiret();
        for (const [mode, montant] of Object.entries(z.par_mode)) if (montant > 0) r.duo(mode, formatFCFA(montant));
        r.tiret();
        r.duo('Fond de caisse', formatFCFA(z.fond_de_caisse));
        r.duo('Especes comptees', formatFCFA(z.especes_comptees));
        r.duo('Especes theoriques', formatFCFA(z.especes_theorique));
        r.gras(true).duo('ECART', formatFCFA(z.ecart)).gras(false);
        r.couper();
        return r.buffer();
      },
      () => this.console.imprimerRapportZ(z),
    );
  }
}
