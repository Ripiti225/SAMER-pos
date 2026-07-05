import { useState } from 'react';
import { enregistrerJeton } from '../api';

/**
 * Configuration UNIQUE à l'installation de l'écran cuisine (correction 3) :
 * on saisit le jeton d'appareil (défini dans parametres_locaux par le
 * gérant), jamais un PIN humain. Écran vu une seule fois par appareil.
 */
export function EcranJeton({ refuse, onConfigure }: { refuse: boolean; onConfigure: () => void }) {
  const [jeton, setJeton] = useState('');

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-black text-accent">Installation de l’écran cuisine</h1>
        <p className="mt-2 max-w-md text-zinc-400">
          Saisissez le jeton d’appareil fourni à l’installation (paramètre
          « kds_jeton_appareil » du serveur). À faire une seule fois : ensuite,
          l’écran s’ouvrira directement sur les commandes.
        </p>
      </div>

      {refuse && (
        <div className="rounded-xl bg-red-950 px-5 py-3 text-red-200">
          Jeton refusé par le serveur — vérifiez-le et réessayez.
        </div>
      )}

      <div className="w-full max-w-sm space-y-3">
        <input
          className="champ text-center"
          value={jeton}
          onChange={(e) => setJeton(e.target.value)}
          placeholder="ex : SAMER-ANGRE7E-KDS-1"
          autoFocus
        />
        <button
          type="button"
          className="btn-accent w-full py-4 text-lg"
          disabled={jeton.trim().length < 4}
          onClick={() => {
            enregistrerJeton(jeton);
            onConfigure();
          }}
        >
          Enregistrer et ouvrir la cuisine
        </button>
      </div>
    </div>
  );
}
