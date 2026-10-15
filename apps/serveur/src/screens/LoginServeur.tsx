import { useEffect, useState } from 'react';
import { IconArrowLeft, IconToolsKitchen2 } from '@tabler/icons-react';
import { PINS_INTERDITS } from '@pos/shared';
import type { SessionInfo, UtilisateurPublic } from '@pos/shared';
import { api, Numpad } from '@pos/shared-ui';

/** Sous-étapes du premier accès (l'employé pose son PIN avec un code temporaire). */
type EtapeDef = 'code' | 'pin' | 'confirmation';

/**
 * Connexion PIN, rôle SERVEUR (§B5).
 *
 * Porte AUSSI le premier accès (code temporaire → PIN → confirmation), comme la
 * caisse : depuis que la caisse ne propose plus les comptes de salle, c'est le
 * seul écran où un serveur peut poser son PIN.
 */
export function LoginServeur({ onConnecte }: { onConnecte: (s: SessionInfo) => void }) {
  const [utilisateurs, setUtilisateurs] = useState<UtilisateurPublic[]>([]);
  const [choisi, setChoisi] = useState<UtilisateurPublic | null>(null);
  const [pin, setPin] = useState('');
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  // Premier accès : pose du PIN
  const [etapeDef, setEtapeDef] = useState<EtapeDef>('code');
  const [code, setCode] = useState('');
  const [nouveauPin, setNouveauPin] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const chargerUtilisateurs = () =>
    api<UtilisateurPublic[]>('/api/auth/utilisateurs')
      .then((tous) =>
        setUtilisateurs(tous.filter((u) => ['SERVEUR', 'MANAGER', 'PROPRIETAIRE'].includes(u.role_nom ?? u.role ?? ''))),
      )
      .catch(() => setErreur('Serveur injoignable — vérifiez le réseau'));

  useEffect(() => {
    void chargerUtilisateurs();
  }, []);

  const reinitialiserSaisie = () => {
    setPin('');
    setCode('');
    setNouveauPin('');
    setConfirmation('');
    setEtapeDef('code');
  };

  const choisirUtilisateur = (u: UtilisateurPublic) => {
    setChoisi(u);
    setErreur(null);
    reinitialiserSaisie();
  };

  const deselectionner = () => {
    setChoisi(null);
    setErreur(null);
    reinitialiserSaisie();
  };

  const seConnecter = async (pinSaisi: string = pin) => {
    if (!choisi) return;
    setEnCours(true);
    setErreur(null);
    try {
      const session = await api<SessionInfo>('/api/auth/login', {
        method: 'POST',
        corps: { utilisateur_id: choisi.id, pin: pinSaisi },
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

  // Premier accès : valide code + PIN + confirmation, puis connecte automatiquement.
  const definirPin = async () => {
    if (!choisi) return;
    if (confirmation !== nouveauPin) {
      setErreur('Les deux PIN ne correspondent pas');
      setConfirmation('');
      setNouveauPin('');
      setEtapeDef('pin');
      return;
    }
    setEnCours(true);
    setErreur(null);
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
      void chargerUtilisateurs();
      await seConnecter(nouveauPin);
    } catch (e) {
      setErreur((e as Error).message);
      setCode('');
      setNouveauPin('');
      setConfirmation('');
      setEtapeDef('code');
      setEnCours(false);
    }
  };

  // Ce que montre le bloc PIN : connexion normale, ou l'étape du premier accès.
  const saisie = !choisi?.doit_definir_pin
    ? {
        titre: null,
        valeur: pin,
        onChange: setPin,
        minLongueur: 4,
        onValider: () => void seConnecter(),
        libelle: enCours ? 'Connexion…' : 'Se connecter',
        indice: 'PIN',
      }
    : etapeDef === 'code'
      ? {
          titre: 'Premier accès — code temporaire',
          valeur: code,
          onChange: setCode,
          minLongueur: 6,
          onValider: () => {
            setErreur(null);
            setEtapeDef('pin');
          },
          libelle: 'Suivant',
          indice: '6 chiffres du manager',
        }
      : etapeDef === 'pin'
        ? {
            titre: 'Choisissez votre PIN',
            valeur: nouveauPin,
            onChange: setNouveauPin,
            minLongueur: 4,
            onValider: () => {
              if (PINS_INTERDITS.includes(nouveauPin)) {
                setErreur('Ce PIN est trop facile à deviner');
                setNouveauPin('');
                return;
              }
              setErreur(null);
              setEtapeDef('confirmation');
            },
            libelle: 'Suivant',
            indice: '4 à 6 chiffres',
          }
        : {
            titre: 'Confirmez votre PIN',
            valeur: confirmation,
            onChange: setConfirmation,
            minLongueur: nouveauPin.length,
            onValider: () => void definirPin(),
            libelle: enCours ? 'Validation…' : 'Valider mon PIN',
            indice: 'Retapez le même code',
          };

  const initiales = (nom: string) =>
    nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('');
  const libelleRole = (u: UtilisateurPublic) =>
    u.doit_definir_pin
      ? 'PIN à définir'
      : u.role === 'SERVEUR' ? 'Serveur' : u.role === 'MANAGER' ? 'Manager' : 'Propriétaire';

  return (
    // Écran vitrine (DESIGN_V2 § 6.1) : fond neutre, tuiles blanches, la
    // couleur de marque seulement sur l'action. Conteneur scrollable + contenu
    // centré : `justify-center` seul écrête le haut de la liste dès qu'elle
    // déborde (petit téléphone, équipe nombreuse).
    <div className="h-full overflow-y-auto bg-vitrine-fond text-vitrine-txt">
      <div className="marge-sure-bas marge-sure-cotes mx-auto flex min-h-full max-w-xl flex-col justify-center gap-6 px-4 py-8">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 flex-none items-center justify-center rounded-btn bg-marque text-sur-marque">
            <IconToolsKitchen2 size={24} />
          </span>
          <div>
            <h1 className="text-2xl font-bold">Salle</h1>
            <p className="text-sm text-vitrine-txt-doux">
              {choisi ? 'Saisissez votre code' : 'Qui prend le service ?'}
            </p>
          </div>
        </div>

        {!choisi ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {utilisateurs.map((u) => (
              <button
                key={u.id}
                type="button"
                className="flex min-h-[108px] flex-col items-center justify-center gap-2 rounded-jeton border border-vitrine-bordure bg-vitrine-surface p-3 text-center shadow-e1 transition active:scale-[0.98]"
                onClick={() => choisirUtilisateur(u)}
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-vitrine-surface-2 text-sm font-bold text-vitrine-txt">
                  {initiales(u.nom_complet)}
                </span>
                <span className="w-full truncate text-sm font-semibold leading-tight">{u.nom_complet}</span>
                <span className={`text-[11px] font-semibold ${u.doit_definir_pin ? 'text-attente-txt' : 'text-vitrine-txt-faible'}`}>
                  {libelleRole(u)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-xs space-y-3 rounded-jeton border border-vitrine-bordure bg-vitrine-surface p-5 shadow-e2">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-vitrine-surface-2 text-sm font-bold">
                {initiales(choisi.nom_complet)}
              </span>
              <div className="min-w-0">
                <div className="truncate font-bold">{choisi.nom_complet}</div>
                {saisie.titre && <div className="text-sm font-medium text-vitrine-txt-doux">{saisie.titre}</div>}
              </div>
            </div>
            <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
              {'•'.repeat(saisie.valeur.length) || (
                <span className="text-base tracking-normal text-txt-doux">{saisie.indice}</span>
              )}
            </div>
            <Numpad
              valeur={saisie.valeur}
              onChange={saisie.onChange}
              longueurMax={6}
              code
              onValider={saisie.onValider}
              libelleValider={saisie.libelle}
              validerDesactive={saisie.valeur.length < saisie.minLongueur || enCours}
            />
            <button type="button" className="btn-blanc flex w-full items-center justify-center gap-2" onClick={deselectionner}>
              <IconArrowLeft size={18} /> Changer d’utilisateur
            </button>
          </div>
        )}

        {erreur && <div className="rounded-btn bg-alerte-tint px-4 py-3 text-center font-medium text-alerte-txt">{erreur}</div>}
      </div>
    </div>
  );
}
