import { useMemo, useState } from 'react';
import type { CommandeVue } from '@pos/shared';
import { formatFCFA } from '@pos/shared';
import { Modale } from './Modale';
import { api } from '../api';
import { useCaisse } from '../stores/session';

export interface SelectionArticlePaiement {
  commande_item_id: string;
  quantite: number;
}

export interface NouvelleSousNotePaiement {
  items: SelectionArticlePaiement[];
  client_fidelite_id?: string;
  telephone_fidelite?: string;
  fidelite_points?: number;
}

export function SelectionArticlesPaiement({
  commande,
  enCours,
  onFermer,
  onConfirmer,
}: {
  commande: CommandeVue;
  enCours: boolean;
  onFermer: () => void;
  onConfirmer: (selection: NouvelleSousNotePaiement) => void;
}) {
  const { afficherToast } = useCaisse();
  const disponibles = commande.items.filter((item) => item.statut_cuisine !== 'ANNULE' && item.quantite_disponible > 0);
  const [quantites, setQuantites] = useState<Record<string, number>>({});
  const [telephone, setTelephone] = useState('');
  const [client, setClient] = useState<{ existe: boolean; client_id?: string; solde: number; bareme: { seuil_utilisation: number; valeur_point_fcfa: number } } | null>(null);
  const [utiliserPoints, setUtiliserPoints] = useState(false);
  const selection = disponibles
    .map((item) => ({ commande_item_id: item.id, quantite: quantites[item.id] ?? 0 }))
    .filter((item) => item.quantite > 0);
  const totalBrut = useMemo(
    () => disponibles.reduce((s, item) => s + ((item.total_ligne / item.quantite) * (quantites[item.id] ?? 0)), 0),
    [disponibles, quantites],
  );
  const brutDisponible = disponibles.reduce((s, item) => s + (item.total_ligne / item.quantite) * item.quantite_disponible, 0);
  const notesActives = commande.notes.filter((note) => note.type === 'ARTICLES' && note.statut !== 'ANNULEE');
  const part = (total: number, deja: number) => {
    const restant = Math.max(0, total - deja);
    return totalBrut === brutDisponible ? restant : Math.floor((restant * totalBrut) / Math.max(1, brutDisponible));
  };
  const promoSelection = part(commande.promo_montant, notesActives.reduce((s, note) => s + note.promo_montant, 0));
  const remiseSelection = part(commande.remise_montant, notesActives.reduce((s, note) => s + note.remise_montant, 0));
  const fideliteGlobaleSelection = part(commande.fidelite_montant, notesActives.reduce((s, note) => s + note.fidelite_montant, 0));
  const fidelitePersonne = utiliserPoints && client ? client.solde * client.bareme.valeur_point_fcfa : 0;
  const totalSelection = Math.max(0, totalBrut - promoSelection - remiseSelection - fideliteGlobaleSelection - fidelitePersonne);
  const toutSelectionne = disponibles.every((item) => (quantites[item.id] ?? 0) === item.quantite_disponible);

  const changer = (id: string, maximum: number, delta: number) => {
    setQuantites((courantes) => ({
      ...courantes,
      [id]: Math.max(0, Math.min(maximum, (courantes[id] ?? 0) + delta)),
    }));
  };

  const chercherClient = async () => {
    try {
      setClient(await api(`/api/fidelite/${encodeURIComponent(telephone)}`));
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  return (
    <Modale titre="Payer par articles" onFermer={onFermer} enfants={
      <div className="space-y-4">
        <button
          type="button"
          className="btn-blanc min-h-12 w-full"
          onClick={() => setQuantites(toutSelectionne ? {} : Object.fromEntries(disponibles.map((item) => [item.id, item.quantite_disponible])))}
        >
          {toutSelectionne ? 'Tout désélectionner' : 'Tout sélectionner'}
        </button>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {disponibles.map((item) => {
            const quantite = quantites[item.id] ?? 0;
            const prixUnitaire = item.total_ligne / item.quantite;
            return (
              <div key={item.id} className="rounded-xl border border-bordure bg-surface p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-fort">{item.nom_snapshot}</div>
                    <div className="text-xs text-doux">
                      {item.quantite_disponible} disponible{item.quantite_disponible > 1 ? 's' : ''}
                      {item.quantite_payee > 0 ? ` · ${item.quantite_payee} payé${item.quantite_payee > 1 ? 's' : ''}` : ''}
                    </div>
                  </div>
                  <span className="font-bold tabular-nums">{formatFCFA(prixUnitaire)}</span>
                </div>
                <div className="flex items-center justify-end gap-3">
                  <button type="button" className="touche h-12 w-12" onClick={() => changer(item.id, item.quantite_disponible, -1)}>−</button>
                  <span className="w-10 text-center text-2xl font-bold tabular-nums">{quantite}</span>
                  <button type="button" className="touche h-12 w-12" onClick={() => changer(item.id, item.quantite_disponible, 1)}>+</button>
                </div>
              </div>
            );
          })}
          {disponibles.length === 0 && <p className="py-8 text-center text-doux">Tous les articles sont déjà réservés ou payés.</p>}
        </div>

        <div className="flex items-baseline justify-between border-t border-bordure pt-4">
          <span className="font-semibold">Sous-total sélectionné</span>
          <span className="text-2xl font-extrabold text-marque-fonce tabular-nums">{formatFCFA(totalBrut)}</span>
        </div>
        {promoSelection > 0 && <div className="flex justify-between text-sm text-ok"><span>Part de promotion</span><span>−{formatFCFA(promoSelection)}</span></div>}
        {remiseSelection > 0 && <div className="flex justify-between text-sm text-ok"><span>Part de remise</span><span>−{formatFCFA(remiseSelection)}</span></div>}
        {(fideliteGlobaleSelection + fidelitePersonne) > 0 && <div className="flex justify-between text-sm text-ok"><span>Fidélité</span><span>−{formatFCFA(fideliteGlobaleSelection + fidelitePersonne)}</span></div>}
        <div className="flex items-baseline justify-between"><span className="font-bold">Total à payer</span><span className="text-2xl font-black tabular-nums">{formatFCFA(totalSelection)}</span></div>
        <p className="text-xs text-doux">Les promotions et remises sont réparties automatiquement lors de la confirmation.</p>

        <div className="rounded-xl bg-surface-moyenne p-3">
          <label className="mb-2 block text-sm font-semibold">Fidélité de cette personne (facultatif)</label>
          <div className="flex gap-2">
            <input
              className="champ min-w-0 flex-1"
              inputMode="tel"
              placeholder="Téléphone"
              value={telephone}
              onChange={(e) => { setTelephone(e.target.value); setClient(null); setUtiliserPoints(false); }}
            />
            <button type="button" className="btn-blanc min-h-12 px-4" disabled={telephone.trim().length < 6} onClick={chercherClient}>Chercher</button>
          </div>
          {client && (
            <div className="mt-2 text-sm text-doux">
              {client.existe ? `Solde : ${client.solde} points` : 'Nouveau client — il sera créé avec ce téléphone.'}
              {client.existe && client.solde >= client.bareme.seuil_utilisation && (
                <label className="mt-2 flex min-h-12 items-center gap-2 rounded-lg bg-surface px-3">
                  <input type="checkbox" checked={utiliserPoints} onChange={(e) => setUtiliserPoints(e.target.checked)} />
                  Utiliser {client.solde} points (−{formatFCFA(client.solde * client.bareme.valeur_point_fcfa)})
                </label>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className="h-14 w-full rounded-[13px] bg-marque text-lg font-bold text-sur-marque shadow-e2 disabled:opacity-40"
          disabled={selection.length === 0 || totalSelection <= 0 || enCours}
          onClick={() => onConfirmer({
            items: selection,
            ...(client?.client_id ? { client_fidelite_id: client.client_id } : {}),
            ...(client && !client.existe ? { telephone_fidelite: telephone.trim() } : {}),
            ...(utiliserPoints && client ? { fidelite_points: client.solde } : {}),
          })}
        >
          {enCours ? 'Préparation…' : 'Confirmer cette sélection'}
        </button>
      </div>
    } />
  );
}
