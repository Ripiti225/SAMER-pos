import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { CommandeVue, TableVue, UtilisateurPublic } from '@pos/shared';
import { PlanSalle } from '@pos/shared-ui';
import { api } from '../api';
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

  return (
    <div className="min-h-full p-6">
      <header className="mb-6 flex items-center gap-4">
        <button type="button" className="btn-blanc" onClick={() => aller('accueil')}>
          ← Accueil
        </button>
        <h1 className="text-2xl font-bold">Tables</h1>
      </header>

      <PlanSalle tables={tables ?? []} onTable={(t) => void ouvrirTable(t)} />

      {/* Transfert : uniquement pour les tables ayant un propriétaire */}
      <div className="mt-6 flex flex-wrap gap-2">
        {(tables ?? [])
          .filter((t) => t.ouverte_par)
          .map((t) => (
            <button key={t.id} type="button" className="btn-blanc text-sm" onClick={() => setTransfert(t)}>
              Transférer {t.numero} ({(t.ouverte_par_nom ?? '').split(' ')[0]})
            </button>
          ))}
      </div>

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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" onClick={onFermer}>
      <div className="carte w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-xl font-bold">Transférer la table {table.numero}</h2>
        <div className="space-y-2">
          {serveurs.map((s) => (
            <button key={s.id} type="button" className="btn-blanc w-full" onClick={() => void transferer(s.id)}>
              {s.nom_complet}
            </button>
          ))}
          {serveurs.length === 0 && <div className="text-doux">Aucun autre serveur disponible.</div>}
        </div>
      </div>
    </div>
  );
}
