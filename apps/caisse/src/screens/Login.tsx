import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SessionInfo, UtilisateurPublic } from '@pos/shared';
import { PINS_INTERDITS } from '@pos/shared';
import { api } from '../api';
import { useCaisse } from '../stores/session';

const LIBELLES_ROLES: Record<string, string> = {
  PROPRIETAIRE: 'Propriétaire',
  MANAGER: 'Manager',
  CAISSIER: 'Caissier',
  SERVEUR: 'Serveur',
  CUISINE: 'Cuisine',
};

/** Rôles « encadrants » : avatar en accent de marque. */
const ROLES_ACCENT = new Set(['PROPRIETAIRE', 'SUPERVISEUR', 'MANAGER']);

/** Sous-étapes du premier accès (l'employé pose son PIN avec un code temporaire). */
type EtapeDef = 'code' | 'pin' | 'confirmation';

function initiales(nom: string): string {
  return nom
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((m) => m[0]!.toUpperCase())
    .join('');
}

function libelleRole(u: UtilisateurPublic): string {
  return u.role_nom ?? (u.role ? LIBELLES_ROLES[u.role] ?? u.role : '');
}

export function Login() {
  const { poserSession, afficherToast, session } = useCaisse();
  const queryClient = useQueryClient();
  const [choisi, setChoisi] = useState<UtilisateurPublic | null>(null);
  const [pin, setPin] = useState('');
  const [enCours, setEnCours] = useState(false);
  // Premier accès : pose du PIN
  const [etapeDef, setEtapeDef] = useState<EtapeDef>('code');
  const [code, setCode] = useState('');
  const [nouveauPin, setNouveauPin] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const { data: utilisateurs } = useQuery({
    queryKey: ['utilisateurs-login'],
    queryFn: () => api<UtilisateurPublic[]>('/api/auth/utilisateurs'),
  });

  const nomResto = session?.restaurant.nom ?? 'Chez Samer';

  const choisirUtilisateur = (u: UtilisateurPublic) => {
    setChoisi(u);
    setPin('');
    setCode('');
    setNouveauPin('');
    setConfirmation('');
    setEtapeDef('code');
  };

  const deselectionner = () => {
    setChoisi(null);
    setPin('');
    setCode('');
    setNouveauPin('');
    setConfirmation('');
    setEtapeDef('code');
  };

  const connecter = async (utilisateurId: string, pinSaisi: string) => {
    setEnCours(true);
    try {
      const s = await api<SessionInfo>('/api/auth/login', {
        method: 'POST',
        corps: { utilisateur_id: utilisateurId, pin: pinSaisi },
      });
      poserSession(s);
    } catch (e) {
      afficherToast((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  // Premier accès : valide code + PIN + confirmation, puis connecte automatiquement.
  const definirPin = async () => {
    if (!choisi) return;
    if (confirmation !== nouveauPin) {
      afficherToast('Les deux PIN ne correspondent pas');
      setConfirmation('');
      setNouveauPin('');
      setEtapeDef('pin');
      return;
    }
    setEnCours(true);
    try {
      await api('/api/auth/poser-pin', {
        method: 'POST',
        corps: {
          utilisateur_id: choisi.id,
          code_temporaire: code,
          pin: nouveauPin,
          pin_confirmation: confirmation,
        },
      });
      afficherToast('PIN défini — connexion…');
      await queryClient.invalidateQueries({ queryKey: ['utilisateurs-login'] });
      await connecter(choisi.id, nouveauPin);
    } catch (e) {
      afficherToast((e as Error).message);
      setCode('');
      setNouveauPin('');
      setConfirmation('');
      setEtapeDef('code');
      setEnCours(false);
    }
  };

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden p-4 md:p-6">
      {/* Atmosphère : halos chauds diffus */}
      <div className="pointer-events-none fixed inset-0 z-0 opacity-25">
        <div className="absolute -left-[8%] -top-[10%] h-[45%] w-[45%] rounded-full bg-marque-tint blur-[120px]" />
        <div className="absolute -bottom-[10%] -right-[8%] h-[45%] w-[45%] rounded-full bg-marque blur-[140px]" />
      </div>

      <main className="relative z-10 grid h-auto w-full max-w-6xl grid-cols-1 overflow-hidden rounded-[32px] bg-surface-douce shadow-e3 md:h-[86vh] md:grid-cols-12">
        {/* ------- Gauche : marque + choix du profil ------- */}
        <section className="flex flex-col border-bordure/60 p-8 md:col-span-7 md:border-r lg:p-12">
          <header className="mb-8 lg:mb-10">
            <h1 className="text-3xl font-bold tracking-tight text-marque-fonce lg:text-4xl">{nomResto}</h1>
            <p className="mt-2 text-base text-doux">
              Bienvenue sur votre espace de vente. Sélectionnez votre profil.
            </p>
          </header>

          <div className="-mr-2 flex-1 overflow-y-auto pr-2">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {(utilisateurs ?? []).map((u) => {
                const actif = choisi?.id === u.id;
                const accent = ROLES_ACCENT.has(u.role ?? '');
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => choisirUtilisateur(u)}
                    className={`flex flex-col items-center rounded-[18px] border-2 bg-surface p-5 text-center transition active:scale-[0.97] ${
                      actif ? 'border-marque shadow-e2' : 'border-transparent shadow-e1 hover:shadow-e2'
                    }`}
                  >
                    <div
                      className={`mb-3 flex h-16 w-16 items-center justify-center rounded-full text-xl font-bold ${
                        accent ? 'bg-marque-tint text-marque-fonce' : 'bg-surface-tres-haute text-doux'
                      }`}
                    >
                      {initiales(u.nom_complet)}
                    </div>
                    <span className="font-semibold leading-tight text-fort">{u.nom_complet}</span>
                    <span
                      className={`mt-2 rounded-full px-3 py-1 text-xs font-medium ${
                        u.doit_definir_pin
                          ? 'bg-marque/10 text-marque-fonce'
                          : accent
                            ? 'bg-marque/10 text-marque-fonce'
                            : 'bg-surface-tres-haute text-doux'
                      }`}
                    >
                      {u.doit_definir_pin ? 'PIN à définir' : libelleRole(u)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <footer className="mt-8 flex items-center gap-3 border-t border-bordure/60 pt-6 text-doux">
            <IconeWifi className="h-5 w-5" />
            <span className="text-sm font-medium">{nomResto} · Réseau local</span>
          </footer>
        </section>

        {/* ------- Droite : PIN / pavé ------- */}
        <section className="flex flex-col items-center justify-center overflow-y-auto bg-surface-haute p-6 md:col-span-5 lg:p-8">
          {!choisi ? (
            <div className="max-w-[300px] text-center text-doux">
              <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-surface-tres-haute text-faible">
                <IconePersonne className="h-8 w-8" />
              </div>
              <p className="text-lg font-semibold text-fort">Choisissez un profil</p>
              <p className="mt-1 text-sm">Sélectionnez votre nom à gauche pour saisir votre code PIN.</p>
            </div>
          ) : choisi.doit_definir_pin ? (
            etapeDef === 'code' ? (
              <PavePin
                titre={choisi.nom_complet}
                sousTitre="Premier accès — code temporaire à 6 chiffres"
                valeur={code}
                onChange={setCode}
                minLongueur={6}
                longueurMax={6}
                libelle="Continuer"
                onValider={() => setEtapeDef('pin')}
                onAnnuler={deselectionner}
              />
            ) : etapeDef === 'pin' ? (
              <PavePin
                titre={choisi.nom_complet}
                sousTitre="Choisissez votre PIN (4 à 6 chiffres)"
                valeur={nouveauPin}
                onChange={setNouveauPin}
                minLongueur={4}
                longueurMax={6}
                libelle="Continuer"
                onValider={() => {
                  if (PINS_INTERDITS.includes(nouveauPin)) {
                    afficherToast('Ce PIN est trop facile à deviner');
                    setNouveauPin('');
                    return;
                  }
                  setEtapeDef('confirmation');
                }}
                onAnnuler={deselectionner}
              />
            ) : (
              <PavePin
                titre={choisi.nom_complet}
                sousTitre="Confirmez votre PIN"
                valeur={confirmation}
                onChange={setConfirmation}
                minLongueur={nouveauPin.length}
                longueurMax={6}
                libelle={enCours ? 'Validation…' : 'Valider mon PIN'}
                enCours={enCours}
                onValider={definirPin}
                onAnnuler={deselectionner}
              />
            )
          ) : (
            <PavePin
              titre={choisi.nom_complet}
              sousTitre="Authentification"
              valeur={pin}
              onChange={setPin}
              minLongueur={4}
              longueurMax={6}
              libelle={enCours ? 'Connexion…' : 'Se connecter'}
              enCours={enCours}
              onValider={() => connecter(choisi.id, pin)}
              onAnnuler={deselectionner}
            />
          )}
        </section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pavé PIN : titre + points + clavier tactile + bouton d'action. Support du
// clavier physique (dev). Réutilisé pour la saisie et la définition de PIN.
// ---------------------------------------------------------------------------
interface PaveProps {
  titre: string;
  sousTitre: string;
  valeur: string;
  onChange: (v: string) => void;
  minLongueur: number;
  longueurMax: number;
  libelle: string;
  enCours?: boolean;
  onValider: () => void;
  onAnnuler: () => void;
}

function PavePin({ titre, sousTitre, valeur, onChange, minLongueur, longueurMax, libelle, enCours, onValider, onAnnuler }: PaveProps) {
  const pret = valeur.length >= minLongueur && !enCours;
  const taper = (c: string) => {
    if (valeur.length >= longueurMax) return;
    onChange(valeur + c);
  };
  const effacerDernier = () => onChange(valeur.slice(0, -1));

  useEffect(() => {
    const gerer = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        if (valeur.length < longueurMax) onChange(valeur + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        onChange(valeur.slice(0, -1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onChange('');
      } else if (e.key === 'Enter' && valeur.length >= minLongueur && !enCours) {
        e.preventDefault();
        onValider();
      }
    };
    window.addEventListener('keydown', gerer);
    return () => window.removeEventListener('keydown', gerer);
  }, [valeur, onChange, onValider, minLongueur, longueurMax, enCours]);

  const nbPoints = Math.min(longueurMax, Math.max(minLongueur, valeur.length));

  return (
    <div className="flex w-full max-w-[320px] flex-col items-center">
      <div className="mb-5 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-marque-fonce">{sousTitre}</p>
        <h2 className="mt-1 text-2xl font-semibold text-fort">{titre}</h2>
        <div className="mt-4 flex justify-center gap-3">
          {Array.from({ length: nbPoints }).map((_, i) => (
            <span
              key={i}
              className={`h-3.5 w-3.5 rounded-full border-2 transition ${
                i < valeur.length ? 'border-marque bg-marque' : 'border-bordure-forte bg-surface-tres-haute'
              }`}
            />
          ))}
        </div>
      </div>

      <div className="grid w-full grid-cols-3 gap-2.5 [&>button]:min-h-[52px]">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => (
          <button key={c} type="button" onClick={() => taper(c)} className="touche">
            {c}
          </button>
        ))}
        <button type="button" onClick={() => onChange('')} className="touche text-sm font-semibold text-alerte">
          EFFACER
        </button>
        <button type="button" onClick={() => taper('0')} className="touche">
          0
        </button>
        <button type="button" onClick={effacerDernier} className="touche" aria-label="Effacer un chiffre">
          <IconeRetourArriere className="h-6 w-6 text-doux" />
        </button>
      </div>

      <button
        type="button"
        onClick={onValider}
        disabled={!pret}
        className={`mt-5 h-14 w-full rounded-[13px] text-lg font-semibold transition ${
          pret
            ? 'bg-marque text-sur-marque shadow-e2 active:translate-y-px'
            : 'cursor-not-allowed bg-surface-tres-haute text-faible'
        }`}
      >
        {libelle}
      </button>
      <button type="button" onClick={onAnnuler} className="mt-3 text-sm font-medium text-doux hover:text-fort">
        ← Changer d’utilisateur
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icônes inline (aucun CDN — l'app tourne hors-ligne)
// ---------------------------------------------------------------------------
function IconeWifi({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.55a11 11 0 0 1 14 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}
function IconePersonne({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
function IconeRetourArriere({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
      <line x1="18" y1="9" x2="12" y2="15" />
      <line x1="12" y1="9" x2="18" y2="15" />
    </svg>
  );
}
