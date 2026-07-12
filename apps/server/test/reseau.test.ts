/**
 * Résolution de l'adresse des QR clients : un domaine/IP explicite est préservé,
 * `localhost` est remplacé par l'IP LAN détectée (sinon un QR n'est pas joignable
 * depuis un téléphone).
 */
import { describe, expect, it } from 'vitest';
import { adresseReseauLocale, PORT_CLIENT_DEFAUT, resoudreBaseClient } from '../src/lib/reseau.js';

describe('resoudreBaseClient', () => {
  it('préserve un vrai domaine et retire le slash final', () => {
    expect(resoudreBaseClient('https://menu.samer.ci/')).toBe('https://menu.samer.ci');
  });

  it('préserve une IP/host explicite non locale', () => {
    expect(resoudreBaseClient('http://192.168.4.2:5176')).toBe('http://192.168.4.2:5176');
  });

  it('nettoie une valeur non-URL', () => {
    expect(resoudreBaseClient('192.168.1.9:5176/')).toBe('192.168.1.9:5176');
  });

  it('remplace localhost par l’IP LAN quand un réseau est présent', () => {
    const ip = adresseReseauLocale();
    const resolu = resoudreBaseClient('http://localhost:5176');
    if (ip) {
      expect(resolu).not.toContain('localhost');
      expect(resolu).toContain(ip);
      expect(resolu).toContain(':5176');
    } else {
      // Machine sans réseau : on garde localhost faute de mieux.
      expect(resolu).toContain('localhost');
    }
  });

  it('valeur vide → adresse client sur le port par défaut', () => {
    const resolu = resoudreBaseClient('');
    expect(resolu).toMatch(/^http:\/\//);
    expect(resolu.endsWith(`:${PORT_CLIENT_DEFAUT}`)).toBe(true);
  });
});
