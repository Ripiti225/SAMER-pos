// Ce qui s'écrit sur l'autocollant — variante A validée le 19/11/2026,
// tutoiement (maquette https://claude.ai/artifact/DTN4PSVRk6AcpRBSXUzrqp).

export type Marque = 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE';

/** Couleur d'impression : cyan, magenta, jaune, noir, de 0 à 1. */
export type Cmjn = [number, number, number, number];

/**
 * Couleurs d'impression, en CMJN. Les aplats de marque reprennent les
 * couleurs écran (#EF9F27, #2D7D46, #D99A2B) ; à valider sur une épreuve de
 * l'imprimeur. Les textes sombres sont en noir seul : un noir quadri sur des
 * caractères de 2 mm baverait au moindre défaut de repérage.
 */
export const COULEURS: Record<Marque, { fond: Cmjn; encre: Cmjn; nom: string }> = {
  SAMER: { fond: [0, 0.42, 0.91, 0], encre: [0, 0, 0, 1], nom: 'Chez Samer' },
  AL_KAYAN: { fond: [0.8, 0.2, 0.9, 0.2], encre: [0, 0, 0, 0], nom: 'Al Kayan' },
  A_LA_BRAISE: { fond: [0.12, 0.42, 0.95, 0.03], encre: [0, 0, 0, 1], nom: 'À la Braise' },
};

export const NOIR: Cmjn = [0, 0, 0, 1];
export const GRIS_TEXTE: Cmjn = [0, 0, 0, 0.85];
export const GRIS_DOUX: Cmjn = [0, 0, 0, 0.75];
export const GRIS_FILET: Cmjn = [0, 0, 0, 0.12];

/** Adresse que le QR ouvre : la page d'activation du site, le code en paramètre. */
export const URL_ACTIVATION = 'https://samer-delivery-site.vercel.app/fr/promo?c=';

export function urlActivation(code: string): string {
  return `${URL_ACTIVATION}${encodeURIComponent(code)}`;
}

/** « Samer Palmeraie » → marque « Chez Samer », site « Palmeraie ». */
export function marqueEtSite(nom: string, marque: Marque): { marque: string; site: string } {
  const prefixes: Record<Marque, RegExp> = {
    SAMER: /^(chez\s+)?samer\s*/i,
    AL_KAYAN: /^al\s+kayan\s*/i,
    A_LA_BRAISE: /^à\s+la\s+braise\s*/i,
  };
  return { marque: COULEURS[marque].nom, site: nom.replace(prefixes[marque], '').trim() };
}

/** `+2250777303333` → `07 77 30 33 33`. */
export function telephoneImprime(telephone: string | null): string {
  if (!telephone) return '';
  const n = telephone.replace(/^\+225/, '');
  return n.match(/.{1,2}/g)?.join(' ') ?? n;
}

/** « Du 20/11 au 17/12/2026 » (Abidjan = UTC). */
export function validite(valideDu: string, valideAu: string): string {
  const jm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return `Du ${jm(valideDu)} au ${jm(valideAu)}/${valideAu.slice(0, 4)}`;
}

/**
 * Première ligne du bandeau : adresse · téléphone · « Collez-moi sur le frigo ».
 * Les caractères ne descendent jamais sous 2 mm (brief : rien sous 6 pt) :
 * si la ligne est trop longue, on raccourcit l'adresse plutôt que la police —
 * d'abord à sa première virgule, puis avec des points de suspension.
 */
export function ligneAdresse(
  adresse: string | null,
  telephone: string | null,
  largeur: (texte: string) => number,
  largeurMax: number,
): { texte: string; raccourcie: boolean } {
  const tel = telephoneImprime(telephone);
  const composer = (a: string) => [a, tel, 'Collez-moi sur le frigo'].filter(Boolean).join(' · ');
  const complete = (adresse ?? '').trim();
  if (largeur(composer(complete)) <= largeurMax) return { texte: composer(complete), raccourcie: false };

  let courte = complete.split(',')[0]!.trim();
  if (largeur(composer(courte)) <= largeurMax) return { texte: composer(courte), raccourcie: true };
  while (courte.length > 1 && largeur(composer(`${courte}…`)) > largeurMax) courte = courte.slice(0, -1).trimEnd();
  return { texte: composer(courte.length > 1 ? `${courte}…` : ''), raccourcie: true };
}

/** Le texte de l'autocollant, hors adresse (variante A). */
export function textes(pourcentage: number, valideDu: string, valideAu: string) {
  return {
    accroche: 'NE ME JETTE PAS !',
    remise: `−${pourcentage} %`,
    sousTitre: ['sur ta prochaine', 'commande'],
    appel: 'Scanne-moi',
    sousAppel: ['ton numéro devient', 'ton code promo'],
    conditions: `Usage unique · ${validite(valideDu, valideAu)} · Hors Chawarma`,
  };
}
