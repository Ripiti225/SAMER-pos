/**
 * Client ISAPI de la pointeuse Hikvision (DS-K1T320EFWX et famille MinMoe).
 *
 * L'appareil est sur le réseau local du restaurant : le serveur POS l'interroge
 * en HTTP, avec l'authentification « Digest » qu'impose Hikvision (fetch ne la
 * gère pas, d'où la petite implémentation ci-dessous, MD5 + qop=auth).
 *
 * Trois usages seulement :
 *   - identifier l'appareil (n° de série) — sert aussi de test de connexion ;
 *   - lire les pointages depuis une date (AcsEvent, paginé) ;
 *   - créer / mettre à jour un employé dans l'appareil (le visage, lui,
 *     s'enrôle sur la pointeuse).
 */
import { createHash, randomBytes } from 'node:crypto';

export interface ConfigPointeuse {
  /** http://192.168.1.50 (sans chemin). */
  url: string;
  utilisateur: string;
  motDePasse: string;
}

export interface InfoAppareil {
  numero_serie: string;
  modele: string | null;
  nom: string | null;
}

/** Pointage brut, tel que renvoyé par l'appareil, déjà normalisé. */
export interface EvenementBrut {
  numero: number;
  employe_no: string;
  nom: string | null;
  /** null = l'appareil n'a pas dit Entrée ou Sortie (mode présence désactivé). */
  sens: 'ENTREE' | 'SORTIE' | null;
  pointe_le: Date;
}

const DELAI_MS = 10_000;

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

function lireDefi(entete: string): Record<string, string> {
  const champs: Record<string, string> = {};
  for (const m of entete.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    champs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return champs;
}

function enteteDigest(cfg: ConfigPointeuse, methode: string, uri: string, defi: Record<string, string>): string {
  const ha1 = md5(`${cfg.utilisateur}:${defi.realm}:${cfg.motDePasse}`);
  const ha2 = md5(`${methode}:${uri}`);
  const cnonce = randomBytes(8).toString('hex');
  const nc = '00000001';
  const qop = defi.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : null;
  const reponse = qop
    ? md5(`${ha1}:${defi.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${defi.nonce}:${ha2}`);
  const parts = [
    `username="${cfg.utilisateur}"`,
    `realm="${defi.realm}"`,
    `nonce="${defi.nonce}"`,
    `uri="${uri}"`,
    `response="${reponse}"`,
    'algorithm=MD5',
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (defi.opaque) parts.push(`opaque="${defi.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export class ErreurPointeuse extends Error {}

/** Requête authentifiée : un premier essai pour obtenir le défi, puis la vraie. */
async function requete(cfg: ConfigPointeuse, methode: string, uri: string, corps?: unknown): Promise<string> {
  const url = cfg.url.replace(/\/+$/, '') + uri;
  // FormData (photo) : fetch pose lui-même l'en-tête multipart et sa frontière.
  const multipart = corps instanceof FormData;
  const init = (auth?: string): RequestInit => ({
    method: methode,
    headers: {
      ...(corps !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Authorization: auth } : {}),
    },
    body: multipart ? corps : corps !== undefined ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(DELAI_MS),
  });

  let rep: Response;
  try {
    rep = await fetch(url, init());
    if (rep.status === 401) {
      const defi = rep.headers.get('www-authenticate');
      await rep.arrayBuffer().catch(() => undefined);
      if (!defi || !/digest/i.test(defi)) throw new ErreurPointeuse('La pointeuse refuse la connexion (authentification inconnue)');
      rep = await fetch(url, init(enteteDigest(cfg, methode, uri, lireDefi(defi))));
    }
  } catch (e) {
    if (e instanceof ErreurPointeuse) throw e;
    throw new ErreurPointeuse(`Pointeuse injoignable à ${cfg.url} — vérifiez qu'elle est allumée et sur le même réseau`);
  }

  const texte = await rep.text();
  if (rep.status === 401) throw new ErreurPointeuse('Identifiant ou mot de passe de la pointeuse incorrect');
  if (!rep.ok) {
    const sous = /"subStatusCode"\s*:\s*"([^"]+)"/.exec(texte)?.[1] ?? /<subStatusCode>([^<]+)/.exec(texte)?.[1];
    throw new ErreurPointeuse(`La pointeuse a répondu ${rep.status}${sous ? ` (${sous})` : ''}`);
  }
  return texte;
}

export async function lireInfoAppareil(cfg: ConfigPointeuse): Promise<InfoAppareil> {
  const xml = await requete(cfg, 'GET', '/ISAPI/System/deviceInfo');
  const champ = (nom: string) => new RegExp(`<${nom}>([^<]*)</${nom}>`).exec(xml)?.[1]?.trim() || null;
  const numero = champ('serialNumber');
  if (!numero) throw new ErreurPointeuse('Réponse inattendue : ce n’est pas une pointeuse Hikvision');
  return { numero_serie: numero, modele: champ('model'), nom: champ('deviceName') };
}

/** Sens d'un pointage : les touches de la pointeuse (attendanceStatus). */
export function sensDuStatut(statut: unknown): 'ENTREE' | 'SORTIE' | null {
  switch (statut) {
    case 'checkIn':
    case 'breakIn':
    case 'overtimeIn':
      return 'ENTREE';
    case 'checkOut':
    case 'breakOut':
    case 'overtimeOut':
      return 'SORTIE';
    default:
      return null;
  }
}

