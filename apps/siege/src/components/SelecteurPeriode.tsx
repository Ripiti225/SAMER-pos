import { listePeriodes, type Periode } from '../periode';

/** Les cinq périodes en chips. Un seul geste, pas de calendrier à remplir. */
export function SelecteurPeriode({ valeur, onChoisir }: { valeur: Periode; onChoisir: (p: Periode) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {listePeriodes().map((p) => (
        <button
          key={p.cle}
          type="button"
          onClick={() => onChoisir(p)}
          className={`min-h-[40px] rounded-btn border px-4 text-sm font-semibold transition ${
            p.cle === valeur.cle
              ? 'border-marque bg-marque text-sur-marque'
              : 'border-filet bg-carte text-doux hover:border-marque hover:text-txt'
          }`}
        >
          {p.libelle}
        </button>
      ))}
    </div>
  );
}
