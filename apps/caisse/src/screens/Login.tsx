import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  IconArrowBackUp,
  IconCheck,
  IconMoon,
  IconPower,
  IconSun,
  IconToolsKitchen2,
  IconUser,
} from '@tabler/icons-react';
import type { SessionInfo, UtilisateurPublic } from '@pos/shared';
import { PINS_INTERDITS } from '@pos/shared';
import { api } from '../api';
import { useAffichage, type ModeAffichage } from '../stores/affichage';
import { useCaisse } from '../stores/session';

const LIBELLES_ROLES: Record<string, string> = {
  PROPRIETAIRE: 'Propriétaire',
  MANAGER: 'Manager',
  CAISSIER: 'Caissier',
  SERVEUR: 'Serveur',
  CUISINE: 'Cuisine',
};

/** Rôles « encadrants » : avatar et badge en accent de marque. */
const ROLES_ACCENT = new Set(['PROPRIETAIRE', 'SUPERVISEUR', 'MANAGER']);

/**
 * Couleurs d'avatar (maquette § 6.1 : chaque profil a la sienne). Hors famille
 * orange, réservée à la marque. Tirée du NOM et non du rang dans la liste :
 * une embauche ne doit pas repeindre les avatars de toute l'équipe.
 *
 * Un encadrant prend l'accent de marque — mais JAMAIS `--marque` brut comme
 * couleur de texte : sur fond clair il tombe à ~2:1 de contraste, d'où
 * `--marque-sur-plan` (voir packages/theme/theme.css).
 */
const COULEURS_PROFIL = ['#e2445c', '#8b5cf6', '#3b82f6', '#14b8a6', '#0ea5e9', '#d946ef'];

interface CouleurProfil {
  fond: string;
  texte: string;
}

function couleurProfil(nom: string, accent: boolean): CouleurProfil {
  if (accent) return { fond: 'var(--marque-tint)', texte: 'var(--marque-sur-plan)' };
  let somme = 0;
  for (let i = 0; i < nom.length; i += 1) somme = (somme * 31 + nom.charCodeAt(i)) % 100_000;
  const c = COULEURS_PROFIL[somme % COULEURS_PROFIL.length]!;
  return { fond: `color-mix(in srgb, ${c} 18%, var(--vitrine-surface))`, texte: c };
}

/** Sous-étapes du premier accès (l'employé pose son PIN avec un code temporaire). */
type EtapeDef = 'code' | 'pin' | 'confirmation';

/** État du poste affiché en pied d'écran (route publique). */
interface EtatPoste {
  restaurant: { nom: string; marque: string; couleur_hex: string } | null;
  reseau: boolean;
  imprimante_configuree: boolean;
  cloud: { actif: boolean; en_attente: number };
}

function initiales(nom: string): string {
  return nom
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((m) => m[0]!.toUpperCase())
    .join('');
}

/**
 * Badge de rôle. Les rôles de base sont stockés en capitales (`PROPRIETAIRE`)
 * jusque dans la table `roles` : on les rhabille ici, un rôle créé sur mesure
 * dans Réglages gardant en revanche son libellé tel qu'il a été saisi.
 */
function libelleRole(u: UtilisateurPublic): string {
  const brut = u.role_nom ?? u.role ?? '';
  return LIBELLES_ROLES[brut] ?? brut;
}

/**
 * Pont fourni par la coquille desktop (PosSamer.exe) via son preload :
 * `window.posSamer.fermer()`. Absent dans un navigateur normal (dev, KDS,
 * serveur) → le bouton « Fermer l'application » ne s'affiche alors pas.
 */
function fermetureBureau(): (() => void) | null {
  const pont = (window as unknown as { posSamer?: { fermer?: () => void } }).posSamer;
  return typeof pont?.fermer === 'function' ? () => pont.fermer!() : null;
}

