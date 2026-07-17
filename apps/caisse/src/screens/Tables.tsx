import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { IconArrowsExchange } from '@tabler/icons-react';
import type { CommandeVue, TableVue, UtilisateurPublic } from '@pos/shared';
import { PlanSalle } from '@pos/shared-ui';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { EnteteEcran } from '../components/EnteteEcran';
import { useCaisse } from '../stores/session';

/**
 * Plan de salle par zones (sprint 2 §C) — composant commun avec l'app serveur.
 * La caisse a accès à toutes les tables et peut transférer une table à un
 * autre serveur (CORRECTIONS3 point 3).
 */
export function Tables() {
  const { aller, afficherToast } = useCaisse();
  const [transfert, setTransfert] = useState<TableVue | null>(null);
  const { data: tables, refetch } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    refetchInterval: 15000,
  });

  const ouvrirTable = async (t: TableVue) => {
    if (t.commande_id) {
      aller(t.etat === 'ADDITION_DEMANDEE' ? 'paiement' : 'commande', t.commande_id);
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

  const transferables = (tables ?? []).filter((t) => t.ouverte_par);

  return (
    <div className="min-h-full bg-fond p-6">
      <EnteteEcran titre="Tables" onRetour={() => aller('accueil')} />

      <PlanSalle tables={tables ?? []} onTable={(t) => void ouvrirTable(t)} />

      {/* Transfert : uniquement pour les tables ayant un propriétaire */}
      {transferables.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-doux">Transférer une table</h2>
          <div className="flex flex-wrap gap-2">
            {transferables.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTransfert(t)}
                className="flex items-center gap-2 rounded-full border border-bordure bg-surface px-4 py-2 text-sm font-semibold shadow-e1 transition hover:border-marque hover:bg-marque-tint"
              >
                <IconArrowsExchange size={16} className="text-marque-fonce" />
                {t.numero} · {(t.ouverte_par_nom ?? '').split(' ')[0]}
              </button>
            ))}
          </div>
        </section>
      )}

      {transfert && (
        <ModaleTransfert
          table={transfert}
          onFait={() => {
            setTransfert(null);
            void refetch();
            afficherToast('Table transférée');
          }}
          onFermer={() => setTransfert(null)}
        />
      )}
    </div>
  );
}

function ModaleTransfert({
  table,
  onFait,
  onFermer,
}: {
  table: TableVue;
  onFait: () => void;
  onFermer: () => void;
}) {
  const { afficherToast } = useCaisse();
  const { data: gens } = useQuery({
    queryKey: ['utilisateurs-login'],
    queryFn: () => api<UtilisateurPublic[]>('/api/auth/utilisateurs'),
  });
  const serveurs = (gens ?? []).filter((u) => u.role === 'SERVEUR' && u.id !== table.ouverte_par);

  const transferer = async (serveurId: string) => {
    try {
      await api(`/api/caisse/tables/${table.id}/transferer`, { method: 'POST', corps: { serveur_id: serveurId } });
      onFait();
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  return (
    <Modale titre={`Transférer la table ${table.numero}`} onFermer={onFermer} enfants={
      <div className="space-y-2">
        <p className="text-sm text-doux">Vers quel serveur ?</p>
        {serveurs.map((s) => (
          <button
            key={s.id}
            type="button"
            className="carte w-full p-4 text-left font-semibold hover:border-marque"
            onClick={() => void transferer(s.id)}
          >
            {s.nom_complet}
          </button>
        ))}
        {serveurs.length === 0 && <div className="text-doux">Aucun autre serveur disponible.</div>}
      </div>
    } />
  );
}
