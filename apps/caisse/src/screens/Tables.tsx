import { useQuery } from '@tanstack/react-query';
import type { CommandeVue, TableVue } from '@pos/shared';
import { PlanSalle } from '@pos/shared-ui';
import { api } from '../api';
import { useCaisse } from '../stores/session';

/**
 * Plan de salle par zones (sprint 2 §C) — composant commun avec l'app serveur.
 * Bleu = addition demandée par un serveur : ouvrir la table pour encaisser.
 */
export function Tables() {
  const { aller, afficherToast } = useCaisse();
  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    refetchInterval: 15000,
  });

  const ouvrirTable = async (t: TableVue) => {
    if (t.commande_id) {
      // Addition demandée → aller directement à l'encaissement
      aller(t.statut === 'ADDITION_DEMANDEE' ? 'paiement' : 'commande', t.commande_id);
      return;
    }
    if (t.partenaire) {
      afficherToast('Table virtuelle partenaire — passez par « Nouvelle commande » → Livraison');
      return;
    }
    try {
      const commande = await api<CommandeVue>('/api/commandes', {
        method: 'POST',
        corps: { type: 'SUR_PLACE', table_id: t.id },
      });
      aller('commande', commande.id);
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  return (
    <div className="min-h-full p-6">
      <header className="mb-6 flex items-center gap-4">
        <button type="button" className="btn-sombre" onClick={() => aller('accueil')}>
          ← Accueil
        </button>
        <h1 className="text-2xl font-bold">Tables</h1>
      </header>
      <PlanSalle tables={tables ?? []} onTable={(t) => void ouvrirTable(t)} />
    </div>
  );
}
