/**
 * Détection de l'adresse IP du serveur sur le réseau local (LAN) — pour que les
 * QR de table encodent une adresse joignable depuis un téléphone, et non
 * `localhost` (qui ne désigne que le mini-PC lui-même).
 */
import { networkInterfaces } from 'node:os';

/** Port du serveur web de l'app client (mini-app téléphone /t/:token). */
export const PORT_CLIENT_DEFAUT = 5176;

/**
 * Ports LAN des plateformes servies par le mini-PC (Vite `host: true`), pour
 * générer les QR de connexion : un appareil du même WiFi ouvre `http://<ip>:port`.
 * Doivent rester alignés avec les `server.port` des vite.config respectifs.
 */
export const PORT_KDS = 5174;
export const PORT_SERVEUR = 5175;

/** Priorité aux plages privées classiques (box/routeur du restaurant). */
function score(ip: string): number {
  if (ip.startsWith('192.168.')) return 3;
  if (ip.startsWith('10.')) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  return 0;
}

/**
 * Première adresse IPv4 non interne (hors 127.0.0.1), en préférant les plages
 * privées du LAN. Renvoie `null` si la machine n'est sur aucun réseau.
 */
export function adresseReseauLocale(): string | null {
  const candidates: string[] = [];
  for (const cartes of Object.values(networkInterfaces())) {
    for (const c of cartes ?? []) {
      // family peut être 'IPv4' (Node ≤ 17) ou 4 (Node ≥ 18) selon la version.
      const estV4 = c.family === 'IPv4' || (c.family as unknown as number) === 4;
      if (estV4 && !c.internal) candidates.push(c.address);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0]!;
}

/** true si l'hôte ne désigne que la machine locale (donc inutile sur un QR). */
function estHoteLocal(hote: string): boolean {
  return hote === 'localhost' || hote === '127.0.0.1' || hote === '0.0.0.0' || hote === '::1';
}

/**
 * Résout l'adresse de base réellement encodée dans un QR à partir du paramètre
 * `url_base_client`. Si le paramètre est vide ou pointe sur la machine locale,
 * on substitue l'IP LAN détectée (en gardant le port configuré, sinon 5176).
 * Un vrai domaine/IP configuré est laissé tel quel. Jamais de slash final.
 */
export function resoudreBaseClient(configuree: string | null | undefined): string {
  const brut = (configuree ?? '').trim();
  const ip = adresseReseauLocale();

  if (!brut) {
    return ip ? `http://${ip}:${PORT_CLIENT_DEFAUT}` : `http://localhost:${PORT_CLIENT_DEFAUT}`;
  }
  try {
    const u = new URL(brut);
    if (ip && estHoteLocal(u.hostname)) u.hostname = ip;
    return u.toString().replace(/\/+$/, '');
  } catch {
    // Valeur non-URL (ex. « 192.168.1.23:5176 ») : renvoyée nettoyée.
    return brut.replace(/\/+$/, '');
  }
}
