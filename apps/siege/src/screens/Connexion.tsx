import { useState } from 'react';
import { IconMoon, IconSun } from '@tabler/icons-react';
import { configurationManquante, supabase } from '../supabase';
import type { Mode } from '../affichage';

/**
 * Écran « vitrine » : il suit le mode clair/sombre, contrairement à l'ossature
 * des écrans de travail qui reste ardoise dans les deux modes (DESIGN_V2 § 6.1).
 *
 * Pas de grille de profils comme sur la caisse : ici on se connaît par e-mail,
 * les comptes sont deux ou trois et ils appartiennent au siège, pas à un poste.
 */
export function Connexion({ mode, onBasculerMode }: { mode: Mode; onBasculerMode: () => void }) {
  const [email, setEmail] = useState('');
  const [motDePasse, setMotDePasse] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  const soumettre = async (e: React.FormEvent) => {
    e.preventDefault();
    setErreur(null);
    setEnCours(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: motDePasse });
    setEnCours(false);
    if (error) {
      // Message en français courant, jamais le code technique de GoTrue.
      setErreur(
        error.message.toLowerCase().includes('invalid')
          ? 'E-mail ou mot de passe incorrect'
          : 'Connexion impossible pour le moment',
      );
    }
  };

  return (
    <div className="flex h-full flex-col bg-vitrine-fond">
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-[380px]">
          <div className="mb-7 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-jeton bg-marque text-xl font-bold text-sur-marque">
              S
            </div>
            <h1 className="text-2xl font-bold text-vitrine-txt">Console du siège</h1>
            <p className="mt-1 text-vitrine-txt-doux">Les 7 restaurants en un seul endroit</p>
          </div>

          {configurationManquante && (
            <div className="mb-4 rounded-jeton bg-alerte-tint px-4 py-3 text-alerte-txt">
              La console n’est pas configurée : <code>VITE_SUPABASE_URL</code> et{' '}
              <code>VITE_SUPABASE_ANON_KEY</code> manquent dans <code>apps/siege/.env</code>.
            </div>
          )}

          <form
            onSubmit={(e) => void soumettre(e)}
            className="rounded-jeton border border-vitrine-bordure bg-vitrine-surface p-5 shadow-e2"
          >
            <label className="mb-3 block text-sm font-medium text-vitrine-txt-doux">
              Adresse e-mail
              <input
                type="email"
                autoComplete="username"
                required
                className="champ mt-1.5"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="block text-sm font-medium text-vitrine-txt-doux">
              Mot de passe
              <input
                type="password"
                autoComplete="current-password"
                required
                className="champ mt-1.5"
                value={motDePasse}
                onChange={(e) => setMotDePasse(e.target.value)}
              />
            </label>

            {erreur && <div className="mt-4 rounded-jeton bg-alerte-tint px-4 py-3 text-alerte-txt">{erreur}</div>}

            <button type="submit" className="btn-accent mt-5 w-full" disabled={enCours || configurationManquante}>
              {enCours ? 'Connexion…' : 'Se connecter'}
            </button>
          </form>
        </div>
      </div>

      <footer className="flex flex-none items-center justify-end px-6 py-4">
        <button
          type="button"
          onClick={onBasculerMode}
          className="flex items-center gap-2 rounded-btn px-3 py-2 text-sm font-semibold text-vitrine-txt-doux transition hover:text-vitrine-txt"
        >
          {mode === 'sombre' ? <IconSun size={18} /> : <IconMoon size={18} />}
          Affichage {mode === 'sombre' ? 'clair' : 'sombre'}
        </button>
      </footer>
    </div>
  );
}
