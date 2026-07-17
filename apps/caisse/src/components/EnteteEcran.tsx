import type { ReactNode } from 'react';
import { IconArrowLeft } from '@tabler/icons-react';

/** En-tête d'écran commun : bouton retour rond + titre + actions à droite. */
export function EnteteEcran({ titre, onRetour, actions }: { titre: string; onRetour: () => void; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex items-center gap-3">
      <button
        type="button"
        onClick={onRetour}
        title="Retour"
        className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-surface-douce text-doux transition hover:bg-marque-tint hover:text-marque-fonce"
      >
        <IconArrowLeft size={20} />
      </button>
      <h1 className="text-2xl font-bold text-marque-fonce">{titre}</h1>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
