import { useEffect } from 'react';

interface Props {
  valeur: string;
  onChange: (v: string) => void;
  longueurMax?: number;
  onValider?: () => void;
  libelleValider?: string;
  validerDesactive?: boolean;
}

/** Pavé numérique tactile (boutons ≥ 48 px) + clavier physique en dev. */
export function Numpad({ valeur, onChange, longueurMax = 9, onValider, libelleValider = 'Valider', validerDesactive }: Props) {
  const taper = (c: string) => {
    if (valeur.length >= longueurMax) return;
    onChange(valeur === '0' ? c : valeur + c);
  };

  // Support clavier (dev) : 0-9, Backspace, Enter/Return, Escape (clear)
  useEffect(() => {
    const gererClavier = (evt: KeyboardEvent) => {
      // Ne jamais voler les frappes destinées à un champ de saisie (montant, motif…).
      const cible = evt.target as HTMLElement | null;
      if (cible && (cible.tagName === 'INPUT' || cible.tagName === 'TEXTAREA' || cible.isContentEditable)) return;
      if (/^\d$/.test(evt.key)) {
        evt.preventDefault();
        taper(evt.key);
      } else if (evt.key === 'Backspace') {
        evt.preventDefault();
        onChange(valeur.slice(0, -1));
      } else if (evt.key === 'Escape') {
        evt.preventDefault();
        onChange('');
      } else if (evt.key === 'Enter' && onValider && !validerDesactive) {
        evt.preventDefault();
        onValider();
      }
    };
    window.addEventListener('keydown', gererClavier);
    return () => window.removeEventListener('keydown', gererClavier);
  }, [valeur, onChange, onValider, validerDesactive]);
  return (
    <div className="grid grid-cols-3 gap-2">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => (
        <button key={c} type="button" className="btn-blanc text-2xl py-4" onClick={() => taper(c)}>
          {c}
        </button>
      ))}
      <button type="button" className="btn-blanc text-xl" onClick={() => onChange('')}>
        C
      </button>
      <button type="button" className="btn-blanc text-2xl py-4" onClick={() => taper('0')}>
        0
      </button>
      <button type="button" className="btn-blanc text-xl" onClick={() => onChange(valeur.slice(0, -1))}>
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
