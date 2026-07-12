import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useCaisse } from '../stores/session';
import { Numpad } from './Numpad';

/**
 * Verrouillage automatique après inactivité (§14, correction 1) :
 * - Se déclenche UNIQUEMENT après N secondes sans interaction réelle
 *   (10 min par défaut, clé parametres_locaux `verrou_inactivite_caisse_secondes`).
 *   Jamais au changement d'écran, au retour d'onglet ni à la perte de focus.
 * - Ne déconnecte PAS et ne ferme PAS le service : simple surcouche, le PIN
 *   ré-affiche exactement l'écran quitté (commande en cours intacte).
 */
export function VerrouInactivite() {
  const { session, verrouille, verrouiller, poserSession, afficherToast } = useCaisse();
  const [pin, setPin] = useState('');
  const [enCours, setEnCours] = useState(false);
  const minuteur = useRef<ReturnType<typeof setTimeout> | null>(null);

  const delaiMs = (session?.verrouillage_inactivite_secondes ?? 600) * 1000;

  useEffect(() => {
    if (!session) return;
    // Délai ≤ 0 → verrouillage automatique DÉSACTIVÉ (déconnexion manuelle seule).
    if (delaiMs <= 0) return;
    const relancer = () => {
      if (minuteur.current) clearTimeout(minuteur.current);
      minuteur.current = setTimeout(() => verrouiller(true), delaiMs);
    };
    const evenements = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const e of evenements) window.addEventListener(e, relancer);
    relancer();
    return () => {
      for (const e of evenements) window.removeEventListener(e, relancer);
      if (minuteur.current) clearTimeout(minuteur.current);
    };
  }, [session, delaiMs, verrouiller]);

  if (!session || !verrouille) return null;

  const deverrouiller = async () => {
    setEnCours(true);
    try {
      await api('/api/auth/deverrouiller', { method: 'POST', corps: { pin } });
      verrouiller(false);
      setPin('');
    } catch (e) {
      afficherToast((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  const changerUtilisateur = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* la session sera détruite côté serveur au prochain passage */
    }
    poserSession(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-fond/95 p-6">
      <div className="text-center">
        <div className="text-3xl font-bold">Caisse verrouillée</div>
        <div className="mt-1 text-doux">{session.utilisateur.nom_complet} — saisissez votre PIN</div>
      </div>
      <div className="w-full max-w-xs space-y-3">
        <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
          {'•'.repeat(pin.length) || <span className="text-base tracking-normal text-doux">PIN</span>}
        </div>
        <Numpad
          valeur={pin}
          onChange={setPin}
          longueurMax={6}
          onValider={deverrouiller}
          libelleValider={enCours ? 'Vérification…' : 'Déverrouiller'}
          validerDesactive={pin.length < 4 || enCours}
        />
        <button type="button" className="btn-blanc w-full" onClick={changerUtilisateur}>
          Se déconnecter
        </button>
      </div>
    </div>
  );
}
