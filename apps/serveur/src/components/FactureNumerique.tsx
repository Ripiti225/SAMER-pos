import type { CommandeVue } from '@pos/shared';
import { formatFCFA } from '@pos/shared';
import { Modale } from '@pos/shared-ui';
import { lignesFactureNumerique } from '../facture-tablette';

export function FactureNumerique({
  commande,
  restaurant,
  onFermer,
}: {
  commande: CommandeVue;
  restaurant: string;
  onFermer: () => void;
}) {
  const lignes = lignesFactureNumerique(commande);
  return (
    <Modale
      titre="Facture client"
      large
      onFermer={onFermer}
      enfants={
        <div className="mx-auto max-w-2xl">
          <div className="mb-5 text-center">
            <h2 className="text-2xl font-black text-marque-fonce">{restaurant}</h2>
            <p className="mt-1 text-doux">Table {commande.table_numero ?? '—'} · Ticket n° {commande.numero_ticket}</p>
          </div>
          <div className="divide-y divide-bordure rounded-xl border border-bordure bg-surface">
            {lignes.map((ligne) => (
              <div key={ligne.id} className="p-4">
                <div className="flex gap-3">
                  <span className="font-black text-marque-fonce">{ligne.quantite}×</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-fort">{ligne.nom}</div>
                    {[...ligne.options, ...ligne.supplements].map((detail) => (
                      <div key={detail} className="text-sm text-doux">{detail}</div>
                    ))}
                  </div>
                  <span className="font-bold tabular-nums text-fort">{formatFCFA(ligne.total)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 space-y-2 rounded-xl bg-surface-douce p-4">
            <div className="flex justify-between text-doux"><span>Sous-total</span><span>{formatFCFA(commande.sous_total)}</span></div>
            {commande.promo_montant > 0 && <div className="flex justify-between text-ok"><span>Promotion</span><span>− {formatFCFA(commande.promo_montant)}</span></div>}
            {commande.remise_montant > 0 && <div className="flex justify-between text-ok"><span>Remise</span><span>− {formatFCFA(commande.remise_montant)}</span></div>}
            {commande.fidelite_montant > 0 && <div className="flex justify-between text-ok"><span>Fidélité</span><span>− {formatFCFA(commande.fidelite_montant)}</span></div>}
            <div className="flex justify-between border-t border-bordure pt-3 text-2xl font-black text-marque-fonce">
              <span>Total à payer</span><span>{formatFCFA(commande.total)}</span>
            </div>
          </div>
          <button type="button" className="btn-accent mt-5 min-h-[56px] w-full text-lg" onClick={onFermer}>Fermer</button>
        </div>
      }
    />
  );
}
