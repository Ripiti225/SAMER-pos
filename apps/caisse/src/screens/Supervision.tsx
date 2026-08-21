import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  IconArrowBackUp,
  IconCashRegister,
  IconClipboardList,
  IconLogout,
  IconMoon,
  IconPrinter,
  IconReportMoney,
  IconSettings,
  IconSun,
  IconToolsKitchen2,
  IconWifi,
} from '@tabler/icons-react';
import { formatFCFA, PERMISSIONS_ADMIN, type RetoursVue } from '@pos/shared';
import { Modale } from '../components/Modale';
import { PiluleSync } from '../components/SanteSync';
import { api } from '../api';
import { useAffichage } from '../stores/affichage';
import { useCaisse } from '../stores/session';

function initiales(nom: string): string {
  return nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('');
}

/**
 * Tableau de bord de supervision : écran d'accueil du propriétaire, du
 * superviseur et du gérant. Ils pilotent (rapports, réglages, séquence) et
 * peuvent BASCULER en mode caisse à la demande — l'ouverture d'un shift devient
 * un choix explicite au lieu d'un passage obligé (voir `ecranInitial`).
 *
 * Même langage visuel que l'accueil caissier (DESIGN_V2 § 6.2) : c'est un écran
 * « vitrine », il suit donc le mode clair/sombre du poste, porte le même entête
 * et les mêmes tuiles à vignette teintée. Avant, il gardait l'ancien thème et le
 * propriétaire changeait d'univers en passant d'un écran à l'autre.
 */
