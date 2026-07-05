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
        setUtilisateurs(tous.filter((u) => ['SERVEUR', 'MANAGER', 'PROPRIETAIRE'].includes(u.role))),
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
      document.documentElement.style.setProperty('--accent', session.restaurant.couleur_hex);
      onConnecte(session);
    } catch (e) {
      setErreur((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-4xl font-black text-accent">Serveur de salle</h1>
        <p className="mt-2 text-zinc-400">Connexion par PIN</p>
      </div>

      {!choisi ? (
        <div className="grid w-full max-w-xl grid-cols-2 gap-3">
          {utilisateurs.map((u) => (
            <button key={u.id} type="button" className="carte min-h-[80px] p-4 text-left hover:border-accent" onClick={() => setChoisi(u)}>
              <div className="font-bold">{u.nom_complet}</div>
              <div className="text-sm text-zinc-400">{u.role === 'SERVEUR' ? 'Serveur' : u.role === 'MANAGER' ? 'Manager' : 'Propriétaire'}</div>
            </button>
          ))}
        </div>
      ) : (
        <div className="w-full max-w-xs space-y-3">
          <div className="text-center text-lg font-semibold">{choisi.nom_complet}</div>
          <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
            {'•'.repeat(pin.length) || <span className="text-base tracking-normal text-zinc-500">PIN</span>}
          </div>
          <Numpad
            valeur={pin}
            onChange={setPin}
            longueurMax={6}
            onValider={seConnecter}
            libelleValider={enCours ? 'Connexion…' : 'Se connecter'}
            validerDesactive={pin.length < 4 || enCours}
          />
          <button type="button" className="btn-sombre w-full" onClick={() => { setChoisi(null); setPin(''); }}>
            ← Changer d’utilisateur
          </button>
        </div>
      )}

      {erreur && <div className="rounded-xl bg-red-950 px-5 py-3 text-red-200">{erreur}</div>}
    </div>
  );
}
