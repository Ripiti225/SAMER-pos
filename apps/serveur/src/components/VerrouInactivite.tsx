import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '@pos/shared';
import { api, Numpad } from '@pos/shared-ui';

/**
 * Verrouillage d'inactivité de la tablette (§B5) : 120 s par défaut,
 * plus long que la caisse car les serveurs bougent (paramètre local).
 */
export function VerrouInactivite({
  session,
  onDeconnexion,
}: {
  session: SessionInfo;
  onDeconnexion: () => void;
}) {
  const [verrouille, setVerrouille] = useState(false);
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const minuteur = useRef<ReturnType<typeof setTimeout> | null>(null);

  const delaiMs = (session.verrouillage_inactivite_serveur_secondes ?? 120) * 1000;

  useEffect(() => {
    const relancer = () => {
      if (minuteur.current) clearTimeout(minuteur.current);
      minuteur.current = setTimeout(() => setVerrouille(true), delaiMs);
    };
    const evenements = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const e of evenements) window.addEventListener(e, relancer);
    relancer();
    return () => {
      for (const e of evenements) window.removeEventListener(e, relancer);
      if (minuteur.current) clearTimeout(minuteur.current);
    };
  }, [delaiMs]);

  if (!verrouille) return null;

  const deverrouiller = async () => {
    setEnCours(true);
    setErreur(null);
    try {
      await api('/api/auth/deverrouiller', { method: 'POST', corps: { pin } });
      setVerrouille(false);
      setPin('');
    } catch (e) {
      setErreur((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-fond/95 p-6">
      <div className="text-center">
        <div className="text-3xl font-bold">Tablette verrouillée</div>
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
        {erreur && <div className="text-center text-alerte">{erreur}</div>}
        <button
          type="button"
          className="btn-blanc w-full"
          onClick={async () => {
            try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
            onDeconnexion();
          }}
        >
          Se déconnecter
        </button>
      </div>
    </div>
  );
}
