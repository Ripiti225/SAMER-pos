import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CommandeVue, TableVue } from '@pos/shared';
import { PARTENAIRES } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { useNbAdditionsEnAttente } from '../components/BandeauAdditions';
import { PastilleSync } from '../components/SanteSync';
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
        <div className="ml-auto flex items-center gap-4">
          <PastilleSync />
          <button type="button" className="btn-blanc" onClick={seDeconnecter}>
            Se déconnecter
          </button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-3xl flex-1 grid-cols-1 content-center gap-5 sm:grid-cols-2">
        <button
          type="button"
          className="btn-accent flex-col items-start gap-1 rounded-[var(--rayon)] px-7 py-10 text-left"
          onClick={() => setChoixType(true)}
        >
          <span className="text-2xl font-black">Nouvelle commande</span>
          <span className="text-sm font-medium opacity-90">Sur place · à emporter · livraison</span>
        </button>
        <button
          type="button"
          className="carte relative flex flex-col items-start gap-1 px-7 py-10 text-left"
          onClick={() => aller('tables')}
        >
          <span className="text-2xl font-black">Tables</span>
          <span className="text-sm text-doux">Plan de salle & additions</span>
          {nbAdditions > 0 && (
            <span className="absolute right-4 top-4 flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full bg-info px-2 text-lg font-black text-white shadow-[var(--ombre-1)]">
              {nbAdditions}
            </span>
          )}
        </button>
        <button
          type="button"
          className="carte flex flex-col items-start gap-1 px-7 py-10 text-left"
          onClick={() => aller('mes-ventes')}
        >
          <span className="text-2xl font-black">Mes ventes</span>
          <span className="text-sm text-doux">Rapports & suivi du service</span>
        </button>
        <button
          type="button"
          className="btn-alerte flex-col items-start gap-1 rounded-[var(--rayon)] px-7 py-10 text-left"
          onClick={() => aller('cloture')}
        >
          <span className="text-2xl font-black">J’ai fini</span>
          <span className="text-sm font-medium opacity-90">Clôture & rapport Z</span>
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
