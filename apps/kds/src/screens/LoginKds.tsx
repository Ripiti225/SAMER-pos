import { useEffect, useState } from 'react';
import type { SessionInfo, UtilisateurPublic } from '@pos/shared';
import { api, Numpad } from '@pos/shared-ui';

const POSTES = [
  { code: 'CUISINIER', libelle: 'Cuisinier', emoji: '🍳' },
  { code: 'PIZZAIOLO', libelle: 'Pizzaiolo', emoji: '🍕' },
  { code: 'COMPTOIRISTE', libelle: 'Comptoiriste', emoji: '🥙' },
] as const;

/** Connexion simplifiée KDS (§A5) : poste + PIN d'un utilisateur CUISINE. */
export function LoginKds({ onConnecte }: { onConnecte: (s: SessionInfo) => void }) {
  const [poste, setPoste] = useState<string | null>(null);
  const [utilisateurs, setUtilisateurs] = useState<UtilisateurPublic[]>([]);
  const [choisi, setChoisi] = useState<UtilisateurPublic | null>(null);
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    api<UtilisateurPublic[]>('/api/auth/utilisateurs')
      .then((tous) => setUtilisateurs(tous.filter((u) => u.role === 'CUISINE')))
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
      <h1 className="text-4xl font-black text-accent">KDS Cuisine</h1>

      {!poste ? (
        <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-3">
          {POSTES.map((p) => (
            <button key={p.code} type="button" className="carte flex min-h-[140px] flex-col items-center justify-center gap-2 p-6 hover:border-accent" onClick={() => setPoste(p.code)}>
              <span className="text-5xl">{p.emoji}</span>
              <span className="text-2xl font-bold">{p.libelle}</span>
            </button>
          ))}
        </div>
      ) : !choisi ? (
        <div className="grid w-full max-w-xl gap-3 sm:grid-cols-2">
          {utilisateurs.map((u) => (
            <button key={u.id} type="button" className="carte min-h-[80px] p-4 text-xl font-bold hover:border-accent" onClick={() => setChoisi(u)}>
              {u.nom_complet}
            </button>
          ))}
          {utilisateurs.length === 0 && <div className="text-zinc-400">Aucun utilisateur cuisine.</div>}
          <button type="button" className="btn-sombre sm:col-span-2" onClick={() => setPoste(null)}>
            ← Changer de poste
          </button>
        </div>
      ) : (
        <div className="w-full max-w-xs space-y-3">
          <div className="text-center text-2xl font-bold">{choisi.nom_complet}</div>
          <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
            {'•'.repeat(pin.length) || <span className="text-lg tracking-normal text-zinc-500">PIN</span>}
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
            ← Retour
          </button>
        </div>
      )}

      {erreur && <div className="rounded-xl bg-red-950 px-5 py-3 text-lg text-red-200">{erreur}</div>}
    </div>
  );
}
