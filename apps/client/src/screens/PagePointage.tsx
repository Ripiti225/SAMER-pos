import { useState } from 'react';
import { api } from '../api';

/**
 * Page pointage employé (§7 A2/A3) — géolocalisation ou code SMS.
 * La vérification de distance et du code se fait CÔTÉ SERVEUR.
 */
export function PagePointage() {
  const [telephone, setTelephone] = useState('');
  const [pin, setPin] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  const reset = () => { setMessage(null); setErreur(null); };

  const geoloc = () => {
    reset();
    if (!navigator.geolocation) {
      setErreur('Géolocalisation indisponible sur cet appareil — utilisez le code SMS.');
      return;
    }
    setEnCours(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const r = await api<{ message: string }>('/api/pointage/geoloc', {
            method: 'POST',
            corps: { telephone, pin, lat: pos.coords.latitude, lng: pos.coords.longitude },
          });
          setMessage(r.message);
        } catch (e) {
          setErreur((e as Error).message);
        } finally {
          setEnCours(false);
        }
      },
      () => { setErreur('Position refusée. Autorisez la localisation ou utilisez le code SMS.'); setEnCours(false); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const demanderSms = async () => {
    reset();
    try {
      await api('/api/pointage/sms/demander', { method: 'POST', corps: { telephone } });
      setMessage('Code envoyé par SMS. Saisissez-le ci-dessous.');
    } catch (e) {
      setErreur((e as Error).message);
    }
  };

  const validerSms = async () => {
    reset();
    setEnCours(true);
    try {
      const r = await api<{ message: string }>('/api/pointage/sms/valider', {
        method: 'POST',
        corps: { telephone, code },
      });
      setMessage(r.message);
      setCode('');
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnCours(false);
    }
  };

  return (
    <div className="min-h-full bg-fond p-6 text-fort">
      <div className="mx-auto max-w-sm space-y-4">
        <h1 className="text-center text-2xl font-black text-marque-fonce">Pointage employé</h1>

        <input className="champ" inputMode="tel" placeholder="Votre téléphone" value={telephone} onChange={(e) => setTelephone(e.target.value)} />
        <input className="champ" inputMode="numeric" placeholder="Votre PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />

        <button type="button" className="btn-accent w-full py-4 text-lg" disabled={enCours || pin.length < 4} onClick={geoloc}>
          Pointer par géolocalisation
        </button>

        <div className="border-t border-bordure pt-4">
          <p className="mb-2 text-sm text-doux">Pas de réseau data ? Recevez un code par SMS :</p>
          <button type="button" className="btn-blanc mb-2 w-full" onClick={demanderSms} disabled={telephone.length < 6}>
            Recevoir un code SMS
          </button>
          <div className="flex gap-2">
            <input className="champ flex-1" inputMode="numeric" placeholder="Code à 6 chiffres" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button type="button" className="btn-ok px-4" disabled={code.length !== 6 || enCours} onClick={validerSms}>
              Valider
            </button>
          </div>
        </div>

        {message && <div className="rounded-xl bg-ok-tint px-4 py-3 text-center font-semibold text-ok">{message}</div>}
        {erreur && <div className="rounded-xl bg-alerte-tint px-4 py-3 text-center text-alerte">{erreur}</div>}
      </div>
    </div>
  );
}