/**
 * Écran de connexion — DESIGN_V2 § 6.1. Écran « vitrine » : il SUIT le mode
 * clair/sombre du poste (jetons `vitrine-*`), contrairement aux écrans de
 * travail dont l'ossature reste ardoise dans les deux modes.
 *
 * Deux colonnes : profils à gauche (la caisse est partagée, on se nomme avant
 * de taper), pavé PIN à droite. Le pavé refuse la validation tant qu'aucun
 * profil n'est choisi.
 */
export function Login() {
  const { poserSession, afficherToast } = useCaisse();
  const queryClient = useQueryClient();
  const [choisi, setChoisi] = useState<UtilisateurPublic | null>(null);
  const [pin, setPin] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [secousse, setSecousse] = useState(0);
  // Bouton « Fermer l'application » : uniquement dans la coquille kiosque.
  const fermerApp = fermetureBureau();
  const [confirmerFermeture, setConfirmerFermeture] = useState(false);
  // Premier accès : pose du PIN
  const [etapeDef, setEtapeDef] = useState<EtapeDef>('code');
  const [code, setCode] = useState('');
  const [nouveauPin, setNouveauPin] = useState('');
  const [confirmation, setConfirmation] = useState('');

  // `?ecran=caisse` : les comptes de SALLE (serveurs) ne sont pas proposés ici,
  // ils se connectent sur leur tablette. Clé de cache DISTINCTE de celle des
  // autres écrans (Tables, Clôture) qui, eux, lisent la liste complète — sans
  // ça, React Query servirait la mauvaise liste au dernier arrivé, et le
  // transfert de table perdrait ses serveurs.
  const { data: utilisateurs, isError: reseauKo } = useQuery({
    queryKey: ['utilisateurs-login', 'caisse'],
    queryFn: () => api<UtilisateurPublic[]>('/api/auth/utilisateurs?ecran=caisse'),
  });

  const { data: etatPoste } = useQuery({
    queryKey: ['poste-etat'],
    queryFn: () => api<EtatPoste>('/api/poste/etat'),
    refetchInterval: 60_000,
  });

  // Identité du site appliquée AVANT toute session : sans elle, les deux
  // restaurants Al Kayan (KMS et Yop) ouvraient sur « Chez Samer » en orange.
  const resto = etatPoste?.restaurant ?? null;
  useEffect(() => {
    if (!resto) return;
    document.documentElement.dataset.marque = resto.marque;
    document.documentElement.style.setProperty('--marque', resto.couleur_hex);
  }, [resto]);

  const nomResto = resto?.nom ?? 'Chez Samer';

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

  /** Refus : le bloc PIN tremble (§ 5) et le champ se vide. */
  const refuser = (message: string) => {
    setSecousse((n) => n + 1);
    afficherToast(message);
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
      refuser((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  // Premier accès : valide code + PIN + confirmation, puis connecte automatiquement.
  const definirPin = async () => {
    if (!choisi) return;
    if (confirmation !== nouveauPin) {
      refuser('Les deux PIN ne correspondent pas');
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
      refuser((e as Error).message);
      setCode('');
      setNouveauPin('');
      setConfirmation('');
      setEtapeDef('code');
      setEnCours(false);
    }
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-vitrine-fond text-vitrine-txt">
      {/* Halo de marque — seule concession décorative du design, réservée aux
          écrans vitrine (connexion, accueil). */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: 'var(--halo-opacite)',
          background:
            'radial-gradient(58% 55% at 78% 8%, color-mix(in srgb, var(--marque) 22%, transparent), transparent 70%),' +
            'radial-gradient(50% 50% at 12% 92%, rgba(59, 130, 246, .14), transparent 70%)',
        }}
      />

      {/* Deux colonnes de la maquette : profils / pavé PIN de 380 px. Pas de
          repli responsive — le poste est un kiosque de largeur connue (1024). */}
      {/* `items-stretch` (défaut) et non `items-center` : la grille de profils
          doit pouvoir défiler à l'intérieur de sa colonne quand l'équipe est
          nombreuse, au lieu de pousser le pied hors de l'écran. */}
      <div className="relative z-10 mx-auto grid min-h-0 w-full max-w-[1180px] flex-1 grid-cols-[1fr_380px] gap-12 px-8 py-6">
        {/* ------- Gauche : marque + choix du profil ------- */}
        {/* Pas de `justify-center` : la colonne part du haut. La grille en
            dessous prend tout l'espace restant, donc un centrage n'aurait de
            toute façon d'effet qu'avec une équipe minuscule — et créerait
            précisément l'écart de présentation qu'on ne veut pas. */}
        <section className="flex min-h-0 flex-col">
          <header className="mb-1.5 flex flex-none items-center gap-3.5">
            <span className="flex h-[50px] w-[50px] flex-none items-center justify-center rounded-[15px] bg-marque text-sur-marque shadow-e1">
              <IconToolsKitchen2 size={26} />
            </span>
            <h1 className="truncate text-[30px] font-bold tracking-[-0.025em]">{nomResto}</h1>
          </header>
          <p className="mb-[18px] flex-none text-[15px] text-vitrine-txt-doux">
            Caisse — sélectionnez votre profil.
          </p>

          {/* La grille commence SOUS le titre et ne se centre pas : la mise en
              page doit être la même à 2 comptes qu'à 16. Un centrage vertical
              (essayé le 2026-08-17) creusait un vide en haut avec une petite
              équipe, et se dissolvait dès que la liste remplissait la colonne —
              l'écran n'avait donc pas la même allure d'un site à l'autre. */}
          <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
            <div className="grid grid-cols-3 gap-3">
              {(utilisateurs ?? []).map((u) => {
                const actif = choisi?.id === u.id;
                const accent = ROLES_ACCENT.has(u.role ?? '');
                const couleur = couleurProfil(u.nom_complet, accent);
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => choisirUtilisateur(u)}
                    // 128 px (et non 152) : la hauteur suffit à un nom sur une
                    // ligne, et un nom long fait grandir la carte tout seul.
                    className={`flex min-h-[128px] flex-col items-center justify-between gap-2 rounded-[16px] border-2 bg-vitrine-surface px-3 py-3.5 text-center shadow-e1 transition duration-150 hover:-translate-y-0.5 hover:shadow-e2 active:translate-y-0 active:scale-[0.985] ${
                      actif ? 'border-marque shadow-e2' : 'border-transparent'
                    }`}
                  >
                    <span className="flex flex-col items-center gap-2">
                      <AvatarProfil nom={u.nom_complet} photo={u.photo_url ?? null} couleur={couleur} />
                      <span className="line-clamp-2 text-[13.5px] font-semibold leading-[1.3]">{u.nom_complet}</span>
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                        u.doit_definir_pin || accent
                          ? 'bg-marque-tint text-marque-sur-plan'
                          : 'bg-vitrine-surface-2 text-vitrine-txt-doux'
                      }`}
                    >
                      {u.doit_definir_pin ? 'PIN à définir' : libelleRole(u)}
                    </span>
                  </button>
                );
              })}
              {(utilisateurs ?? []).length === 0 && (
                <p className="col-span-3 py-10 text-center text-vitrine-txt-faible">
                  {reseauKo ? 'Poste injoignable — vérifiez le réseau local.' : 'Aucun compte actif sur ce poste.'}
                </p>
              )}
            </div>
          </div>
        </section>

        {/* ------- Droite : pavé PIN ------- */}
        <BlocPin
          secousse={secousse}
          entete={
            choisi ? (
              <>
                <span
                  className="flex h-[46px] w-[46px] items-center justify-center rounded-full text-[15px] font-bold"
                  style={{
                    background: couleurProfil(choisi.nom_complet, ROLES_ACCENT.has(choisi.role ?? '')).fond,
                    color: couleurProfil(choisi.nom_complet, ROLES_ACCENT.has(choisi.role ?? '')).texte,
                  }}
                >
                  {initiales(choisi.nom_complet)}
                </span>
                <span className="text-[17px] font-bold tracking-[-0.01em]">{choisi.nom_complet}</span>
              </>
            ) : (
              <>
                <span className="flex h-[46px] w-[46px] items-center justify-center rounded-full bg-vitrine-surface-2 text-vitrine-txt-faible">
                  <IconUser size={24} />
                </span>
                <p className="max-w-[250px] text-[14px] leading-[1.5] text-vitrine-txt-faible">
                  Sélectionnez votre nom à gauche pour saisir votre code.
                </p>
              </>
            )
          }
          {...(!choisi
            ? {
                // Aucun profil : le pavé se tape mais refuse la validation.
                titre: null,
                valeur: '',
                onChange: () => undefined,
                minLongueur: 4,
                onValider: () => refuser('Sélectionnez d’abord votre nom.'),
                aide: '4 à 6 chiffres · 5 essais avant blocage',
              }
            : choisi.doit_definir_pin
              ? etapeDef === 'code'
                ? {
                    titre: 'Premier accès — code temporaire',
                    valeur: code,
                    onChange: setCode,
                    minLongueur: 6,
                    onValider: () => setEtapeDef('pin'),
                    aide: '6 chiffres remis par le manager',
                  }
                : etapeDef === 'pin'
                  ? {
                      titre: 'Choisissez votre PIN',
                      valeur: nouveauPin,
                      onChange: setNouveauPin,
                      minLongueur: 4,
                      onValider: () => {
                        if (PINS_INTERDITS.includes(nouveauPin)) {
                          refuser('Ce PIN est trop facile à deviner');
                          setNouveauPin('');
                          return;
                        }
                        setEtapeDef('confirmation');
                      },
                      aide: '4 à 6 chiffres · ni 1234, ni 0000',
                    }
                  : {
                      titre: 'Confirmez votre PIN',
                      valeur: confirmation,
                      onChange: setConfirmation,
                      minLongueur: nouveauPin.length,
                      onValider: definirPin,
                      aide: enCours ? 'Validation…' : 'Retapez le même code',
                    }
              : {
                  titre: null,
                  valeur: pin,
                  onChange: setPin,
                  minLongueur: 4,
                  onValider: () => connecter(choisi.id, pin),
                  aide: enCours ? 'Connexion…' : '4 à 6 chiffres · 5 essais avant blocage',
                })}
          enCours={enCours}
          onAnnuler={choisi ? deselectionner : null}
        />
      </div>

      {/* ------- Pied : états du poste + réglage d'affichage ------- */}
      <footer className="relative z-10 flex flex-none items-center justify-between gap-6 border-t border-vitrine-bordure px-8 py-[13px]">
        <div className="flex flex-wrap items-center gap-[18px]">
          <Etat
            couleur={reseauKo ? 'var(--alerte)' : 'var(--ok)'}
            libelle={reseauKo ? 'Réseau local injoignable' : 'Réseau local'}
          />
          <Etat
            couleur={etatPoste?.imprimante_configuree ? 'var(--ok)' : 'var(--attente)'}
            libelle={etatPoste?.imprimante_configuree ? 'Imprimante' : 'Imprimante non configurée'}
          />
          <Etat
            couleur={
              !etatPoste?.cloud.actif
                ? 'var(--vitrine-txt-faible)'
                : etatPoste.cloud.en_attente > 0
                  ? 'var(--attente)'
                  : 'var(--ok)'
            }
            libelle={
              !etatPoste?.cloud.actif
                ? 'Cloud non configuré'
                : etatPoste.cloud.en_attente > 0
                  ? `Cloud : ${etatPoste.cloud.en_attente} en attente`
                  : 'Cloud à jour'
            }
          />
          {/* Fermeture de l'app : seulement dans la coquille kiosque ET au
              moment de choisir l'utilisateur (masqué pendant la saisie du PIN). */}
          {fermerApp && !choisi && (
            confirmerFermeture ? (
              <span className="flex items-center gap-2">
                <span className="text-xs font-semibold text-alerte">Fermer&nbsp;?</span>
                <button
                  type="button"
                  onClick={() => fermerApp()}
                  className="rounded-btn bg-alerte px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-110"
                >
                  Oui, fermer
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmerFermeture(false)}
                  className="rounded-btn border border-vitrine-bordure px-3 py-1.5 text-xs font-semibold text-vitrine-txt-doux transition hover:text-vitrine-txt"
                >
                  Annuler
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmerFermeture(true)}
                className="flex items-center gap-2 rounded-btn border border-vitrine-bordure px-3 py-1.5 text-xs font-semibold text-vitrine-txt-doux transition hover:border-alerte hover:text-alerte"
              >
                <IconPower size={15} />
                Fermer l’application
              </button>
            )
          )}
        </div>

        <ReglageAffichage />
      </footer>
    </div>
  );
}

/** Voyant du pied : pastille de couleur + libellé. */
function Etat({ couleur, libelle }: { couleur: string; libelle: string }) {
  return (
    <span className="flex items-center gap-2 text-[12.5px] font-medium text-vitrine-txt-doux">
      <span className="h-2 w-2 flex-none rounded-full" style={{ background: couleur }} />
      {libelle}
    </span>
  );
}

/**
 * Réglage clair/sombre posé sur l'écran de connexion (§ 6.1). La miniature est
 * peinte avec les JETONS RÉELS : elle change en même temps que le choix, donc
 * le caissier voit ce qu'il choisit avant d'ouvrir un écran de travail.
 */
function ReglageAffichage() {
  const mode = useAffichage((e) => e.mode);
  const poserMode = useAffichage((e) => e.poserMode);
  const choix: { cle: ModeAffichage; libelle: string; icone: JSX.Element }[] = [
    { cle: 'clair', libelle: 'Clair', icone: <IconSun size={17} /> },
    { cle: 'sombre', libelle: 'Sombre', icone: <IconMoon size={17} /> },
  ];

  return (
    <div className="flex flex-none items-center gap-3.5">
      <div className="flex h-11 w-[132px] overflow-hidden rounded-[10px] border border-vitrine-bordure">
        <span className="w-7 bg-ard-850 transition-colors duration-[260ms]" />
        <span className="grid flex-1 grid-cols-2 gap-[5px] bg-plan p-[7px] transition-colors duration-[260ms]">
          <span className="rounded-[4px] border border-filet bg-carte" />
          <span className="rounded-[4px] border border-filet bg-carte" />
        </span>
        <span className="w-[52px] bg-ard-850 transition-colors duration-[260ms]" />
      </div>
      <div className="flex items-center gap-3.5">
        <p className="whitespace-nowrap text-[10.5px] font-bold uppercase tracking-[0.1em] text-vitrine-txt-faible">
          Affichage
        </p>
        <div className="inline-flex gap-1 rounded-full border border-vitrine-bordure bg-vitrine-surface-2 p-1">
          {choix.map((c) => (
            <button
              key={c.cle}
              type="button"
              onClick={() => poserMode(c.cle)}
              className={`inline-flex items-center gap-2 rounded-full px-[17px] py-2.5 text-[13.5px] font-semibold transition ${
                mode === c.cle
                  ? 'bg-marque text-sur-marque'
                  : 'text-vitrine-txt-doux hover:text-vitrine-txt'
              }`}
            >
              {c.icone}
              {c.libelle}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloc PIN : entête (avatar + nom, ou invite), six points, pavé, aide.
// Le pavé se tape toujours ; c'est la VALIDATION qui refuse sans profil.
// ---------------------------------------------------------------------------
interface BlocPinProps {
  entete: JSX.Element;
  titre: string | null;
  valeur: string;
  onChange: (v: string) => void;
  minLongueur: number;
  onValider: () => void;
  aide: string;
  enCours: boolean;
  /** Null tant qu'aucun profil n'est choisi (rien à annuler). */
  onAnnuler: (() => void) | null;
  /** Incrémenté à chaque refus : déclenche la secousse. */
  secousse: number;
}

const LONGUEUR_MAX = 6;

function BlocPin({
  entete,
  titre,
  valeur,
  onChange,
  minLongueur,
  onValider,
  aide,
  enCours,
  onAnnuler,
  secousse,
}: BlocPinProps) {
  const pret = valeur.length >= minLongueur && !enCours;
  const taper = (c: string) => {
    if (valeur.length >= LONGUEUR_MAX) return;
    onChange(valeur + c);
  };

  // Clavier physique (poste de dev, et clavier USB en secours sur un site).
  useEffect(() => {
    const gerer = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        if (valeur.length < LONGUEUR_MAX) onChange(valeur + e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        onChange(valeur.slice(0, -1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onChange('');
      } else if (e.key === 'Enter' && !enCours) {
        e.preventDefault();
        onValider();
      }
    };
    window.addEventListener('keydown', gerer);
    return () => window.removeEventListener('keydown', gerer);
  }, [valeur, onChange, onValider, enCours]);

  return (
    <section
      // `key` : remonter le bloc rejoue l'animation de secousse à chaque refus.
      key={secousse}
      className={`w-full max-w-[380px] self-center justify-self-center rounded-[20px] border border-vitrine-bordure bg-vitrine-surface p-[30px] shadow-[var(--vitrine-ombre)] ${
        secousse > 0 ? 'secousse' : ''
      }`}
    >
      <div className="flex min-h-[74px] flex-col items-center justify-center gap-2.5 text-center">{entete}</div>

      {titre && <p className="mt-2 text-center text-[15px] font-semibold text-vitrine-txt-doux">{titre}</p>}

      {/* Six points, toujours : la longueur du PIN ne se lit pas à l'écran. */}
      <div className="my-[22px] flex justify-center gap-[13px]">
        {Array.from({ length: LONGUEUR_MAX }).map((_, i) => (
          <span
            key={i}
            className={`h-[15px] w-[15px] rounded-full border transition duration-150 ${
              i < valeur.length
                ? 'scale-[1.18] border-marque bg-marque'
                : 'border-vitrine-bordure bg-vitrine-surface-2'
            }`}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2.5">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => (
          <button key={c} type="button" onClick={() => taper(c)} className="touche-vitrine">
            {c}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange(valeur.slice(0, -1))}
          className="touche-vitrine"
          aria-label="Effacer un chiffre"
        >
          <IconArrowBackUp size={24} />
        </button>
        <button type="button" onClick={() => taper('0')} className="touche-vitrine">
          0
        </button>
        <button
          type="button"
          onClick={onValider}
          disabled={enCours}
          aria-label="Valider"
          className={`flex min-h-[62px] items-center justify-center rounded-btn bg-marque text-sur-marque transition active:translate-y-px ${
            pret ? 'hover:brightness-105' : 'opacity-45'
          }`}
        >
          <IconCheck size={26} stroke={2.4} />
        </button>
      </div>

      <p className="mt-[18px] text-center text-[12.5px] text-vitrine-txt-faible">{aide}</p>
      {onAnnuler && (
        <button
          type="button"
          onClick={onAnnuler}
          className="mt-2 w-full text-center text-[12.5px] font-semibold text-vitrine-txt-doux transition hover:text-vitrine-txt"
        >
          ← Changer d’utilisateur
        </button>
      )}
    </section>
  );
}

/** Avatar de profil : photo de l'employé si dispo, sinon initiales (repli si l'URL casse). */
function AvatarProfil({ nom, photo, couleur }: { nom: string; photo: string | null; couleur: CouleurProfil }) {
  const [casse, setCasse] = useState(false);
  if (photo && !casse) {
    return (
      <img
        src={photo}
        alt=""
        loading="eager"
        decoding="async"
        onError={() => setCasse(true)}
        className="h-[46px] w-[46px] rounded-full border border-vitrine-bordure object-cover"
      />
    );
  }
  return (
    <span
      className="flex h-[46px] w-[46px] items-center justify-center rounded-full text-[15px] font-bold tracking-[0.02em]"
      style={{ background: couleur.fond, color: couleur.texte }}
    >
      {initiales(nom)}
    </span>
  );
}
