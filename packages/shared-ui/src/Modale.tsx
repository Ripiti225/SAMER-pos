import type { ReactNode } from 'react';

interface Props {
  titre: string;
  enfants: ReactNode;
  onFermer: () => void;
  large?: boolean;
}

export function Modale({ titre, enfants, onFermer, large }: Props) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onFermer}>
      <div
        className={`carte w-full ${large ? 'max-w-2xl' : 'max-w-md'} max-h-[90dvh] overflow-y-auto p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">{titre}</h2>
          <button type="button" className="btn-blanc px-3" onClick={onFermer}>
            ✕
          </button>
        </div>
        {enfants}
      </div>
    </div>
  );
}
