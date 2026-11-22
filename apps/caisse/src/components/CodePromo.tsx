import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react';
import type { CanalCodePromo, CommandeVue } from '@pos/shared';
import { CANAUX_CODE_PROMO, LIBELLES_CANAL_CODE_PROMO } from '@pos/shared';
import { api } from '../api';

const jourMois = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Code promo carte sur l'addition (brief PROMO § 5) : le code de l'autocollant
 * OU le numéro du client, vérifié par le serveur de la caisse, hors ligne.
 *
 * Tant qu'un texte est tapé sans être vérifié, `onNonVerifie(true)` : l'écran
 * bloque « Envoyer en cuisine » et « Encaisser » — sinon le client perdrait sa
 * remise sans que personne ne s'en aperçoive. Le serveur garde la main sur le
 * calcul ; ici on n'affiche que ce qu'il renvoie.
 */
export function CodePromo({
  commande,
  desactive,
  onVue,
  onErreur,
  onNonVerifie,
}: {
  commande: CommandeVue;
  desactive: boolean;
  onVue: (vue: CommandeVue) => void;
  onErreur: (message: string) => void;
  onNonVerifie: (nonVerifie: boolean) => void;
}) {
  const [saisie, setSaisie] = useState('');
  const [refus, setRefus] = useState<string | null>(null);
  const [autres, setAutres] = useState(0);
  const applique = commande.code_promo;

  useEffect(() => {
    onNonVerifie(!applique && saisie.trim().length > 0);
  }, [applique, saisie, onNonVerifie]);

  const verifier = useMutation({
    mutationFn: () =>
      api<{ commande: CommandeVue; autres_codes: number }>(`/api/commandes/${commande.id}/code-promo`, {
        method: 'POST',
        corps: { saisie, canal: 'SUR_PLACE' satisfies CanalCodePromo },
      }),
    onSuccess: (r) => {
      setRefus(null);
      setAutres(r.autres_codes);
      setSaisie('');
      onVue(r.commande);
    },
    onError: (e: Error) => setRefus(e.message),
  });
  const retirer = useMutation({
    mutationFn: () => api<CommandeVue>(`/api/commandes/${commande.id}/code-promo`, { method: 'DELETE' }),
    onSuccess: (vue) => {
      setAutres(0);
      onVue(vue);
    },
    onError: (e: Error) => onErreur(e.message),
  });
  const changerCanal = useMutation({
    mutationFn: (canal: CanalCodePromo) =>
      api<CommandeVue>(`/api/commandes/${commande.id}/code-promo/canal`, { method: 'PUT', corps: { canal } }),
    onSuccess: onVue,
    onError: (e: Error) => onErreur(e.message),
  });

  if (applique) {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-3 rounded-[12px] bg-ok/15 px-3.5 py-3">
          <IconCheck size={24} className="flex-none text-ok" stroke={2.6} />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-bold text-[#b9f0cc]">Code valide −{applique.pourcentage} %</p>
            <p className="text-[13px] text-[#9fd7b2]">
              {applique.code_masque} · expire le {jourMois(applique.valide_au)}
              {autres > 0 && ` · ${autres} autre${autres > 1 ? 's' : ''} code${autres > 1 ? 's' : ''} en réserve`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => retirer.mutate()}
            disabled={desactive || retirer.isPending}
            className="flex h-12 w-12 flex-none items-center justify-center rounded-full text-ard-txt-doux transition hover:bg-alerte/20 hover:text-alerte disabled:opacity-40"
            aria-label="Retirer le code promo"
            title="Retirer le code promo"
          >
            <IconX size={20} />
          </button>
        </div>
        <p className="text-[13px] font-semibold text-ard-txt-doux">Le client commande par…</p>
        <div className="grid grid-cols-3 gap-2">
          {CANAUX_CODE_PROMO.map((canal) => (
            <button
              key={canal}
              type="button"
              aria-pressed={applique.canal === canal}
              disabled={desactive || changerCanal.isPending}
              onClick={() => applique.canal !== canal && changerCanal.mutate(canal)}
              className={`min-h-[48px] rounded-[12px] border-2 px-2 text-[13px] font-bold transition disabled:opacity-60 ${
                applique.canal === canal ? 'border-marque bg-marque/15 text-marque-clair' : 'border-ard-650 text-ard-txt-doux hover:border-ard-600'
              }`}
            >
              {LIBELLES_CANAL_CODE_PROMO[canal]}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const tape = saisie.trim().length > 0;
  return (
    <div className="space-y-2">
      <label htmlFor="code-promo" className="block text-[13px] font-semibold text-ard-txt-doux">
        Code promo ou n° client
      </label>
      <div className="flex gap-2">
        <input
          id="code-promo"
          value={saisie}
          onChange={(e) => {
            setSaisie(e.target.value);
            setRefus(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && tape && verifier.mutate()}
          autoComplete="off"
          placeholder="PAM-7K3QX ou 07 08 12 34 21"
          className={`h-12 min-w-0 flex-1 rounded-[12px] border-2 bg-ard-900 px-3 font-mono text-base text-ard-txt placeholder:text-ard-txt-faible focus:outline-none ${
            refus ? 'border-alerte' : tape ? 'border-attente' : 'border-ard-650 focus:border-marque'
          }`}
        />
        <button
          type="button"
          onClick={() => verifier.mutate()}
          disabled={!tape || desactive || verifier.isPending}
          className="h-12 flex-none rounded-[12px] bg-marque px-4 text-[15px] font-bold text-sur-marque transition hover:brightness-105 disabled:opacity-40"
        >
          {verifier.isPending ? '…' : 'Vérifier'}
        </button>
      </div>
      {refus ? (
        <p role="alert" className="flex items-start gap-2 rounded-[12px] bg-alerte/15 px-3 py-2.5 text-[14px] font-semibold text-[#ff9d9d]">
          <IconX size={18} className="mt-0.5 flex-none" /> {refus}
        </p>
      ) : (
        tape && (
          <p className="flex items-center gap-2 rounded-[12px] bg-attente/20 px-3 py-2.5 text-[14px] font-semibold text-[#ffd08a]">
            <IconAlertTriangle size={18} className="flex-none" /> Vérifiez le code promo ou effacez-le
          </p>
        )
      )}
    </div>
  );
}
