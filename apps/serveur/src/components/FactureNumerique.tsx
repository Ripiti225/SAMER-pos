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
            <h2 className="text-2xl font-black text-txt">{restaurant}</h2>
            <p className="mt-1 text-txt-doux">Table {commande.table_numero ?? '—'} · Ticket n° {commande.numero_ticket}</p>
          </div>
          <div className="divide-y divide-filet rounded-jeton border border-filet bg-carte">
            {lignes.map((ligne) => (
              <div key={ligne.id} className="p-4">
                <div className="flex gap-3">
                  <span className="w-8 flex-none font-black tabular-nums text-txt">{ligne.quantite}×</span>
                  <div className="min-w-0 flex-1">
                    <div className="break-words font-bold text-txt">{ligne.nom}</div>
                    {[...ligne.options, ...ligne.supplements].map((detail) => (
                      <div key={detail} className="text-sm text-txt-doux">{detail}</div>
                    ))}
                  </div>
                  <span className="flex-none font-bold tabular-nums text-txt">{formatFCFA(ligne.total)}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 space-y-2 rounded-jeton bg-carte-douce p-4">
            <div className="flex justify-between text-txt-doux"><span>Sous-total</span><span>{formatFCFA(commande.sous_total)}</span></div>
            {commande.promo_montant > 0 && <div className="flex justify-between text-ok-txt"><span>Promotion</span><span>− {formatFCFA(commande.promo_montant)}</span></div>}
            {commande.remise_montant > 0 && <div className="flex justify-between text-ok-txt"><span>Remise</span><span>− {formatFCFA(commande.remise_montant)}</span></div>}
            {commande.fidelite_montant > 0 && <div className="flex justify-between text-ok-txt"><span>Fidélité</span><span>− {formatFCFA(commande.fidelite_montant)}</span></div>}
            <div className="flex justify-between border-t border-filet pt-3 text-2xl font-black tabular-nums text-txt">
              <span>Total à payer</span><span>{formatFCFA(commande.total)}</span>
            </div>
          </div>
          <button type="button" className="btn-accent mt-5 min-h-[56px] w-full text-lg" onClick={onFermer}>Fermer</button>
        </div>
      }
    />
  );
}
