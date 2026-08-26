import { useState, type FormEvent } from 'react';
import { IconBuildingStore, IconLock, IconMail } from '@tabler/icons-react';
import { ErreurApi, seConnecter } from '../api';

interface Props {
  surConnexion: () => void;
  /** Motif d'un renvoi ici (compte non autorisé, session expirée). */
  motif?: string;
}

/**
 * Connexion de la console.
 *
 * Adresse e-mail et mot de passe, et non un PIN : le PIN de la caisse est fait
 * pour être tapé cent fois par jour sur un écran tactile par quelqu'un qui a les
 * mains prises. Ici, on ouvre la console deux fois par jour depuis un clavier,
 * et elle donne sur les comptes des 7 restaurants — l'arbitrage rapidité /
 * solidité n'est pas le même.
 *
 * Écran « vitrine » (DESIGN_V2 § 6.1) : il suit le mode clair/sombre du poste.
 */
export function Login({ surConnexion, motif }: Props): JSX.Element {
  const [email, setEmail] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<string | null>(motif ?? null);
  const [enCours, setEnCours] = useState(false);
  const [secousse, setSecousse] = useState(false);

  const soumettre = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (enCours || !email.trim() || !motDePasse) return;
    setEnCours(true);
    setErreur(null);
    try {
      await seConnecter(email, motDePasse);
      surConnexion();
    } catch (err) {
      setErreur(err instanceof ErreurApi ? err.message : 'Connexion impossible pour le moment.');
      setMotDePasse('');
      setSecousse(true);
      setTimeout(() => setSecousse(false), 450);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-vitrine-fond p-6">
      <form
        onSubmit={soumettre}
        className={`w-full max-w-[420px] rounded-jeton p-8 ${secousse ? 'secousse' : ''}`}
        style={{
          background: 'var(--vitrine-surface)',
          border: '1px solid var(--vitrine-bordure)',
          boxShadow: 'var(--vitrine-ombre)',
        }}
      >
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div
            className="flex h-14 w-14 items-center justify-center rounded-jeton"
            style={{ background: 'var(--marque)', color: 'var(--sur-marque)' }}
          >
            <IconBuildingStore size={30} />
          </div>
          <div>
            <h1 className="text-[22px] font-bold" style={{ color: 'var(--vitrine-txt)' }}>
              Console du siège
            </h1>
            <p className="mt-1 text-sm" style={{ color: 'var(--vitrine-txt-doux)' }}>
              Vue d'ensemble des 7 restaurants
            </p>
          </div>
        </div>

        <label className="mb-1.5 block text-sm font-semibold" style={{ color: 'var(--vitrine-txt-doux)' }}>
          Adresse e-mail
        </label>
        <div className="champ mb-4 flex items-center gap-2.5">
          <IconMail size={19} style={{ color: 'var(--vitrine-txt-faible)', flex: 'none' }} />
          <input
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full bg-transparent outline-none"
            placeholder="vous@exemple.com"
          />
        </div>

        <label className="mb-1.5 block text-sm font-semibold" style={{ color: 'var(--vitrine-txt-doux)' }}>
          Mot de passe
        </label>
        <div className="champ mb-5 flex items-center gap-2.5">
          <IconLock size={19} style={{ color: 'var(--vitrine-txt-faible)', flex: 'none' }} />
          <input
            type="password"
            autoComplete="current-password"
            value={motDePasse}
            onChange={(e) => setMotDePasse(e.target.value)}
            className="w-full bg-transparent outline-none"
            placeholder="••••••••"
          />
        </div>

        {erreur && (
          <div
            className="mb-4 rounded-btn px-4 py-3 text-sm font-medium"
            style={{ background: 'var(--alerte-tint)', color: 'var(--alerte-txt)' }}
            role="alert"
          >
            {erreur}
          </div>
        )}

        <button type="submit" className="btn-accent w-full" disabled={enCours || !email.trim() || !motDePasse}>
          {enCours ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}
