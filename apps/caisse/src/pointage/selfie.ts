/**
 * Réduit le selfie sur le téléphone avant l'envoi (≈ 640 px, JPEG ~50 Ko) :
 * le wifi du restaurant est partagé, et le serveur refuse au-delà de 400 Ko.
 * Rien ici n'exige une connexion sécurisée (la page est en http sur le LAN).
 */
const COTE_MAX = 640;
const QUALITES = [0.72, 0.6, 0.45] as const;
/** Base64 d'environ 300 Ko de JPEG : marge sous la limite du serveur. */
const LONGUEUR_MAX_DATA_URL = 400_000;

function chargerImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resoudre, rejeter) => {
    const img = new Image();
    img.onload = () => resoudre(img);
    img.onerror = () => rejeter(new Error('Photo illisible'));
    img.src = url;
  });
}

/** Fichier de l'appareil photo → `data:image/jpeg;base64,…` réduit. */
export async function reduireSelfie(fichier: File): Promise<string> {
  const url = URL.createObjectURL(fichier);
  try {
    const img = await chargerImage(url);
    const echelle = Math.min(1, COTE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * echelle));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * echelle));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Photo illisible');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of QUALITES) {
      const data = canvas.toDataURL('image/jpeg', q);
      if (data.length <= LONGUEUR_MAX_DATA_URL) return data;
    }
    throw new Error('Photo trop lourde');
  } finally {
    URL.revokeObjectURL(url);
  }
}
