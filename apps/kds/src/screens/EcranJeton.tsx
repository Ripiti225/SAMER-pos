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
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="carte w-full max-w-md space-y-5 p-8 shadow-e2">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-marque-fonce">Installation de l’écran cuisine</h1>
          <p className="mt-2 text-sm text-doux">
            Saisissez le jeton d’appareil fourni à l’installation (paramètre
            « kds_jeton_appareil » du serveur). À faire une seule fois : ensuite,
            l’écran s’ouvrira directement sur les commandes.
          </p>
        </div>

        {refuse && (
          <div className="rounded-[13px] bg-alerte-tint px-5 py-3 text-sm font-medium text-alerte">
            Jeton refusé par le serveur — vérifiez-le et réessayez.
          </div>
        )}

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
