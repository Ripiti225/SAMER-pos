import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ServiceOuvertVue } from '@pos/shared';
import { formatFCFA, LIBELLES_POSTES, POSTES_JOUR } from '@pos/shared';
import { api } from '../api';
import { Numpad } from '../components/Numpad';
import { useCaisse } from '../stores/session';

interface MembrePropose {
  utilisateur_id: string;
  nom_complet: string;
  poste_defaut: string;
}

/** Ouverture de service : fond de caisse, puis équipe du jour (allègement). */
export function OuvertureService() {
  const { session, poserServiceOuvert, poserSession, afficherToast, rentrer } = useCaisse();
  const estSuperviseur = !!session && (session.utilisateur.est_proprietaire || session.utilisateur.est_superviseur);
  const [etape, setEtape] = useState<'fond' | 'equipe'>('fond');
  const [montant, setMontant] = useState('');
  const [enCours, setEnCours] = useState(false);
  // Map utilisateur_id → poste du jour (présent = présent dans la map).
  const [equipe, setEquipe] = useState<Record<string, string>>({});

  const { data: proposes } = useQuery({
    queryKey: ['equipe-proposee'],
    queryFn: () => api<MembrePropose[]>('/api/services/equipe-proposee'),
    enabled: etape === 'equipe',
  });

  const basculer = (m: MembrePropose) => {
    setEquipe((e) => {
      const copie = { ...e };
      if (copie[m.utilisateur_id]) delete copie[m.utilisateur_id];
      else copie[m.utilisateur_id] = m.poste_defaut;
      return copie;
    });
  };

  const ouvrir = async () => {
    setEnCours(true);
    try {
      const service = await api<ServiceOuvertVue>('/api/services/ouvrir', {
        method: 'POST',
        corps: {
          fond_de_caisse: Number(montant || '0'),
          equipe: Object.entries(equipe).map(([utilisateur_id, poste_jour]) => ({ utilisateur_id, poste_jour })),
        },
      });
      poserServiceOuvert(service);
    } catch (e) {
      afficherToast((e as Error).message);
    } finally {
      setEnCours(false);
    }
  };

  const seDeconnecter = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    poserSession(null);
  };

  if (etape === 'fond') {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-6 p-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold">Ouverture de service</h1>
          <p className="mt-1 text-doux">
            {session?.utilisateur.nom_complet} — comptez le fond de caisse et saisissez le montant
          </p>
        </div>
        <div className="w-full max-w-xs space-y-3">
          <div className="champ flex items-center justify-center text-3xl font-bold">
            {montant ? formatFCFA(Number(montant)) : <span className="text-base font-normal text-doux">Fond de caisse…</span>}
          </div>
          <Numpad
            valeur={montant}
            onChange={setMontant}
            onValider={() => setEtape('equipe')}
            libelleValider="Continuer"
            validerDesactive={montant === ''}
          />
          {estSuperviseur ? (
            <button type="button" className="btn-blanc w-full" onClick={rentrer}>
              ← Retour à la supervision
            </button>
          ) : (
            <button type="button" className="btn-blanc w-full" onClick={seDeconnecter}>
              Se déconnecter
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col p-6">
      <div className="mb-4 text-center">
        <h1 className="text-3xl font-bold">Équipe du jour</h1>
        <p className="mt-1 text-doux">Cochez les personnes présentes et ajustez leur poste du jour</p>
      </div>
      <div className="mx-auto grid w-full max-w-2xl gap-2">
        {(proposes ?? []).map((m) => {
          const present = m.utilisateur_id in equipe;
          return (
            <div key={m.utilisateur_id} className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${present ? 'border-marque bg-marque-tint' : 'border-bordure'}`}>
              <button type="button" className="flex flex-1 items-center gap-3 text-left" onClick={() => basculer(m)}>
                <span className={`flex h-6 w-6 items-center justify-center rounded-md border ${present ? 'bg-marque text-white' : 'border-bordure'}`}>{present ? '✓' : ''}</span>
                <span className="font-semibold">{m.nom_complet}</span>
              </button>
              {present && (
                <select
                  className="champ w-44"
                  value={equipe[m.utilisateur_id]}
                  onChange={(ev) => setEquipe((e) => ({ ...e, [m.utilisateur_id]: ev.target.value }))}
                >
                  {POSTES_JOUR.map((p) => <option key={p} value={p}>{LIBELLES_POSTES[p]}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
      <div className="mx-auto mt-6 flex w-full max-w-2xl gap-3">
        <button type="button" className="btn-blanc" onClick={() => setEtape('fond')}>Retour</button>
        <button type="button" className="btn-accent flex-1" onClick={ouvrir} disabled={enCours}>
          {enCours ? 'Ouverture…' : `Ouvrir le service (${Object.keys(equipe).length} présent(s))`}
        </button>
      </div>
    </div>
  );
}
