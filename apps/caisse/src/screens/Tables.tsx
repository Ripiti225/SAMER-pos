import { useQuery } from '@tanstack/react-query';
import type { CommandeVue, TableVue } from '@pos/shared';
import { api } from '../api';
import { useCaisse } from '../stores/session';

/** Simple liste des tables par zone (sprint 1 — pas de plan graphique). */
export function Tables() {
  const { aller, afficherToast } = useCaisse();
  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    refetchInterval: 15000,
  });

  const zones = [...new Map((tables ?? []).map((t) => [t.zone_nom, true])).keys()];

  const ouvrirTable = async (t: TableVue) => {
    if (t.commande_id) {
      aller('commande', t.commande_id);
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

      {zones.map((zone) => (
        <section key={zone} className="mb-6">
          <h2 className="mb-2 font-semibold text-zinc-400">{zone}</h2>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {(tables ?? [])
              .filter((t) => t.zone_nom === zone)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`btn min-h-[72px] flex-col ${
                    t.statut === 'LIBRE' ? 'bg-zinc-800 hover:bg-zinc-700' : 'bg-accent text-zinc-950'
                  }`}
                  onClick={() => ouvrirTable(t)}
                >
                  <div className="text-lg font-bold">{t.numero}</div>
                  <div className="text-xs">{t.statut === 'LIBRE' ? 'Libre' : 'Occupée'}</div>
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
