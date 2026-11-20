import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconDownload } from '@tabler/icons-react';
import { appelPromo, ErreurSiege, type CodePromo, type FichePromo, type LotPromo } from '../api';
import { grille, parFeuille, REGLAGES_PAR_DEFAUT, type Reglages } from '../planche/reglages';
import { Erreur, Info, Squelette } from './Etat';

const CLE_REGLAGES = 'siege-planche-reglages';

/** Les réglages de la dernière planche, gardés dans ce navigateur. */
function reglagesGardes(): Reglages {
  try {
    const brut = JSON.parse(localStorage.getItem(CLE_REGLAGES) ?? 'null') as Partial<Reglages> | null;
    return { ...REGLAGES_PAR_DEFAUT, ...(brut ?? {}) };
  } catch {
    return REGLAGES_PAR_DEFAUT;
  }
}

function garder(r: Reglages) {
  try {
    localStorage.setItem(CLE_REGLAGES, JSON.stringify(r));
  } catch {
    // Navigation privée : les réglages ne seront simplement pas retenus.
  }
}

function telecharger(nom: string, contenu: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = nom;
  lien.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CHAMPS: { cle: keyof Reglages; libelle: string }[] = [
  { cle: 'feuilleL', libelle: 'Feuille, largeur' },
  { cle: 'feuilleH', libelle: 'Feuille, hauteur' },
  { cle: 'autocollantL', libelle: 'Autocollant, largeur' },
  { cle: 'autocollantH', libelle: 'Autocollant, hauteur' },
  { cle: 'fondPerdu', libelle: 'Fond perdu' },
  { cle: 'ecart', libelle: 'Écart entre deux' },
  { cle: 'marge', libelle: 'Marge de la feuille' },
  { cle: 'rayon', libelle: 'Rayon des coins' },
];

/**
 * Planche vinyle d'un lot (brief PROMO § 7.5) : le PDF impression + découpe,
 * et un SVG de découpe seule par feuille. Fabriqués dans le navigateur à partir
 * des codes du lot : rien n'est stocké, on peut la retélécharger à volonté.
 */
export function PlancheLot({ lot, fiche, onFermer }: { lot: LotPromo; fiche: FichePromo | undefined; onFermer: () => void }) {
  const [r, setR] = useState<Reglages>(reglagesGardes);
  const [enCours, setEnCours] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [adresse, setAdresse] = useState<string | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: ['promo_lot_codes', lot.id],
    queryFn: () => appelPromo<{ codes: CodePromo[] }>('lot_codes', { restaurant_id: lot.restaurant_id, lot_id: lot.id }),
    staleTime: 60_000,
  });
  const codes = (data?.codes ?? []).filter((c) => c.statut !== 'ANNULE').map((c) => c.code);
  const { grille: g, erreurs } = grille(r);
  const feuilles = g.parFeuille > 0 ? parFeuille(codes, g) : [];
  const nom = `lot-${lot.id.slice(0, 8)}`;

  const changer = (cle: keyof Reglages, valeur: string) => {
    const suivant = { ...r, [cle]: Number(valeur.replace(',', '.')) };
    setR(suivant);
    garder(suivant);
  };

  const pdf = async () => {
    if (!fiche) return;
    setEnCours(true);
    setErreur(null);
    try {
      const [{ genererPlanche }, { chargerPolices }] = await Promise.all([import('../planche/pdf'), import('../planche/polices')]);
      const planche = await genererPlanche(
        {
          codes,
          pourcentage: lot.pourcentage,
          valideDu: lot.valide_du,
          valideAu: lot.valide_au,
          libelle: lot.libelle,
          restaurant: { nom: fiche.nom, marque: fiche.marque, telephone: fiche.telephone, adresse: fiche.adresse },
        },
        r,
        await chargerPolices(),
      );
      setAdresse(planche.adresseRaccourcie ? planche.ligneAdresse : null);
      // `slice()` : une copie sur un ArrayBuffer simple, ce qu'un Blob accepte.
      telecharger(`${nom}-impression-decoupe.pdf`, planche.pdf.slice(), 'application/pdf');
    } catch (e) {
      setErreur(e instanceof Error ? e.message : 'Fabrication de la planche impossible');
    } finally {
      setEnCours(false);
    }
  };

  const svg = async (index: number) => {
    const { svgDecoupe } = await import('../planche/svg');
    const suffixe = feuilles.length > 1 ? `-feuille-${index + 1}-sur-${feuilles.length}` : '';
    telecharger(`${nom}-decoupe-seule${suffixe}.svg`, svgDecoupe(r, feuilles[index]!.length), 'image/svg+xml');
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-12" onClick={onFermer}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Planche à imprimer"
        className="w-full max-w-2xl rounded-jeton border border-filet bg-carte p-6 shadow-e2"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-xl font-bold">Planche à imprimer — {lot.libelle}</h2>
        <p className="mb-4 text-sm text-doux">
          Vinyle autocollant, à l’échelle 1:1, pour n’importe quel imprimeur : fond perdu, tracé de coupe « CutContour » sur un
          calque à part, couleurs en CMJN, polices incorporées.
        </p>

        {!fiche?.telephone || !fiche.adresse ? (
          <Info>Renseignez d’abord le téléphone et l’adresse de ce restaurant dans « Fiches restaurants » : ils s’impriment sur chaque autocollant.</Info>
        ) : null}
        {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture des codes impossible'} />}

        <details className="mb-4 rounded-btn border border-filet px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold">Réglages de la feuille (en mm)</summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {CHAMPS.map((c) => (
              <label key={c.cle} className="block text-[13px] text-doux">
                {c.libelle}
                <input className="champ mt-1" inputMode="decimal" value={String(r[c.cle])} onChange={(e) => changer(c.cle, e.target.value)} />
              </label>
            ))}
          </div>
          <button type="button" className="btn-blanc mt-3 !min-h-[36px] !text-[13px]" onClick={() => { setR(REGLAGES_PAR_DEFAUT); garder(REGLAGES_PAR_DEFAUT); }}>
            Revenir aux réglages d’origine (1 m², 85 × 55)
          </button>
        </details>

        {erreurs.length > 0 && <Erreur texte={erreurs.join(' · ')} />}

        {isPending ? (
          <Squelette lignes={1} />
        ) : (
          <p className="mb-4 rounded-btn bg-marque-tint px-4 py-3 text-sm">
            <b>{codes.length} autocollants</b> · {g.colonnes} × {g.rangees} = {g.parFeuille} par feuille ·{' '}
            <b>
              {feuilles.length} feuille{feuilles.length > 1 ? 's' : ''}
            </b>
            {feuilles.length > 1 && ` (${feuilles.map((f) => f.length).join(' + ')})`}
          </p>
        )}

        {adresse && (
          <p className="mb-4 rounded-sm bg-attente-tint px-3 py-2 text-sm text-attente-txt">
            L’adresse ne tenait pas sur une ligne à la taille minimale (2 mm) : elle est imprimée ainsi — « {adresse} ». Pour
            choisir le texte, raccourcissez-la dans « Fiches restaurants ».
          </p>
        )}
        {erreur && <Erreur texte={erreur} />}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-accent"
            disabled={enCours || isPending || codes.length === 0 || erreurs.length > 0 || !fiche}
            onClick={() => void pdf()}
          >
            <IconDownload size={18} /> {enCours ? 'Fabrication…' : 'PDF impression + découpe'}
          </button>
          {feuilles.map((f, i) => (
            <button key={i} type="button" className="btn-blanc" disabled={erreurs.length > 0} onClick={() => void svg(i)}>
              <IconDownload size={18} /> Découpe seule{feuilles.length > 1 ? ` · feuille ${i + 1}` : ''} (SVG)
            </button>
          ))}
        </div>
        <p className="mt-4 text-[13px] text-doux">
          Avant de lancer tout le lot : imprimez un autocollant et vérifiez que le QR se lit bien avec un téléphone.
        </p>
        <div className="mt-4 flex justify-end">
          <button type="button" className="btn-blanc" onClick={onFermer}>Fermer</button>
        </div>
      </div>
    </div>
  );
}
