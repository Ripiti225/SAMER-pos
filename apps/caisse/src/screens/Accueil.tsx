import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  IconArrowLeft,
  IconCashRegister,
  IconChartBar,
  IconCircleCheck,
  IconCirclePlus,
  IconHistory,
  IconLayoutGrid,
  IconLock,
  IconLogout,
  IconPrinter,
  IconReportMoney,
  IconSettings,
  IconToolsKitchen2,
  IconWifi,
} from '@tabler/icons-react';
import type { CommandeVue, TableVue } from '@pos/shared';
import { PARTENAIRES, PERMISSIONS_ADMIN } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { useNbAdditionsEnAttente } from '../components/BandeauAdditions';
import { PiluleSync } from '../components/SanteSync';
import { useCaisse } from '../stores/session';

function initiales(nom: string): string {
  return nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('');
}

/** Accueil caissier : exactement 4 boutons (§15), en grille bento. */
export function Accueil() {
  const { session, aller, poserSession, afficherToast } = useCaisse();
  const [choixType, setChoixType] = useState(false);
  const [choixTable, setChoixTable] = useState(false);
  const [choixLivraison, setChoixLivraison] = useState(false);
  const nbAdditions = useNbAdditionsEnAttente();
  const horloge = useHorloge();

  const perms = session?.permissions ?? [];
  const peutCommander = perms.includes('salle.commande');
  const peutTables = perms.includes('salle.commande') || perms.includes('salle.voir_toutes_tables');
  const peutMesVentes = perms.includes('caisse.encaisser') || perms.includes('rapports.x');
  const peutCloturer = perms.includes('caisse.cloturer');
  const estSuperviseur = !!session && (session.utilisateur.est_proprietaire || session.utilisateur.est_superviseur);
  const estAdmin = !!session && PERMISSIONS_ADMIN.some((p) => session.permissions.includes(p));
  const peutSequence = perms.includes('caisse.fermer_sequence');
  const prenom = session?.utilisateur.nom_complet.split(/\s+/)[0] ?? '';
  const roleLabel = session?.utilisateur.role_nom ?? session?.utilisateur.role ?? '';

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
    <div className="flex min-h-full flex-col bg-fond">
      {/* ---------- Barre de navigation ---------- */}
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-bordure bg-surface px-4 shadow-e1 sm:px-6">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-marque text-sur-marque">
            <IconToolsKitchen2 size={22} />
          </div>
          <span className="text-lg font-bold text-marque-fonce sm:text-xl">{session?.restaurant.nom}</span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <PiluleSync />
          {estSuperviseur && (
            <button type="button" className="btn-blanc hidden items-center gap-2 sm:flex" onClick={() => aller('supervision')}>
              <IconArrowLeft size={18} />
              Supervision
            </button>
          )}
          {peutSequence && (
            <button type="button" className="btn-blanc flex items-center gap-2" onClick={() => aller('sequence')}>
              <IconReportMoney size={18} />
              <span className="hidden sm:inline">Séquence</span>
            </button>
          )}
          {estAdmin && (
            <button type="button" className="btn-blanc flex items-center gap-2" onClick={() => aller('reglages')}>
              <IconSettings size={18} />
              <span className="hidden sm:inline">Réglages</span>
            </button>
          )}
          <div className="mx-1 hidden text-right sm:block">
            <div className="text-sm font-bold leading-tight text-fort">{session?.utilisateur.nom_complet}</div>
            <div className="text-[10px] uppercase tracking-wider text-doux">{roleLabel}</div>
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

      {/* ---------- Canvas ---------- */}
      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden p-6">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-marque/5 blur-3xl" />
          <div className="absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-marque-tint/40 blur-3xl" />
        </div>

        <div className="z-10 w-full max-w-5xl">
          <div className="mb-10 text-center">
            <h2 className="text-4xl font-bold tracking-tight text-fort sm:text-5xl">Bonjour, {prenom}</h2>
            <p className="mt-2 text-lg text-doux">Que souhaitez-vous faire ?</p>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {peutCommander && (
              <CarteAction
                variante="primaire"
                titre="Nouvelle commande"
                sousTitre="Sur place · à emporter · livraison"
                icone={<IconCashRegister size={34} />}
                filigrane={<IconCirclePlus size={140} />}
                onClick={() => setChoixType(true)}
              />
            )}
            {peutTables && (
              <CarteAction
                variante="claire"
                titre="Tables"
                sousTitre="Plan de salle & additions"
                icone={<IconLayoutGrid size={34} className="text-marque-fonce" />}
                filigrane={<IconLayoutGrid size={140} />}
                badge={nbAdditions > 0 ? nbAdditions : undefined}
                onClick={() => aller('tables')}
              />
            )}
            {peutMesVentes && (
              <CarteAction
                variante="claire"
                titre="Mes ventes"
                sousTitre="Rapports & suivi du service"
                icone={<IconHistory size={34} className="text-marque-fonce" />}
                filigrane={<IconChartBar size={140} />}
                onClick={() => aller('mes-ventes')}
              />
            )}
            {peutCloturer && (
              <CarteAction
                variante="sombre"
                titre="J’ai fini"
                sousTitre="Clôture & rapport Z"
                icone={<IconLock size={34} />}
                filigrane={<IconCircleCheck size={140} />}
                onClick={() => aller('cloture')}
              />
            )}
          </div>
        </div>
      </main>

      {/* ---------- Pied contextuel ---------- */}
      <footer className="flex h-14 items-center justify-between border-t border-bordure bg-surface-douce px-4 text-doux sm:px-6">
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-2 text-xs font-medium">
            <IconWifi size={16} /> Réseau local
          </span>
          <span className="hidden items-center gap-2 text-xs font-medium sm:flex">
            <IconPrinter size={16} /> Imprimante configurée dans Réglages
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-marque-fonce tabular-nums">{horloge.heure}</span>
          <span className="h-4 w-px bg-bordure" />
          <span className="text-xs font-medium capitalize">{horloge.date}</span>
        </div>
      </footer>

      {/* ---------- Modals (inchangés) ---------- */}
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

// ---------------------------------------------------------------------------
// Carte d'action bento (les 4 tuiles de l'accueil)
// ---------------------------------------------------------------------------
type Variante = 'primaire' | 'claire' | 'sombre';

function CarteAction({
  variante,
  titre,
  sousTitre,
  icone,
  filigrane,
  badge,
  onClick,
}: {
  variante: Variante;
  titre: string;
  sousTitre: string;
  icone: React.ReactNode;
  filigrane: React.ReactNode;
  badge?: number;
  onClick: () => void;
}) {
  const styles: Record<Variante, { carte: string; carreIcone: string; filigrane: string; sousTitre: string }> = {
    primaire: {
      carte: 'bg-marque text-sur-marque shadow-e2',
      carreIcone: 'bg-white/20 text-sur-marque',
      filigrane: 'text-white/20',
      sousTitre: 'text-white/85',
    },
    claire: {
      carte: 'bg-surface text-fort border border-bordure shadow-e1 hover:shadow-e2 hover:bg-surface-douce',
      carreIcone: 'bg-marque-tint text-marque-fonce',
      filigrane: 'text-marque/10',
      sousTitre: 'text-doux',
    },
    sombre: {
      carte: 'bg-fort text-fond shadow-e2 hover:opacity-95',
      carreIcone: 'bg-white/10 text-fond',
      filigrane: 'text-white/10',
      sousTitre: 'text-fond/60',
    },
  };
  const s = styles[variante];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative flex min-h-[200px] flex-col items-start justify-between overflow-hidden rounded-2xl p-7 text-left transition active:translate-y-px ${s.carte}`}
    >
      <div className={`pointer-events-none absolute -right-4 -top-4 transition-transform duration-300 group-hover:scale-110 ${s.filigrane}`}>
        {filigrane}
      </div>
      {badge !== undefined && (
        <span className="absolute right-5 top-5 flex min-h-[34px] min-w-[34px] items-center justify-center rounded-full bg-info px-2 text-base font-bold text-white shadow-e1">
          {badge}
        </span>
      )}
      <div className={`flex h-14 w-14 items-center justify-center rounded-[13px] ${s.carreIcone}`}>{icone}</div>
      <div className="relative">
        <h3 className="text-2xl font-bold">{titre}</h3>
        <p className={`mt-1 text-sm font-medium ${s.sousTitre}`}>{sousTitre}</p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Horloge live (pied de page)
// ---------------------------------------------------------------------------
function useHorloge() {
  const [maintenant, setMaintenant] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setMaintenant(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return {
    heure: maintenant.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    date: maintenant.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }),
  };
}
