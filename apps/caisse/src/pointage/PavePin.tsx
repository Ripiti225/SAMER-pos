import { useState } from 'react';

const LONGUEUR_MAX = 6;
const LONGUEUR_MIN = 4;

/** Pavé PIN tactile du téléphone (touches ≥ 62 px), points à la place des chiffres. */
export function PavePin({ libelle, occupe, onValider }: { libelle: string; occupe: boolean; onValider: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const taper = (c: string) => setPin((p) => (p.length >= LONGUEUR_MAX ? p : p + c));
  const valider = () => {
    if (pin.length < LONGUEUR_MIN || occupe) return;
    onValider(pin);
    setPin('');
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="text-center text-vitrine-txt-doux">{libelle}</div>
      <div className="flex justify-center gap-3 h-6" aria-label={`${pin.length} chiffres tapés`}>
        {Array.from({ length: Math.max(LONGUEUR_MIN, pin.length) }, (_, i) => (
          <span key={i} className={`w-4 h-4 rounded-full ${i < pin.length ? 'bg-marque' : 'bg-vitrine-surface-2 border border-vitrine-bordure'}`} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => (
          <button key={c} type="button" className="touche-vitrine" onClick={() => taper(c)}>{c}</button>
        ))}
        <button type="button" className="touche-vitrine text-base" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Effacer">⌫</button>
        <button type="button" className="touche-vitrine" onClick={() => taper('0')}>0</button>
        <button
          type="button"
          className="touche-vitrine !bg-marque !text-sur-marque text-base disabled:opacity-50"
          onClick={valider}
          disabled={pin.length < LONGUEUR_MIN || occupe}
        >
          {occupe ? '…' : 'OK'}
        </button>
      </div>
    </div>
  );
}