/** Date au format attendu par l'appareil (Abidjan = UTC, pas d'heure d'été). */
function dateIsapi(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

interface ReponseAcsEvent {
  AcsEvent?: {
    responseStatusStrg?: string;
    numOfMatches?: number;
    InfoList?: Array<{
      serialNo?: number;
      employeeNoString?: string;
      employeeNo?: number | string;
      name?: string;
      time?: string;
      attendanceStatus?: string;
    }>;
  };
}

/**
 * Pointages enregistrés depuis `depuis`. Seuls les événements qui portent un
 * n° d'employé sont gardés : un visage non reconnu ou une ouverture de porte
 * n'en ont pas.
 */
export async function lireEvenements(cfg: ConfigPointeuse, depuis: Date, jusqua = new Date()): Promise<EvenementBrut[]> {
  const resultat: EvenementBrut[] = [];
  const searchID = randomBytes(8).toString('hex');
  let position = 0;
  // Garde-fou : 100 pages de 30 = 3 000 pointages par lecture.
  for (let page = 0; page < 100; page++) {
    const texte = await requete(cfg, 'POST', '/ISAPI/AccessControl/AcsEvent?format=json', {
      AcsEventCond: {
        searchID,
        searchResultPosition: position,
        maxResults: 30,
        major: 5, // événements de contrôle d'accès
        minor: 0, // tous
        startTime: dateIsapi(depuis),
        endTime: dateIsapi(jusqua),
      },
    });
    const rep = JSON.parse(texte) as ReponseAcsEvent;
    const liste = rep.AcsEvent?.InfoList ?? [];
    for (const ev of liste) {
      const employe = String(ev.employeeNoString ?? ev.employeeNo ?? '').trim();
      if (!employe || ev.serialNo === undefined || !ev.time) continue;
      const date = new Date(ev.time);
      if (Number.isNaN(date.getTime())) continue;
      resultat.push({
        numero: ev.serialNo,
        employe_no: employe,
        nom: ev.name?.trim() || null,
        sens: sensDuStatut(ev.attendanceStatus),
        pointe_le: date,
      });
    }
    position += rep.AcsEvent?.numOfMatches ?? liste.length;
    if (rep.AcsEvent?.responseStatusStrg !== 'MORE' || liste.length === 0) break;
  }
  return resultat.sort((a, b) => a.numero - b.numero);
}

/**
 * Crée l'employé dans la pointeuse, ou met à jour son nom s'il y est déjà.
 * Le nom est tronqué : l'appareil refuse au-delà de 32 octets.
 */
export async function enregistrerEmploye(cfg: ConfigPointeuse, employeNo: string, nom: string): Promise<void> {
  let court = nom.trim();
  while (Buffer.byteLength(court, 'utf8') > 32) court = court.slice(0, -1);
  const fiche = {
    UserInfo: {
      employeeNo: employeNo,
      name: court,
      userType: 'normal',
      Valid: { enable: true, beginTime: '2026-01-01T00:00:00', endTime: '2037-12-31T23:59:59', timeType: 'local' },
      doorRight: '1',
      RightPlan: [{ doorNo: 1, planTemplateNo: '1' }],
    },
  };
  try {
    // SetUp = « ajoute ou modifie » (micrologiciels récents).
    await requete(cfg, 'PUT', '/ISAPI/AccessControl/UserInfo/SetUp?format=json', fiche);
  } catch (e) {
    if (!(e instanceof ErreurPointeuse) || /injoignable|incorrect/.test(e.message)) throw e;
    try {
      await requete(cfg, 'POST', '/ISAPI/AccessControl/UserInfo/Record?format=json', fiche);
    } catch {
      await requete(cfg, 'PUT', '/ISAPI/AccessControl/UserInfo/Modify?format=json', fiche);
    }
  }
}

/** La pointeuse refuse les photos au-delà de 200 Ko, et n'accepte que le JPEG. */
export const TAILLE_MAX_PHOTO = 200 * 1024;

/**
 * Enregistre le visage d'un employé à partir d'une photo JPEG, à la place
 * d'un enrôlement devant l'appareil. La pointeuse peut la refuser (visage
 * flou, de profil, trop petit) : le message de l'appareil est remonté tel quel.
 */
export async function enregistrerVisage(cfg: ConfigPointeuse, employeNo: string, jpeg: Buffer): Promise<void> {
  const formulaire = () => {
    const f = new FormData();
    f.append('FaceDataRecord', JSON.stringify({ faceLibType: 'blackFD', FDID: '1', FPID: employeNo }));
    f.append('img', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'visage.jpg');
    return f;
  };
  try {
    // FDSetUp = « ajoute ou remplace » (micrologiciels récents).
    await requete(cfg, 'PUT', '/ISAPI/Intelligent/FDLib/FDSetUp?format=json', formulaire());
  } catch (e) {
    if (!(e instanceof ErreurPointeuse) || /injoignable|incorrect/.test(e.message)) throw e;
    await requete(cfg, 'POST', '/ISAPI/Intelligent/FDLib/FaceDataRecord?format=json', formulaire());
  }
}
