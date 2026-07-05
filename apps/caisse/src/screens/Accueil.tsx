import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CommandeVue, TableVue } from '@pos/shared';
import { PARTENAIRES } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { useNbAdditionsEnAttente } from '../components/BandeauAdditions';
import { useCaisse } from '../stores/session';

/** Accueil caissier : exactement 4 boutons (§15). */
export function Accueil() {
  const { session, aller, poserSession, afficherToast } = useCaisse();
  const [choixType, setChoixType] = useState(false);
  const [choixTable, setChoixTable] = useState(false);
  const [choixLivraison, setChoixLivraison] = useState(false);
  // Correction 2 : compteur d'additions en attente, visible en permanence
  const nbAdditions = useNbAdditionsEnAttente();

  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    enabled: choixTable,
  });

  const creerCommande = async (corps: Record<string, unknown>) => {
    try {
      const commande = await api<CommandeVue>('/api/commandes', { method: 'POST', corps });
      setChoixType(false);
      setChoixTable(false);
      setChoixLivraison(false);
      aller('commande', commande.id);
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  const seDeconnecter = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    poserSession(null);
  };

  return (
    <div className="flex min-h-full flex-col p-6">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <div className="text-2xl font-black text-marque-fonce">{session?.restaurant.nom}</div>
          <div className="text-sm text-doux">{session?.utilisateur.nom_complet}</div>
        </div>
        <button type="button" className="btn-blanc" onClick={seDeconnecter}>
          Se déconnecter
        </button>
      </header>

      <div className="grid flex-1 grid-cols-1 content-center gap-4 sm:grid-cols-2 max-w-3xl mx-auto w-full">
        <button type="button" className="btn-accent py-12 text-2xl" onClick={() => setChoixType(true)}>
          Nouvelle commande
        </button>
        <button type="button" className="btn-blanc relative py-12 text-2xl" onClick={() => aller('tables')}>
          Tables
          {nbAdditions > 0 && (
            <span className="absolute right-4 top-4 flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full bg-info px-2 text-lg font-black text-white">
              {nbAdditions}
            </span>
          )}
        </button>
        <button type="button" className="btn-blanc py-12 text-2xl" onClick={() => aller('mes-ventes')}>
          Mes ventes
        </button>
        <button type="button" className="btn-alerte py-12 text-2xl" onClick={() => aller('cloture')}>
          J’ai fini
        </button>
      </div>

      {choixType && (
        <Modale titre="Type de commande" onFermer={() => setChoixType(false)} enfants={
          <div className="grid gap-3">
            <button type="button" className="btn-accent py-6 text-xl" onClick={() => { setChoixType(false); setChoixTable(true); }}>
              Sur place
            </button>
            <button type="button" className="btn-blanc py-6 text-xl" onClick={() => creerCommande({ type: 'EMPORTER' })}>
              À emporter
            </button>
            <button type="button" className="btn-blanc py-6 text-xl" onClick={() => { setChoixType(false); setChoixLivraison(true); }}>
              Livraison
            </button>
          </div>
        } />
      )}

      {choixTable && (
        <Modale titre="Choisir une table" large onFermer={() => setChoixTable(false)} enfants={
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {(tables ?? [])
              .filter((t) => !t.partenaire)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={t.statut !== 'LIBRE'}
                  className={`btn min-h-[64px] ${t.statut === 'LIBRE' ? 'border border-bordure bg-surface hover:bg-marque-tint' : 'bg-surface text-doux'}`}
                  onClick={() => creerCommande({ type: 'SUR_PLACE', table_id: t.id })}
                >
                  <div className="font-bold">{t.numero}</div>
                  <div className="text-xs text-doux">{t.zone_nom}</div>
                </button>
              ))}
          </div>
        } />
      )}

      {choixLivraison && (
        <Modale titre="Partenaire de livraison" onFermer={() => setChoixLivraison(false)} enfants={
          <div className="grid gap-3">
            {PARTENAIRES.map((p) => (
              <button key={p} type="button" className="btn-blanc py-5 text-lg" onClick={() => creerCommande({ type: 'LIVRAISON', partenaire: p })}>
                {p.replace('_', ' ')}
              </button>
            ))}
          </div>
        } />
      )}
    </div>
  );
}
