interface Props {
  valeur: string;
  onChange: (v: string) => void;
  longueurMax?: number;
  onValider?: () => void;
  libelleValider?: string;
  validerDesactive?: boolean;
}

/** Pavé numérique tactile (boutons ≥ 48 px). */
export function Numpad({ valeur, onChange, longueurMax = 9, onValider, libelleValider = 'Valider', validerDesactive }: Props) {
  const taper = (c: string) => {
    if (valeur.length >= longueurMax) return;
    onChange(valeur === '0' ? c : valeur + c);
  };
  return (
    <div className="grid grid-cols-3 gap-2">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => (
        <button key={c} type="button" className="btn-sombre text-2xl py-4" onClick={() => taper(c)}>
          {c}
        </button>
      ))}
      <button type="button" className="btn-sombre text-xl" onClick={() => onChange('')}>
        C
      </button>
      <button type="button" className="btn-sombre text-2xl py-4" onClick={() => taper('0')}>
        0
      </button>
      <button type="button" className="btn-sombre text-xl" onClick={() => onChange(valeur.slice(0, -1))}>
        ⌫
      </button>
      {onValider && (
        <button
          type="button"
          className="btn-accent col-span-3 text-xl py-4"
          onClick={onValider}
          disabled={validerDesactive}
        >
          {libelleValider}
        </button>
      )}
    </div>
  );
}
