/**
 * Sonnerie « commande prête » du téléphone ou de la tablette du serveur.
 *
 * Un bip d'une demi-seconde se perdait dans le bruit de la salle : le plat
 * refroidissait au passe. On fait donc sonner comme un téléphone — une
 * mélodie qui revient pendant DURÉE_SONNERIE_S (au moins 10 s), avec
 * vibration sur Android, jusqu'à ce que le serveur touche « Servie » ou
 * « Arrêter ».
 *
 * Pourquoi pas la sonnerie du téléphone lui-même : l'app est servie en http
 * sur le réseau du restaurant, et un navigateur n'ouvre ni les notifications
 * système ni la sonnerie à une page qui n'est pas en https. La mélodie est
 * donc jouée par la page (volume MÉDIA du téléphone).
 *
 * Le son est synthétisé (Web Audio) : rien à télécharger, rien qui puisse
 * manquer hors ligne.
 */

export const DUREE_SONNERIE_S = 15;

/** Une note de la mélodie : fréquence (Hz), départ et durée (s) dans le motif. */
export interface Note {
  frequence: number;
  debut: number;
  duree: number;
}

/** Motif d'une seconde et demie, répété : quatre notes montantes, deux fois. */
const DO6 = 1046.5;
const MI6 = 1318.5;
const SOL6 = 1568.0;
const DO7 = 2093.0;
const MOTIF: Note[] = [
  { frequence: DO6, debut: 0, duree: 0.14 },
  { frequence: MI6, debut: 0.15, duree: 0.14 },
  { frequence: SOL6, debut: 0.3, duree: 0.14 },
  { frequence: DO7, debut: 0.45, duree: 0.28 },
  { frequence: DO6, debut: 0.8, duree: 0.14 },
  { frequence: MI6, debut: 0.95, duree: 0.14 },
  { frequence: SOL6, debut: 1.1, duree: 0.14 },
  { frequence: DO7, debut: 1.25, duree: 0.28 },
];
const PERIODE_MOTIF_S = 2.2; // motif + un silence, comme une sonnerie

/** Toutes les notes à jouer pour une sonnerie de `dureeS` secondes. */
export function partition(dureeS = DUREE_SONNERIE_S): Note[] {
  const notes: Note[] = [];
  for (let depart = 0; depart < dureeS; depart += PERIODE_MOTIF_S) {
    for (const n of MOTIF) {
      if (depart + n.debut + n.duree > dureeS) continue;
      notes.push({ ...n, debut: depart + n.debut });
    }
  }
  return notes;
}

/** Vibration Android calée sur la mélodie : vibre pendant chaque motif. */
export function motifVibration(dureeS = DUREE_SONNERIE_S): number[] {
  const motif: number[] = [];
  for (let t = 0; t < dureeS; t += PERIODE_MOTIF_S) motif.push(1500, 700);
  return motif;
}

type AudioCtor = typeof AudioContext;
let contexte: AudioContext | null = null;

function obtenirContexte(): AudioContext | null {
  if (contexte) return contexte;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  contexte = new Ctor();
  return contexte;
}

/**
 * Le navigateur ne laisse sonner une page qu'après un premier toucher. On
 * débloque donc le son au tout premier geste (le PIN de connexion suffit) :
 * sans ça, la première commande prête de la journée resterait muette.
 */
export function deverrouillerSon(): void {
  const debloquer = () => {
    const ctx = obtenirContexte();
    if (!ctx) return;
    void ctx.resume();
    // Un son vide joué pendant le geste : nécessaire sur iPhone/iPad.
    const tampon = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = tampon;
    source.connect(ctx.destination);
    source.start(0);
  };
  for (const e of ['pointerdown', 'touchstart', 'keydown'] as const) {
    window.addEventListener(e, debloquer, { passive: true });
  }
}

let arretEnCours: (() => void) | null = null;

/** Fait sonner ; une sonnerie déjà en cours repart de zéro. Renvoie l'arrêt. */
export function sonner(dureeS = DUREE_SONNERIE_S): () => void {
  arreterSonnerie();
  const ctx = obtenirContexte();
  const sorties: OscillatorNode[] = [];
  if (ctx) {
    void ctx.resume();
    const general = ctx.createGain();
    general.gain.value = 0.9;
    // Le compresseur rend la mélodie FORTE sans saturer le petit haut-parleur.
    const compresseur = ctx.createDynamicsCompressor();
    general.connect(compresseur).connect(ctx.destination);
    const t0 = ctx.currentTime + 0.05;
    for (const n of partition(dureeS)) {
      const osc = ctx.createOscillator();
      const enveloppe = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = n.frequence;
      const debut = t0 + n.debut;
      enveloppe.gain.setValueAtTime(0, debut);
      enveloppe.gain.linearRampToValueAtTime(1, debut + 0.01);
      enveloppe.gain.exponentialRampToValueAtTime(0.001, debut + n.duree);
      osc.connect(enveloppe).connect(general);
      osc.start(debut);
      osc.stop(debut + n.duree + 0.02);
      sorties.push(osc);
    }
  }
  try { navigator.vibrate?.(motifVibration(dureeS)); } catch { /* iPhone : pas de vibration web */ }

  const arret = () => {
    for (const osc of sorties) { try { osc.stop(); } catch { /* déjà terminé */ } }
    try { navigator.vibrate?.(0); } catch { /* idem */ }
    if (arretEnCours === arret) arretEnCours = null;
  };
  arretEnCours = arret;
  return arret;
}

export function arreterSonnerie(): void {
  arretEnCours?.();
}
