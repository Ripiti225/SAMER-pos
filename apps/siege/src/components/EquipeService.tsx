import { useQuery } from '@tanstack/react-query';
import { formatFCFA } from '@pos/shared';
import { appelSiege, ErreurSiege, type MembreService } from '../api';
import { heure } from '../periode';

/**
 * L'équipe du service, NOMINATIVE — qui était là, arrivé à quelle heure, parti
 * à quelle heure.
 *
 * Le rapport Z figé ne porte que trois compteurs (présents / restent / partis) :
 * les noms et les heures vivent dans `equipe_service`, qui remonte au cloud. On
 * va donc les chercher à l'ouverture du ticket — ce qui a l'avantage de marcher
 * aussi sur les clôtures DÉJÀ passées, alors qu'un ajout au rapport Z ne
 * vaudrait que pour les clôtures à venir.
 *
 * **Heure de départ** (règle donnée le 2026-08-24) :
 *   - payé à la journée → l'**heure de paie**, celle de la ligne de dépense
 *     SALAIRES, datée par le système au clic sur « Payer » ;
 *   - sinon → l'**heure de clôture** du service, dite comme telle : elle est
 *     présumée, pas pointée, et l'écran ne doit pas laisser croire l'inverse.
 */
export function EquipeService({
  serviceId,
  restaurantId,
  clotureLe,
}: {
  serviceId: string;
  restaurantId: string;
  clotureLe: string | null;
}) {
  const { data, error, isPending } = useQuery({
    queryKey: ['equipe_service', serviceId],
    queryFn: () => appelSiege<{ membres: MembreService[] }>('equipe_service', { service_id: serviceId, restaurant_id: restaurantId }),
  });

  if (isPending) return <div className="h-16 animate-pulse rounded-jeton bg-carte-douce" />;
  if (error) {
    return <p className="text-sm text-alerte-txt">{error instanceof ErreurSiege ? error.message : 'Équipe illisible'}</p>;
  }

  const membres = data?.membres ?? [];
  if (membres.length === 0) return <p className="text-sm text-faible">Aucune équipe enregistrée pour ce service.</p>;

  const totalPaye = membres.reduce((t, m) => t + (m.salaire?.montant ?? 0), 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-filet text-[11px] uppercase tracking-wide text-faible">
            <th className="py-1.5 pr-3 font-semibold">Travailleur</th>
            <th className="px-3 py-1.5 font-semibold">Poste</th>
            <th className="px-3 py-1.5 text-right font-semibold">Arrivée</th>
            <th className="px-3 py-1.5 text-right font-semibold">Départ</th>
            <th className="px-3 py-1.5 text-right font-semibold">Salaire</th>
            <th className="py-1.5 pl-3 text-right font-semibold">État</th>
          </tr>
        </thead>
        <tbody>
          {membres.map((m) => {
            // Non marqué « Reste » = PARTI : c'est la règle appliquée à la
            // clôture, le caissier ne marque que les exceptions.
            const reste = m.reste === true;
            const paye = m.salaire;
            const depart = paye ? heure(paye.paye_le) : reste ? '—' : heure(clotureLe);
            const departSource = paye ? 'paie' : reste ? '' : 'clôture';
            return (
              <tr key={m.utilisateur_id} className="border-b border-filet last:border-0">
                <td className="py-2 pr-3 font-semibold">{m.nom_complet ?? 'Nom inconnu'}</td>
                <td className="px-3 py-2 text-doux">{m.poste ?? '—'}</td>
                <td className="chiffres px-3 py-2 text-right">{heure(m.arrive_le)}</td>
                <td className="chiffres px-3 py-2 text-right">
                  {depart}
                  {departSource && <span className="ml-1 text-[11px] font-normal text-faible">({departSource})</span>}
                </td>
                <td className={`chiffres px-3 py-2 text-right ${paye ? '' : 'text-faible'}`}>
                  {paye ? formatFCFA(paye.montant) : m.taux_journalier ? `non payé (${formatFCFA(m.taux_journalier)}/j)` : '—'}
                </td>
                <td className="py-2 pl-3 text-right">
                  <span className={`rounded-sm px-2 py-0.5 text-xs font-semibold ${reste ? 'bg-ok-tint text-ok-txt' : 'bg-carte-douce text-doux'}`}>
                    {reste ? 'Reste' : 'Parti'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex items-baseline justify-between gap-3 font-bold">
        <span>Total salaires payés</span>
        <span className={`chiffres ${totalPaye > 0 ? '' : 'text-faible'}`}>{formatFCFA(totalPaye)}</span>
      </div>
      <p className="mt-1.5 text-xs text-faible">
        Arrivée = heure du clic sur « Pointer » sur le site. Départ = heure de paie pour qui est payé à la journée,
        heure de clôture du service sinon — présumée, pas pointée.
      </p>
    </div>
  );
}