export function Supervision() {
  const { session, aller, poserSession } = useCaisse();
  const mode = useAffichage((e) => e.mode);
  const basculerMode = useAffichage((e) => e.basculerMode);
  const [confirmerCaisse, setConfirmerCaisse] = useState(false);
  const horloge = useHorloge();

  const peutRapports = !!session && session.permissions.includes('rapports.x');
  const peutReglages = !!session && PERMISSIONS_ADMIN.some((p) => session.permissions.includes(p));
  const peutSequence = !!session && session.permissions.includes('caisse.fermer_sequence');
  const prenom = session?.utilisateur.nom_complet.split(/\s+/)[0] ?? '';
  const roleLabel = session?.utilisateur.role_nom ?? session?.utilisateur.role ?? 'Superviseur';

  // Retours du jour (tous services) : même route que « Rapports du jour ».
  const { data: retours } = useQuery({
    queryKey: ['retours-jour'],
    queryFn: () => api<RetoursVue & { date: string }>('/api/rapports/retours-jour'),
    enabled: peutRapports,
  });

  const seDeconnecter = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    poserSession(null);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-fond">
      {/* ---------- Barre de navigation (identique à l'accueil caissier) ---------- */}
      <header className="z-40 flex h-16 flex-none items-center justify-between border-b border-bordure bg-surface px-4 shadow-e1 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-marque text-sur-marque">
            <IconToolsKitchen2 size={22} />
          </div>
          <span className="truncate text-lg font-bold text-marque-fonce sm:text-xl">{session?.restaurant.nom}</span>
        </div>

        <div className="flex min-w-0 items-center gap-2 overflow-x-auto sm:gap-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:flex-none">
          <PiluleSync />
          {/* Bascule clair/sombre : réglage du POSTE (§ 8), comme en caisse. */}
          <button
            type="button"
            className="btn-blanc flex items-center gap-2"
            onClick={basculerMode}
            title={mode === 'sombre' ? 'Passer en clair' : 'Passer en sombre'}
          >
            {mode === 'sombre' ? <IconSun size={18} /> : <IconMoon size={18} />}
            <span className="hidden xl:inline">{mode === 'sombre' ? 'Clair' : 'Sombre'}</span>
          </button>
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
            <span className="hidden xl:inline">Déconnexion</span>
          </button>
        </div>
      </header>

      {/* ---------- Canvas ---------- */}
      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-5 py-3">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-marque/5 blur-3xl" />
          <div className="absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-marque-tint/40 blur-3xl" />
        </div>

        <div className="z-10 flex w-full max-w-[1120px] flex-col items-center gap-4">
          <div className="text-center">
            <h2 className="text-[34px] font-bold leading-tight tracking-tight text-fort">Bonjour, {prenom}</h2>
            <p className="mt-1.5 text-base text-doux">Pilotez votre restaurant.</p>
          </div>

          {/* Retours du jour : plats lancés en cuisine puis annulés au PIN
              manager — ligne ou table entière. Ils ne pèsent sur rien, c'est
              justement pour ça qu'ils ont besoin d'être affichés quelque part. */}
          {peutRapports && retours && (
            <button
              type="button"
              onClick={() => aller('mes-ventes')}
              className={`flex w-full items-center justify-between gap-4 rounded-[18px] border px-5 py-3 text-left transition ${
                retours.nb > 0
                  ? 'border-attente/40 bg-attente-tint text-attente-txt hover:brightness-95'
                  : 'border-bordure bg-surface text-doux hover:bg-surface-douce'
              }`}
            >
              <span className="flex min-w-0 items-center gap-3">
                <IconArrowBackUp size={22} className="flex-none" />
                <span className="min-w-0">
                  <span className="block font-bold">
                    {retours.nb === 0
                      ? 'Aucun retour aujourd’hui'
                      : `${retours.nb} retour${retours.nb > 1 ? 's' : ''} aujourd’hui`}
                  </span>
                  <span className="block truncate text-xs">
                    {retours.nb === 0
                      ? 'Aucun plat lancé en cuisine n’a été annulé.'
                      : `${retours.par_produit
                          .slice(0, 3)
                          .map((p) => `${p.quantite} × ${p.nom}`)
                          .join(' · ')}${retours.par_produit.length > 3 ? '…' : ''}`}
                  </span>
                </span>
              </span>
              {retours.nb > 0 && (
                <span className="whitespace-nowrap text-lg font-black tabular-nums">{formatFCFA(retours.montant)}</span>
              )}
            </button>
          )}

          {/* Trois colonnes comme l'accueil caissier : mêmes tuiles, mêmes
              teintes par fonction — « Mes ventes » est violet des deux côtés. */}
          <div className="grid w-full grid-cols-3 gap-3.5">
            {peutRapports && (
              <CarteAction
                couleur="#8b5cf6"
                titre="Rapports du jour"
                sousTitre="Ventes, top plats, ventes par heure"
                icone={<IconClipboardList size={28} />}
                onClick={() => aller('mes-ventes')}
              />
            )}
            {peutSequence && (
              <CarteAction
                couleur="#d97706"
                titre="Fermeture de séquence"
                sousTitre="Total du jour, détail par caissier, rasage"
                icone={<IconReportMoney size={28} />}
                onClick={() => aller('sequence')}
              />
            )}
            {peutReglages && (
              <CarteAction
                couleur="#64748b"
                titre="Réglages"
                sousTitre="Rôles & accès, équipe, salle, restaurant"
                icone={<IconSettings size={28} />}
                onClick={() => aller('reglages')}
              />
            )}
            <CarteAction
              principale
              titre="Basculer en mode caisse"
              sousTitre="Prendre la caisse et encaisser"
              icone={<IconCashRegister size={28} />}
              onClick={() => setConfirmerCaisse(true)}
            />
          </div>
        </div>
      </main>

      {/* ---------- Pied contextuel (identique à l'accueil caissier) ---------- */}
      <footer className="flex h-14 flex-none items-center justify-between border-t border-bordure bg-surface-douce px-4 text-doux sm:px-6">
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

/**
 * Tuile de supervision — même composant visuel que l'accueil caissier : la
 * teinte vient de `couleur`, saturée sur fond clair, éclaircie sur fond sombre
 * (sinon elle disparaît), d'où le `color-mix` en style inline.
 */
function CarteAction({
  principale = false,
  couleur,
  titre,
  sousTitre,
  icone,
  onClick,
}: {
  principale?: boolean;
  couleur?: string;
  titre: string;
  sousTitre: string;
  icone: React.ReactNode;
  onClick: () => void;
}) {
  const sombre = useAffichage((e) => e.mode) === 'sombre';
  const teinte = couleur ?? 'var(--marque)';
  const styleVignette = principale
    ? { background: 'rgba(255,255,255,.22)', color: 'var(--sur-marque)' }
    : {
        background: `color-mix(in srgb, ${teinte} ${sombre ? '22%' : '15%'}, var(--vitrine-surface))`,
        color: sombre ? `color-mix(in srgb, ${teinte} 55%, #ffffff)` : teinte,
      };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex items-center gap-3.5 overflow-hidden rounded-[18px] p-5 text-left shadow-e1 transition duration-150 active:translate-y-0 ${
        principale
          ? 'border border-transparent bg-marque text-sur-marque hover:brightness-105'
          : 'border border-vitrine-bordure bg-vitrine-surface text-vitrine-txt hover:-translate-y-0.5 hover:border-filet-fort hover:bg-vitrine-surface-2 hover:shadow-e2'
      }`}
    >
      <span className="flex h-14 w-14 flex-none items-center justify-center rounded-[15px]" style={styleVignette}>
        {icone}
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-bold leading-tight tracking-tight">{titre}</span>
        <span className={`mt-1 block text-[12.5px] font-medium leading-snug ${principale ? 'text-sur-marque/70' : 'text-vitrine-txt-doux'}`}>
          {sousTitre}
        </span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Horloge live (pied de page) — même comportement que l'accueil caissier.
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
