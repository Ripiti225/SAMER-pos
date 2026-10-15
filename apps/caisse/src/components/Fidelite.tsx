import { useState } from 'react';
import { IconStar, IconUser, IconX } from '@tabler/icons-react';
import type { ClientPaiementVue, CommandeVue } from '@pos/shared';
import { formatFCFA } from '@pos/shared';
import { api } from '../api';
import { useCaisse } from '../stores/session';
import { SuggestionsClients, type ClientTrouve } from './RechercheClient';

/**
 * Client au paiement (§9) : le caissier tape le numéro (au pavé ou au
 * clavier), les numéros correspondants s'affichent en direct, un appui
 * rattache le client. Une fois rattaché : son solde, ce que ce paiement lui
 * rapporte, et s'il peut tout régler avec ses points (mode « Points »).
 *
 * Le numéro tapé appartient à l'écran Paiement : c'est lui qui le fait
 * remplir par le pavé numérique quand la case est active. Les chiffres de
 * points viennent tous du serveur (`info`).
 */
export function Fidelite({
  commande,
  info,
  onMaj,
  telephone,
  setTelephone,
  actif,
  onActiver,
  rechercheAutorisee,
}: {
  commande: CommandeVue;
  info: ClientPaiementVue | undefined;
  onMaj: (vue: CommandeVue) => void;
  telephone: string;
  setTelephone: (v: string) => void;
  actif: boolean;
  onActiver: () => void;
  /** Faux pendant un partage : chaque personne donne son numéro dans « Payer par articles ». */
  rechercheAutorisee: boolean;
}) {
  const { afficherToast } = useCaisse();
  const [enCours, setEnCours] = useState(false);

  const choisir = async (c: ClientTrouve) => {
    setEnCours(true);
    try {
      const r = await api<{ commande: CommandeVue }>(`/api/commandes/${commande.id}/fidelite`, {
        method: 'POST',
        corps: { telephone: c.telephone },
      });
      onMaj(r.commande);
      setTelephone('');
      afficherToast('Client rattaché');
    } catch (e) {
      afficherToast((e as Error).message);
    } finally {
      setEnCours(false);
    }
  };

  if (info?.client) {
    const { client, solde, points_gagnes, solde_apres, paiement_points } = info;
    return (
      <div className="rounded-2xl bg-surface-moyenne p-4 shadow-e1">
        <div className="flex items-center gap-2 font-bold text-fort">
          <IconUser size={20} className="flex-none text-marque-fonce" />
          <span className="truncate">{client.nom ?? 'Client'} · {client.telephone ?? '—'}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-xl bg-surface p-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-doux">Solde actuel</div>
            <div className="text-2xl font-extrabold tabular-nums text-fort">{solde} pts</div>
          </div>
          <div className="rounded-xl bg-ok-tint p-2 text-ok">
            <div className="text-[11px] font-bold uppercase tracking-wider">Après ce paiement</div>
            <div className="text-2xl font-extrabold tabular-nums">{solde_apres} pts</div>
            <div className="text-xs font-semibold">+{points_gagnes} pts gagnés</div>
          </div>
        </div>
        {paiement_points.possible ? (
          <p className="mt-2 flex items-start gap-1.5 rounded-xl px-2 py-1.5 text-sm font-semibold" style={{ background: 'color-mix(in srgb, var(--pay-points) 12%, var(--carte))', color: 'var(--pay-points)' }}>
            <IconStar size={18} className="mt-0.5 flex-none" />
            Peut tout payer avec ses points : {paiement_points.points_necessaires} pts, il lui en restera {paiement_points.solde_apres}.
          </p>
        ) : (
          info.reste > 0 && <p className="mt-2 text-xs text-doux">Paiement en points : {paiement_points.raison}.</p>
        )}
      </div>
    );
  }

  if (!rechercheAutorisee) return null;

  return (
    <div className="rounded-2xl bg-surface-moyenne p-4 shadow-e1">
      <label className="mb-2 flex items-center gap-2 text-sm font-bold text-fort">
        <IconUser size={18} className="text-marque-fonce" /> Numéro du client (facultatif)
      </label>
      <div className="relative">
        <input
          className={`champ w-full pr-10 tabular-nums ${actif ? 'border-marque ring-2 ring-marque/30' : ''}`}
          inputMode="tel"
          placeholder="Ex. 0769…"
          value={telephone}
          onFocus={onActiver}
          onClick={onActiver}
          onChange={(e) => setTelephone(e.target.value)}
        />
        {telephone && (
          <button
            type="button"
            aria-label="Effacer le numéro"
            onClick={() => setTelephone('')}
            className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center text-doux"
          >
            <IconX size={18} />
          </button>
        )}
      </div>
      {!enCours && <SuggestionsClients saisie={telephone} onChoisir={choisir} />}
      {enCours && <p className="mt-2 text-sm text-doux">Rattachement…</p>}
      {commande.fidelite_montant > 0 && (
        <p className="mt-2 text-sm text-ok">Remise fidélité : −{formatFCFA(commande.fidelite_montant)}</p>
      )}
    </div>
  );
}
