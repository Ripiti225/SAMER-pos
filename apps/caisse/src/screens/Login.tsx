import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SessionInfo, UtilisateurPublic } from '@pos/shared';
import { PINS_INTERDITS } from '@pos/shared';
import { api } from '../api';
import { Numpad } from '../components/Numpad';
import { useCaisse } from '../stores/session';

const LIBELLES_ROLES: Record<string, string> = {
  PROPRIETAIRE: 'Propriétaire',
  MANAGER: 'Manager',
  CAISSIER: 'Caissier',
  SERVEUR: 'Serveur',
  CUISINE: 'Cuisine',
};

/** Sous-étapes du premier accès (l'employé pose son PIN avec un code temporaire). */
type EtapeDef = 'code' | 'pin' | 'confirmation';

export function Login() {
  const { poserSession, afficherToast } = useCaisse();
  const queryClient = useQueryClient();
  const [choisi, setChoisi] = useState<UtilisateurPublic | null>(null);
  const [pin, setPin] = useState('');
  const [enCours, setEnCours] = useState(false);
  // Premier accès : pose du PIN
  const [etapeDef, setEtapeDef] = useState<EtapeDef>('code');
  const [code, setCode] = useState('');
  const [nouveauPin, setNouveauPin] = useState('');

  const { data: utilisateurs } = useQuery({
    queryKey: ['utilisateurs-login'],
    queryFn: () => api<UtilisateurPublic[]>('/api/auth/utilisateurs'),
  });

  const reinitialiser = () => {
    setChoisi(null);
    setPin('');
    setCode('');
    setNouveauPin('');
    setEtapeDef('code');
  };

  const connecter = async (utilisateurId: string, pinSaisi: string) => {
    setEnCours(true);
    try {
      const session = await api<SessionInfo>('/api/auth/login', {
        method: 'POST',
        corps: { utilisateur_id: utilisateurId, pin: pinSaisi },
      });
      poserSession(session);
    } catch (e) {
      afficherToast((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  // Premier accès : valide code + PIN + confirmation, puis connecte automatiquement.
  const definirPin = async (confirmation: string) => {
    if (!choisi) return;
    if (confirmation !== nouveauPin) {
      afficherToast('Les deux PIN ne correspondent pas');
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
      // Code temporaire faux/expiré : on repart proprement de la saisie du code.
      afficherToast((e as Error).message);
      setCode('');
      setNouveauPin('');
      setEtapeDef('code');
      setEnCours(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-8 p-6">
      <div className="text-center">
        <h1 className="text-4xl font-black text-marque-fonce">Chez Samer / Al Kayan</h1>
        <p className="mt-2 text-doux">Caisse — connexion par PIN</p>
      </div>

      {!choisi ? (
        <div className="grid w-full max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3">
          {(utilisateurs ?? []).map((u) => (
            <button key={u.id} type="button" className="carte min-h-[80px] p-4 text-left hover:border-marque" onClick={() => { setChoisi(u); setEtapeDef('code'); }}>
              <div className="font-bold">{u.nom_complet}</div>
              <div className="text-sm text-doux">{u.role_nom ?? (u.role ? LIBELLES_ROLES[u.role] : '')}</div>
              {u.doit_definir_pin && <div className="mt-1 text-xs font-semibold text-amber-600">PIN à définir</div>}
            </button>
          ))}
        </div>
      ) : choisi.doit_definir_pin ? (
        <div className="w-full max-w-xs space-y-3">
          <div className="text-center">
            <div className="text-lg font-semibold">{choisi.nom_complet}</div>
            <div className="text-sm text-doux">Premier accès — définissez votre PIN</div>
          </div>

          {etapeDef === 'code' && (
            <>
              <p className="text-center text-sm text-doux">Saisissez le code temporaire à 6 chiffres reçu du manager</p>
              <div className="champ flex items-center justify-center text-3xl tracking-[0.4em]">
                {'•'.repeat(code.length) || <span className="text-base tracking-normal text-doux">Code</span>}
              </div>
              <Numpad
                valeur={code}
                onChange={setCode}
                longueurMax={6}
                onValider={() => setEtapeDef('pin')}
                libelleValider="Continuer"
                validerDesactive={code.length !== 6}
              />
            </>
          )}

          {etapeDef === 'pin' && (
            <>
              <p className="text-center text-sm text-doux">Choisissez votre PIN (4 à 6 chiffres)</p>
              <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
                {'•'.repeat(nouveauPin.length) || <span className="text-base tracking-normal text-doux">Nouveau PIN</span>}
              </div>
              <Numpad
                valeur={nouveauPin}
                onChange={setNouveauPin}
                longueurMax={6}
                onValider={() => {
                  if (PINS_INTERDITS.includes(nouveauPin)) {
                    afficherToast('Ce PIN est trop facile à deviner');
                    setNouveauPin('');
                    return;
                  }
                  setEtapeDef('confirmation');
                }}
                libelleValider="Continuer"
                validerDesactive={nouveauPin.length < 4}
              />
            </>
          )}

          {etapeDef === 'confirmation' && (
            <ConfirmationPin
              attendu={nouveauPin}
              enCours={enCours}
              onValider={definirPin}
            />
          )}

          <button type="button" className="btn-blanc w-full" onClick={reinitialiser}>
            ← Changer d’utilisateur
          </button>
        </div>
      ) : (
        <div className="w-full max-w-xs space-y-3">
          <div className="text-center text-lg font-semibold">{choisi.nom_complet}</div>
          <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
            {'•'.repeat(pin.length) || <span className="text-base tracking-normal text-doux">PIN</span>}
          </div>
          <Numpad
            valeur={pin}
            onChange={setPin}
            longueurMax={6}
            onValider={() => connecter(choisi.id, pin)}
            libelleValider={enCours ? '…' : 'Se connecter'}
            validerDesactive={pin.length < 4 || enCours}
          />
          <button type="button" className="btn-blanc w-full" onClick={reinitialiser}>
            ← Changer d’utilisateur
          </button>
        </div>
      )}
    </div>
  );
}

/** Saisie de confirmation du PIN (champ isolé pour ne pas partager l'état du PIN). */
function ConfirmationPin({ attendu, enCours, onValider }: { attendu: string; enCours: boolean; onValider: (pin: string) => void }) {
  const [confirmation, setConfirmation] = useState('');
  return (
    <>
      <p className="text-center text-sm text-doux">Confirmez votre PIN</p>
      <div className="champ flex items-center justify-center text-3xl tracking-[0.5em]">
        {'•'.repeat(confirmation.length) || <span className="text-base tracking-normal text-doux">Confirmer</span>}
      </div>
      <Numpad
        valeur={confirmation}
        onChange={setConfirmation}
        longueurMax={6}
        onValider={() => onValider(confirmation)}
        libelleValider={enCours ? '…' : 'Valider mon PIN'}
        validerDesactive={confirmation.length !== attendu.length || enCours}
      />
    </>
  );
}
