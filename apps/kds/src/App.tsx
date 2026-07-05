import { useState } from 'react';
import { lireJeton } from './api';
import { EcranJeton } from './screens/EcranJeton';
import { Grille } from './screens/Grille';

/**
 * Correction 3 : AUCUN écran de connexion. Le KDS s'ouvre directement sur la
 * grille des commandes. L'appareil s'identifie par un jeton configuré une
 * seule fois à l'installation ; si le serveur le refuse, l'écran de
 * configuration réapparaît.
 */
export function App() {
  const [jetonPresent, setJetonPresent] = useState(() => !!lireJeton());
  const [jetonRefuse, setJetonRefuse] = useState(false);

  if (!jetonPresent || jetonRefuse) {
    return (
      <EcranJeton
        refuse={jetonRefuse}
        onConfigure={() => {
          setJetonPresent(true);
          setJetonRefuse(false);
        }}
      />
    );
  }

  return <Grille onJetonRefuse={() => setJetonRefuse(true)} />;
}
