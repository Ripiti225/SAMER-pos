import { useState } from 'react';
import {
  IconCashRegister,
  IconClipboardList,
  IconLogout,
  IconReportMoney,
  IconSettings,
  IconToolsKitchen2,
} from '@tabler/icons-react';
import { PERMISSIONS_ADMIN } from '@pos/shared';
import { Modale } from '../components/Modale';
import { PiluleSync } from '../components/SanteSync';
import { api } from '../api';
import { useCaisse } from '../stores/session';

function initiales(nom: string): string {
  return nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('');
}

/**
 * Tableau de bord de supervision : écran d'accueil du propriétaire et du
 * superviseur. Ils pilotent (rapports, réglages, séquence) et peuvent
 * BASCULER en mode caisse à la demande.
 */
export function Supervision() {
  const { session, aller, poserSession } = useCaisse();
  const [confirmerCaisse, setConfirmerCaisse] = useState(false);

  const peutRapports = !!session && session.permissions.includes('rapports.x');
  const peutReglages = !!session && PERMISSIONS_ADMIN.some((p) => session.permissions.includes(p));
  const peutSequence = !!session && session.permissions.includes('caisse.fermer_sequence');
  const prenom = session?.utilisateur.nom_complet.split(/\s+/)[0] ?? '';

  const seDeconnecter = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    poserSession(null);
  };

  return (
    <div className="flex min-h-full flex-col bg-fond">
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-bordure bg-surface px-4 shadow-e1 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-marque text-sur-marque">
            <IconToolsKitchen2 size={22} />
          </div>
          <span className="text-lg font-bold text-marque-fonce sm:text-xl">{session?.restaurant.nom}</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <PiluleSync />
          <div className="mx-1 hidden text-right sm:block">
            <div className="text-sm font-bold leading-tight text-fort">{session?.utilisateur.nom_complet}</div>
            <div className="text-[10px] uppercase tracking-wider text-doux">
              {session?.utilisateur.est_proprietaire ? 'Propriétaire' : 'Superviseur'}
            </div>
          </div>
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-marque-tint text-sm font-bold text-marque-fonce">
            {initiales(session?.utilisateur.nom_complet ?? '')}
          </div>
          <button
            type="button"
            onClick={seDeconnecter}
            className="flex items-center gap-2 rounded-[13px] bg-alerte/10 px-3 py-2 font-semibold text-alerte transition hover:bg-alerte/20 sm:px-4"
          >
            <IconLogout size={18} />
            <span className="hidden md:inline">Déconnexion</span>
          </button>
        </div>
      </header>

      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden p-6">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-marque/5 blur-3xl" />
          <div className="absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-marque-tint/40 blur-3xl" />
        </div>

        <div className="z-10 w-full max-w-4xl">
          <div className="mb-10 text-center">
            <h2 className="text-4xl font-bold tracking-tight text-fort sm:text-5xl">Bonjour, {prenom}</h2>
            <p className="mt-2 text-lg text-doux">Pilotez votre restaurant.</p>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {peutRapports && (
              <CarteSupervision
                titre="Rapports du jour"
                sousTitre="Ventes, top plats, ventes par heure"
                icone={<IconClipboardList size={30} className="text-marque-fonce" />}
                onClick={() => aller('mes-ventes')}
              />
            )}
            {peutSequence && (
              <CarteSupervision
                titre="Fermeture de séquence"
                sousTitre="Total du jour, détail par caissier, rasage"
                icone={<IconReportMoney size={30} className="text-marque-fonce" />}
                onClick={() => aller('sequence')}
              />
            )}
            {peutReglages && (
              <CarteSupervision
                titre="Réglages"
                sousTitre="Rôles & accès, équipe, salle, restaurant, audit"
                icone={<IconSettings size={30} className="text-marque-fonce" />}
                onClick={() => aller('reglages')}
              />
            )}
            <button
              type="button"
              onClick={() => setConfirmerCaisse(true)}
              className="group flex min-h-[130px] flex-col items-start justify-between overflow-hidden rounded-2xl bg-marque p-6 text-left text-sur-marque shadow-e2 transition active:translate-y-px"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-[13px] bg-white/20">
                <IconCashRegister size={26} />
              </div>
              <div>
                <h3 className="text-xl font-bold">Basculer en mode caisse</h3>
                <p className="mt-1 text-sm font-medium text-white/85">Prendre la caisse et encaisser</p>
              </div>
            </button>
          </div>
        </div>
      </main>

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

function CarteSupervision({ titre, sousTitre, icone, onClick }: { titre: string; sousTitre: string; icone: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[130px] flex-col items-start justify-between rounded-2xl border border-bordure bg-surface p-6 text-left shadow-e1 transition hover:bg-surface-douce hover:shadow-e2"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-[13px] bg-marque-tint">{icone}</div>
      <div>
        <h3 className="text-xl font-bold text-fort">{titre}</h3>
        <p className="mt-1 text-sm text-doux">{sousTitre}</p>
      </div>
    </button>
  );
}
