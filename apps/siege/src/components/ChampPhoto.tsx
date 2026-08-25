import { useRef, useState } from 'react';
import { IconPhoto, IconTrash } from '@tabler/icons-react';
import { appelSiege, ErreurSiege } from '../api';
import { supabase } from '../supabase';

/** 2 Mo : au-delà, c'est une photo d'appareil non redimensionnée. */
const TAILLE_MAX = 2 * 1024 * 1024;

/**
 * Photo d'un article.
 *
 * Le fichier ne passe PAS par l'Edge Function : elle signe une URL, le
 * navigateur dépose l'image en direct dans le bucket public. C'est la même
 * convention que le catalogue existant, dont les `image_url` sont des URL
 * absolues vers un bucket de stockage.
 *
 * **Conséquence à connaître** : la photo vit sur internet. Une caisse coupée du
 * réseau vend parfaitement, mais n'affiche pas l'image — c'est déjà vrai du
 * catalogue actuel, la console ne change rien à cet équilibre.
 */
export function ChampPhoto({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const champ = useRef<HTMLInputElement>(null);

  const televerser = async (fichier: File) => {
    setErreur(null);
    if (!fichier.type.startsWith('image/')) {
      setErreur('Ce fichier n’est pas une image.');
      return;
    }
    if (fichier.size > TAILLE_MAX) {
      setErreur(`Image trop lourde (${Math.round(fichier.size / 1024 / 1024)} Mo) — 2 Mo au maximum.`);
      return;
    }

    setEnCours(true);
    try {
      const extension = (fichier.name.split('.').pop() ?? 'jpg').toLowerCase();
      const signature = await appelSiege<{ bucket: string; chemin: string; jeton: string; url_publique: string }>(
        'photo_signer',
        { extension },
      );
      const { error } = await supabase.storage
        .from(signature.bucket)
        .uploadToSignedUrl(signature.chemin, signature.jeton, fichier);
      if (error) throw new Error(error.message);
      onChange(signature.url_publique);
    } catch (e) {
      setErreur(e instanceof ErreurSiege ? e.message : 'Le téléversement a échoué.');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3">
        <div className="flex h-20 w-20 flex-none items-center justify-center overflow-hidden rounded-jeton border border-filet bg-carte-douce">
          {url ? (
            <img src={url} alt="" className="h-full w-full object-cover" />
          ) : (
            <IconPhoto size={26} className="text-faible" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-blanc !min-h-[38px] !px-3 !text-sm"
              disabled={enCours}
              onClick={() => champ.current?.click()}
            >
              {enCours ? 'Envoi…' : url ? 'Remplacer la photo' : 'Choisir une photo'}
            </button>
            {url && (
              <button
                type="button"
                className="btn-blanc !min-h-[38px] !px-3 !text-sm"
                onClick={() => onChange('')}
                title="Retirer la photo"
              >
                <IconTrash size={16} />
              </button>
            )}
          </div>
          <input
            ref={champ}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void televerser(f);
              e.target.value = '';
            }}
          />
          <p className="mt-1.5 text-xs text-faible">JPG, PNG, WebP ou AVIF — 2 Mo maximum.</p>
        </div>
      </div>

      {erreur && <p className="mt-2 text-sm text-alerte-txt">{erreur}</p>}

      {/* Coller une URL reste possible : les photos du catalogue actuel vivent
          déjà chez SamerTrackly, on doit pouvoir les réutiliser sans les
          retélécharger. */}
      <label className="mt-2 block text-xs text-faible">
        …ou coller l’adresse d’une photo existante
        <input
          className="champ mt-1 !min-h-[38px] !text-sm"
          value={url}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder="https://…/photos/produits/….png"
        />
      </label>
    </div>
  );
}
