import { useEffect, useState } from 'react';
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

  return (
    // Conteneur scrollable + contenu centré : `justify-center` seul écrête le
    // haut de la liste dès qu'elle déborde (petit téléphone, équipe nombreuse).
    <div className="h-full overflow-y-auto">
      <div className="marge-sure-bas flex min-h-full flex-col items-center justify-center gap-6 p-4 sm:p-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-marque-fonce sm:text-3xl">Serveur de salle</h1>
          <p className="mt-1 text-doux">Connexion par PIN</p>
        </div>

        {!choisi ? (
          <div className="grid w-full max-w-xl grid-cols-2 gap-3 sm:grid-cols-3">
            {utilisateurs.map((u) => (
              <button
                key={u.id}
                type="button"
                className="carte flex min-h-[92px] flex-col items-center justify-center gap-1 p-4 text-center shadow-e1 transition hover:shadow-e2"
                onClick={() => choisirUtilisateur(u)}
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-marque-tint text-sm font-bold text-marque-fonce">
                  {u.nom_complet.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('')}
                </div>
                <div className="text-sm font-semibold leading-tight">{u.nom_complet}</div>
                <div className="rounded-full bg-surface-tres-haute px-2 py-0.5 text-[11px] font-medium text-doux">
                  {u.doit_definir_pin
                    ? 'PIN à définir'
                    : u.role === 'SERVEUR' ? 'Serveur' : u.role === 'MANAGER' ? 'Manager' : 'Propriétaire'}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="carte w-full max-w-xs space-y-3 p-6 shadow-e2">
            <div className="text-center text-lg font-semibold text-fort">{choisi.nom_complet}</div>
            {saisie.titre && <div className="text-center text-sm font-medium text-marque-fonce">{saisie.titre}</div>}
            <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
              {'•'.repeat(saisie.valeur.length) || (
                <span className="text-base tracking-normal text-doux">{saisie.indice}</span>
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
            <button type="button" className="btn-blanc w-full" onClick={deselectionner}>
              ← Changer d’utilisateur
            </button>
          </div>
        )}

        {erreur && <div className="rounded-[13px] bg-alerte-tint px-5 py-3 font-medium text-alerte">{erreur}</div>}
      </div>
    </div>
  );
}
