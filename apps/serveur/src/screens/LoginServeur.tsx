import { useEffect, useState } from 'react';
import type { SessionInfo, UtilisateurPublic } from '@pos/shared';
import { api, Numpad } from '@pos/shared-ui';

/** Connexion PIN, rôle SERVEUR (§B5). */
export function LoginServeur({ onConnecte }: { onConnecte: (s: SessionInfo) => void }) {
  const [utilisateurs, setUtilisateurs] = useState<UtilisateurPublic[]>([]);
  const [choisi, setChoisi] = useState<UtilisateurPublic | null>(null);
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    api<UtilisateurPublic[]>('/api/auth/utilisateurs')
      .then((tous) =>
        setUtilisateurs(tous.filter((u) => ['SERVEUR', 'MANAGER', 'PROPRIETAIRE'].includes(u.role_nom ?? u.role ?? ''))),
      )
      .catch(() => setErreur('Serveur injoignable — vérifiez le réseau'));
  }, []);

  const seConnecter = async () => {
    if (!choisi) return;
    setEnCours(true);
    setErreur(null);
    try {
      const session = await api<SessionInfo>('/api/auth/login', {
        method: 'POST',
        corps: { utilisateur_id: choisi.id, pin },
      });
      document.documentElement.dataset.marque = session.restaurant.marque;
      document.documentElement.style.setProperty('--marque', session.restaurant.couleur_hex);
      onConnecte(session);
    } catch (e) {
      setErreur((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-marque-fonce">Serveur de salle</h1>
        <p className="mt-1 text-doux">Connexion par PIN</p>
      </div>

      {!choisi ? (
        <div className="grid w-full max-w-xl grid-cols-2 gap-3 sm:grid-cols-3">
          {utilisateurs.map((u) => (
            <button
              key={u.id}
              type="button"
              className="carte flex min-h-[92px] flex-col items-center justify-center gap-1 p-4 text-center shadow-e1 transition hover:shadow-e2"
              onClick={() => setChoisi(u)}
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-marque-tint text-sm font-bold text-marque-fonce">
                {u.nom_complet.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('')}
              </div>
              <div className="text-sm font-semibold leading-tight">{u.nom_complet}</div>
              <div className="rounded-full bg-surface-tres-haute px-2 py-0.5 text-[11px] font-medium text-doux">
                {u.role === 'SERVEUR' ? 'Serveur' : u.role === 'MANAGER' ? 'Manager' : 'Propriétaire'}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="carte w-full max-w-xs space-y-3 p-6 shadow-e2">
          <div className="text-center text-lg font-semibold text-fort">{choisi.nom_complet}</div>
          <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
            {'•'.repeat(pin.length) || <span className="text-base tracking-normal text-doux">PIN</span>}
          </div>
          <Numpad
            valeur={pin}
            onChange={setPin}
            longueurMax={6}
            onValider={seConnecter}
            libelleValider={enCours ? 'Connexion…' : 'Se connecter'}
            validerDesactive={pin.length < 4 || enCours}
          />
          <button type="button" className="btn-blanc w-full" onClick={() => { setChoisi(null); setPin(''); }}>
            ← Changer d’utilisateur
          </button>
        </div>
      )}

      {erreur && <div className="rounded-[13px] bg-alerte-tint px-5 py-3 font-medium text-alerte">{erreur}</div>}
    </div>
  );
}
