import { IconCashRegister, IconClipboardList, IconSettings } from '@tabler/icons-react';
import { PERMISSIONS_ADMIN } from '@pos/shared';
import { Modale } from '../components/Modale';
import { PiluleSync } from '../components/SanteSync';
import { api } from '../api';
import { useCaisse } from '../stores/session';
import { useState } from 'react';

/**
 * Tableau de bord de supervision : écran d'accueil du propriétaire et du
 * superviseur (ce ne sont pas des caissiers). Ils pilotent (rapports, réglages)
 * et peuvent BASCULER en mode caisse à la demande — décision produit « accès
 * caisse optionnel ».
 */
export function Supervision() {
  const { session, aller, poserSession } = useCaisse();
  const [confirmerCaisse, setConfirmerCaisse] = useState(false);

  const peutRapports = !!session && session.permissions.includes('rapports.x');
  const peutReglages = !!session && PERMISSIONS_ADMIN.some((p) => session.permissions.includes(p));

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
          <div className="text-sm text-doux">
            {session?.utilisateur.nom_complet} · {session?.utilisateur.est_proprietaire ? 'Propriétaire' : 'Superviseur'}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-4">
          <PiluleSync />
          <button type="button" className="btn-blanc" onClick={seDeconnecter}>
            Se déconnecter
          </button>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-3xl flex-1 grid-cols-1 content-center gap-5 sm:grid-cols-2">
        {peutRapports && (
          <button
            type="button"
            className="carte flex flex-col items-start gap-1 px-7 py-10 text-left"
            onClick={() => aller('mes-ventes')}
          >
            <IconClipboardList size={26} className="text-marque-fonce" />
            <span className="text-2xl font-black">Rapports du jour</span>
            <span className="text-sm text-doux">Ventes, top plats, ventes par heure</span>
          </button>
        )}
        {peutReglages && (
          <button
            type="button"
            className="carte flex flex-col items-start gap-1 px-7 py-10 text-left"
            onClick={() => aller('reglages')}
          >
            <IconSettings size={26} className="text-marque-fonce" />
            <span className="text-2xl font-black">Réglages</span>
            <span className="text-sm text-doux">Rôles &amp; accès, équipe, salle, journal d’audit</span>
          </button>
        )}
        <button
          type="button"
          className="btn-accent flex-col items-start gap-1 rounded-[var(--rayon)] px-7 py-10 text-left"
          onClick={() => setConfirmerCaisse(true)}
        >
          <IconCashRegister size={26} />
          <span className="text-2xl font-black">Basculer en mode caisse</span>
          <span className="text-sm font-medium opacity-90">Prendre la caisse et encaisser</span>
        </button>
      </div>

      {confirmerCaisse && (
        <Modale titre="Passer en mode caisse ?" onFermer={() => setConfirmerCaisse(false)} enfants={
          <div className="grid gap-3">
            <p className="text-doux">
              Vous allez utiliser la caisse comme un caissier (ouverture de service, prise de commande, encaissement).
            </p>
            <button type="button" className="btn-accent py-5 text-lg" onClick={() => { setConfirmerCaisse(false); aller('accueil'); }}>
              Continuer vers la caisse
            </button>
            <button type="button" className="btn-blanc py-5 text-lg" onClick={() => setConfirmerCaisse(false)}>
              Annuler
            </button>
          </div>
        } />
      )}
    </div>
  );
}
