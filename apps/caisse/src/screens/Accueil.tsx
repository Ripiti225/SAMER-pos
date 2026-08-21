import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  IconArrowLeft,
  IconBox,
  IconCashBanknote,
  IconCashRegister,
  IconChartBar,
  IconLayoutGrid,
  IconLock,
  IconLogout,
  IconMoon,
  IconPrinter,
  IconQrcode,
  IconReportMoney,
  IconSettings,
  IconSun,
  IconToolsKitchen2,
  IconWifi,
} from '@tabler/icons-react';
import type { CommandeEnCoursVue, CommandeVue, TableVue } from '@pos/shared';
import {
  formatFCFA,
  libellePartenaire,
  LIBELLES_STATUTS_COMMANDE,
  PARTENAIRES,
  PERMISSIONS_ADMIN,
} from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { useNbAdditionsEnAttente } from '../components/BandeauAdditions';
import { BandeauEquipe, initiales } from '../components/BandeauEquipe';
import { PiluleSync } from '../components/SanteSync';
import { useAffichage } from '../stores/affichage';
import { useCaisse } from '../stores/session';

/** État léger de l'inventaire — sert la pastille, ne crée aucun inventaire. */
interface EtatInventaire {
  commence: boolean;
  valide: boolean;
  debloque: boolean;
  restants_a_compter: number | null;
}

/**
 * Accueil caissier — **6 tuiles** depuis DESIGN_V2 § 6.2 : Dépenses et
 * Inventaire rejoignent Nouvelle commande, Tables, Mes ventes et J'ai fini.
 * Entorse au §15 du cahier des charges (qui en impose 4), tranchée par le boss
 * le 2026-08-15 : ce sont deux gestes quotidiens, les enfouir dans un sous-menu
 * les ferait oublier — et sans inventaire, plus de clôture possible.
 */
export function Accueil() {
  const { session, aller, poserSession, afficherToast } = useCaisse();
  const mode = useAffichage((e) => e.mode);
  const basculerMode = useAffichage((e) => e.basculerMode);
  const [choixType, setChoixType] = useState(false);
  const [choixTable, setChoixTable] = useState(false);
  const [choixLivraison, setChoixLivraison] = useState(false);
  const [choixEmporter, setChoixEmporter] = useState(false);
  const [appareils, setAppareils] = useState(false);
  const nbAdditions = useNbAdditionsEnAttente();
  const horloge = useHorloge();

  const perms = session?.permissions ?? [];
  const peutCommander = perms.includes('salle.commande');
  const peutTables = perms.includes('salle.commande') || perms.includes('salle.voir_toutes_tables');
  const peutMesVentes = perms.includes('caisse.encaisser') || perms.includes('rapports.x');
  const peutCloturer = perms.includes('caisse.cloturer');
  // Dépenses et Inventaire suivent le tiroir : même garde que côté serveur.
  const tientLaCaisse = perms.includes('caisse.service.ouvrir');
  const serviceOuvert = !!session?.service_ouvert;
  const estSuperviseur = !!session && (session.utilisateur.est_proprietaire || session.utilisateur.est_superviseur);
  const estAdmin = !!session && PERMISSIONS_ADMIN.some((p) => session.permissions.includes(p));
  const peutSequence = perms.includes('caisse.fermer_sequence');
  const prenom = session?.utilisateur.nom_complet.split(/\s+/)[0] ?? '';
  const roleLabel = session?.utilisateur.role_nom ?? session?.utilisateur.role ?? '';

  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    // Aussi pour le choix du partenaire : la commande de livraison doit être
    // rattachée à SA table virtuelle, sinon celle-ci reste affichée « Libre »
    // au plan de salle et on ne peut plus y revenir pour ajouter un produit.
    enabled: choixTable || choixLivraison,
  });

  /**
   * Commandes à emporter en cours. Elles n'occupent aucune table : une fois
   * l'écran de saisie quitté, elles n'étaient visibles nulle part et le
   * caissier les retapait en croyant les avoir oubliées (signalé le
   * 2026-08-18). On les remonte ici — au moment EXACT où il ouvrirait un
   * doublon — et sur le plan de salle, pseudo-zone « À emporter ».
   */
  const { data: enCours } = useQuery({
    queryKey: ['commandes-ouvertes'],
    queryFn: () => api<CommandeEnCoursVue[]>('/api/commandes/ouvertes'),
    enabled: !!session && peutCommander,
    refetchInterval: 20000,
  });
  const emporter = (enCours ?? []).filter((c) => c.type === 'EMPORTER' && c.nb_items > 0);

  // Pastilles des deux nouvelles tuiles : nombre de sorties de caisse du
  // service, et alerte tant que l'inventaire n'est pas validé.
  const { data: depenses } = useQuery({
    queryKey: ['depenses-total'],
    queryFn: () => api<{ total: number; nb_lignes: number }>('/api/depenses/total'),
    enabled: tientLaCaisse && serviceOuvert,
  });
  const { data: inventaire } = useQuery({
    queryKey: ['inventaire-etat'],
    queryFn: () => api<EtatInventaire>('/api/inventaire/etat'),
    enabled: tientLaCaisse && serviceOuvert,
  });

  const creerCommande = async (corps: Record<string, unknown>) => {
    try {
      const commande = await api<CommandeVue>('/api/commandes', { method: 'POST', corps });
      setChoixType(false);
      setChoixTable(false);
      setChoixLivraison(false);
      setChoixEmporter(false);
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
    // `h-full` et non `min-h-full` : la page fait EXACTEMENT la hauteur de
    // l'écran, donc l'entête et le pied restent toujours en place. Avec
    // `min-h-full`, un bandeau d'équipe déplié faisait grandir la page et
    // poussait le pied hors de l'écran — c'était ça, le vrai défilement.
    <div className="flex h-full flex-col overflow-hidden bg-fond">
      {/* ---------- Barre de navigation ---------- */}
      <header className="z-40 flex h-16 flex-none items-center justify-between border-b border-bordure bg-surface px-4 shadow-e1 sm:px-6">
        {/* `min-w-0` + `truncate` : sans eux, un nom de restaurant long pousse
            la barre d'actions hors de l'écran et fait défiler la page
            horizontalement — les boutons ne se compriment pas d'eux-mêmes. */}
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-marque text-sur-marque">
            <IconToolsKitchen2 size={22} />
          </div>
          <span className="truncate text-lg font-bold text-marque-fonce sm:text-xl">{session?.restaurant.nom}</span>
        </div>

        {/* `[&>*]:flex-none` : dans une barre qui défile, les boutons gardent
            leur largeur — sinon ils se compriment et les libellés se coupent. */}
        {/* La barre défile horizontalement si les boutons ne tiennent pas, mais
            SANS ascenseur visible : une barre grise sous l'entête donnait
            l'impression que la page entière défilait. */}
        <div className="flex min-w-0 items-center gap-2 overflow-x-auto sm:gap-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:flex-none">
          <PiluleSync />
          {estSuperviseur && (
            <button type="button" className="btn-blanc hidden items-center gap-2 sm:flex" onClick={() => aller('supervision')} title="Supervision">
              <IconArrowLeft size={18} />
              <span className="hidden xl:inline">Supervision</span>
            </button>
          )}
          {peutSequence && (
            <button type="button" className="btn-blanc flex items-center gap-2" onClick={() => aller('sequence')}>
              <IconReportMoney size={18} />
              <span className="hidden xl:inline">Séquence</span>
            </button>
          )}
          {/* Bascule clair/sombre : réglage du POSTE (§ 8), pas du compte —
              deux caissiers qui se succèdent retrouvent le même écran. */}
          <button
            type="button"
            className="btn-blanc flex items-center gap-2"
            onClick={basculerMode}
            title={mode === 'sombre' ? 'Passer en clair' : 'Passer en sombre'}
          >
            {mode === 'sombre' ? <IconSun size={18} /> : <IconMoon size={18} />}
            <span className="hidden xl:inline">{mode === 'sombre' ? 'Clair' : 'Sombre'}</span>
          </button>
          <button type="button" className="btn-blanc flex items-center gap-2" onClick={() => setAppareils(true)} title="Connexion des appareils (QR)">
            <IconQrcode size={18} />
            <span className="hidden xl:inline">Appareils</span>
          </button>
          {estAdmin && (
            <button type="button" className="btn-blanc flex items-center gap-2" onClick={() => aller('reglages')}>
              <IconSettings size={18} />
              <span className="hidden xl:inline">Réglages</span>
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
            <span className="hidden xl:inline">Déconnexion</span>
          </button>
        </div>
      </header>

      {/* ---------- Canvas ---------- */}
      {/* TOUT tient sur une page, sans défilement : le bandeau d'équipe, le
          bonjour et les six tuiles. C'est la promesse de l'accueil — on ne fait
          pas descendre un caissier pour atteindre « J'ai fini ». Vérifié à
          1024×768, bandeau déplié compris.
          `overflow-y-auto` comme la maquette, et non `hidden` : si un jour
          l'écran est plus court, mieux vaut un défilement qu'un « J'ai fini »
          purement invisible. Par construction il ne se déclenche pas. */}
      <main className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-5 py-3">
        {/* `overflow-hidden` ICI, sur le calque décoratif : ces deux cercles de
            384 px débordent volontairement du cadre, et comme `main` est une
            zone défilante ils étiraient sa surface de défilement — d'où des
            ascenseurs sur un accueil qui, lui, tenait très bien dans l'écran. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-marque/5 blur-3xl" />
          <div className="absolute -bottom-24 -left-24 h-96 w-96 rounded-full bg-marque-tint/40 blur-3xl" />
        </div>

        <div className="z-10 flex w-full max-w-[1120px] flex-col items-center gap-4">
          {serviceOuvert && <BandeauEquipe />}

          <div className="text-center">
            <h2 className="text-[34px] font-bold leading-tight tracking-tight text-fort">Bonjour, {prenom}</h2>
            <p className="mt-1.5 text-base text-doux">
              {session?.service_ouvert
                ? `Service ouvert depuis ${heureCourte(session.service_ouvert.ouvert_le)} · fond de caisse ${session.service_ouvert.fond_de_caisse.toLocaleString('fr-FR')} F`
                : 'Que souhaitez-vous faire ?'}
            </p>
          </div>

          {/* Trois colonnes TOUJOURS, comme la maquette : en deux colonnes les
              six tuiles font trois rangées et débordent de l'écran. */}
          <div className="grid w-full grid-cols-3 gap-3.5">
            {peutCommander && (
              <CarteAction
                principale
                titre="Nouvelle commande"
                sousTitre="Sur place · à emporter · livraison"
                icone={<IconCashRegister size={28} />}
                onClick={() => setChoixType(true)}
              />
            )}
            {peutTables && (
              <CarteAction
                couleur="#3b82f6"
                titre="Tables"
                // Les commandes à emporter vivent maintenant dans le plan de
                // salle (pseudo-zone) : la tuile le dit, sinon personne n'irait
                // les y chercher.
                sousTitre={
                  emporter.length > 0
                    ? `Plan de salle · ${emporter.length} à emporter`
                    : 'Plan de salle & additions'
                }
                icone={<IconLayoutGrid size={28} />}
                badge={nbAdditions > 0 ? String(nbAdditions) : undefined}
                onClick={() => aller('tables')}
              />
            )}
            {peutMesVentes && (
              <CarteAction
                couleur="#8b5cf6"
                titre="Mes ventes"
                sousTitre="Rapports & suivi du service"
                icone={<IconChartBar size={28} />}
                onClick={() => aller('mes-ventes')}
              />
            )}
            {tientLaCaisse && (
              <CarteAction
                couleur="#e2445c"
                titre="Dépenses"
                sousTitre="Sorties de caisse & salaires"
                icone={<IconCashBanknote size={28} />}
                badge={depenses && depenses.nb_lignes > 0 ? String(depenses.nb_lignes) : undefined}
                badgeCouleur="#e2445c"
                onClick={() => aller('depenses')}
              />
            )}
            {tientLaCaisse && (
              <CarteAction
                couleur="#14b8a6"
                titre="Inventaire"
                sousTitre="Comptage obligatoire avant clôture"
                icone={<IconBox size={28} />}
                // Tant qu'il n'est pas validé, la clôture est bloquée : la
                // pastille prévient AVANT que le caissier ne s'y heurte.
                badge={inventaire && !inventaire.valide ? '!' : undefined}
                badgeCouleur="#d97706"
                onClick={() => aller('inventaire')}
              />
            )}
            {peutCloturer && (
              <CarteAction
                couleur="#d97706"
                titre="J’ai fini"
                sousTitre="Comptage à l’aveugle & rapport Z"
                icone={<IconLock size={28} />}
                onClick={() => aller('cloture')}
              />
            )}
          </div>
        </div>
      </main>

      {/* ---------- Pied contextuel ---------- */}
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

      {/* ---------- Modals (inchangés) ---------- */}
      {choixType && (
        <Modale titre="Type de commande" onFermer={() => setChoixType(false)} enfants={
          <div className="grid gap-3">
            <button type="button" className="btn-accent py-6 text-xl" onClick={() => { setChoixType(false); setChoixTable(true); }}>
              Sur place
            </button>
            {/* Des commandes à emporter tournent déjà : on les MONTRE avant
                d'en ouvrir une nouvelle. C'est ici que naissaient les doublons
                — le caissier ne les voyait nulle part et retapait tout. */}
            <button
              type="button"
              className="btn-blanc py-6 text-xl"
              onClick={() => {
                if (emporter.length > 0) {
                  setChoixType(false);
                  setChoixEmporter(true);
                } else {
                  void creerCommande({ type: 'EMPORTER' });
                }
              }}
            >
              À emporter
              {emporter.length > 0 && (
                <span className="ml-2 rounded-full bg-marque-tint px-2.5 py-1 text-sm font-bold text-marque-fonce">
                  {emporter.length} en cours
                </span>
              )}
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
              <button
                key={p}
                type="button"
                className="btn-blanc py-5 text-lg"
                onClick={() =>
                  creerCommande({
                    type: 'LIVRAISON',
                    partenaire: p,
                    table_id: (tables ?? []).find((t) => t.partenaire === p)?.id ?? null,
                  })
                }
              >
                {libellePartenaire(p)}
              </button>
            ))}
          </div>
        } />
      )}

      {choixEmporter && (
        <Modale titre="À emporter" onFermer={() => setChoixEmporter(false)} enfants={
          <div className="space-y-3">
            <p className="text-sm text-doux">
              {emporter.length === 1
                ? 'Une commande à emporter est en cours'
                : `${emporter.length} commandes à emporter sont en cours`}{' '}
              — touchez-la pour la reprendre, imprimer la facture ou encaisser.
            </p>
            {emporter.map((c) => (
              <button
                key={c.id}
                type="button"
                className="carte flex w-full items-center justify-between p-4 text-left hover:border-marque"
                onClick={() => {
                  setChoixEmporter(false);
                  aller('commande', c.id);
                }}
              >
                <span>
                  <span className="text-lg font-semibold">{c.code_commande ?? `N°${c.numero_ticket}`}</span>
                  <span className="ml-2 text-sm text-doux">{LIBELLES_STATUTS_COMMANDE[c.statut]}</span>
                </span>
                <span className="text-lg font-semibold">{formatFCFA(c.total)}</span>
              </button>
            ))}
            <button
              type="button"
              className="btn-marque w-full py-5 text-lg"
              onClick={() => void creerCommande({ type: 'EMPORTER' })}
            >
              Nouvelle commande à emporter
            </button>
          </div>
        } />
      )}

      {appareils && <AppareilsModale onFermer={() => setAppareils(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connexion des appareils (QR) : le serveur/cuisinier scanne et ouvre sa
// plateforme, sur le même WiFi que la caisse — sans internet.
// ---------------------------------------------------------------------------
interface AppareilConnexion { cle: string; nom: string; indice: string; url: string | null; image: string | null }
interface ConnexionVue {
  ip: string | null;
  reseau_pret: boolean;
  appareils: AppareilConnexion[];
  /** Jeton de l'écran cuisine ; null = pas le droit de le voir. */
  jeton_kds: string | null;
}

function AppareilsModale({ onFermer }: { onFermer: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['appareils-connexion'],
    queryFn: () => api<ConnexionVue>('/api/appareils/connexion'),
  });

  return (
    <Modale titre="Connexion des appareils" large onFermer={onFermer} enfants={
      <div className="space-y-4">
        <p className="text-sm text-doux">
          Le serveur (tablette) et le cuisinier (écran KDS) scannent leur QR pour ouvrir leur
          plateforme — sans rien taper. Ils doivent juste être sur le <b>même WiFi que la caisse</b>
          {' '}(la connexion internet n’est pas nécessaire).
        </p>

        {isLoading && <p className="text-doux">Préparation des codes…</p>}

        {data && !data.reseau_pret && (
          <div className="rounded-xl bg-amber-100 px-4 py-3 text-amber-900">
            Aucun réseau local détecté. Branchez ce poste au WiFi/réseau du restaurant, puis rouvrez ce menu.
          </div>
        )}

        {data?.reseau_pret && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {data.appareils.map((a) => (
                <div key={a.cle} className="flex flex-col items-center rounded-2xl border border-bordure p-4 text-center">
                  <div className="font-bold">{a.nom}</div>
                  <div className="mb-3 text-xs text-doux">{a.indice}</div>
                  {a.image && <img src={a.image} alt={`QR ${a.nom}`} className="h-52 w-52 rounded-lg border border-bordure bg-white p-2" />}
                  <div className="mt-2 break-all text-xs text-doux">{a.url}</div>
                </div>
              ))}
            </div>
            {/* L'écran cuisine demande un JETON à sa première ouverture — il
                s'identifie par appareil, jamais par PIN. Il est affiché ici,
                à côté de son QR : c'est le moment où on installe la cuisine.
                Vide sur une image neuve (chaque site pose le sien), et sans
                lui le serveur refuse tout écran cuisine. */}
            {data.jeton_kds !== null && (
              <div className={`rounded-xl border px-4 py-3 text-sm ${
                data.jeton_kds ? 'border-bordure bg-surface-douce' : 'border-attente/40 bg-attente-tint text-attente-txt'
              }`}>
                <div className="font-semibold">Jeton de l’écran cuisine</div>
                {data.jeton_kds ? (
                  <>
                    <div className="mt-1 select-text font-mono text-xl font-bold tracking-widest text-fort">
                      {data.jeton_kds}
                    </div>
                    <p className="mt-1 text-xs text-doux">
                      À taper <b>une seule fois</b> sur l’écran cuisine, après avoir scanné son QR.
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-xs">
                    Aucun jeton défini : l’écran cuisine sera refusé. Posez-en un dans
                    <b> Réglages › Paramètres › « Jeton de l’écran cuisine »</b>, puis tapez-le sur l’écran cuisine.
                  </p>
                )}
              </div>
            )}

            <p className="text-center text-xs text-doux">
              Astuce : sur la box, réservez une IP fixe pour ce poste ({data.ip}) — les QR resteront valables même
              après un redémarrage.
            </p>
          </>
        )}
      </div>
    } />
  );
}

// ---------------------------------------------------------------------------
// Tuile d'action (les 6 de l'accueil, § 6.2)
// ---------------------------------------------------------------------------
/**
 * La teinte de la vignette vient de `couleur` : posée sur fond clair elle reste
 * saturée, sur fond sombre on l'éclaircit — sinon elle disparaît. D'où le
 * `color-mix` en style inline plutôt qu'une classe Tailwind par couleur.
 */
function CarteAction({
  principale = false,
  couleur,
  titre,
  sousTitre,
  icone,
  badge,
  badgeCouleur,
  onClick,
}: {
  principale?: boolean;
  couleur?: string;
  titre: string;
  sousTitre: string;
  icone: React.ReactNode;
  badge?: string;
  badgeCouleur?: string;
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
      <span
        className="flex h-14 w-14 flex-none items-center justify-center rounded-[15px]"
        style={styleVignette}
      >
        {icone}
      </span>
      <span className="min-w-0">
        <span className="block text-lg font-bold leading-tight tracking-tight">{titre}</span>
        <span className={`mt-1 block text-[12.5px] font-medium leading-snug ${principale ? 'text-sur-marque/70' : 'text-vitrine-txt-doux'}`}>
          {sousTitre}
        </span>
      </span>
      {badge !== undefined && (
        <span
          className="absolute right-4 top-4 flex h-[26px] min-w-[26px] items-center justify-center rounded-full px-2 text-[12.5px] font-bold text-white"
          style={{ background: badgeCouleur ?? 'var(--alerte)' }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

/** « 11 h 20 » — heure d'ouverture du service, affichée sous le bonjour. */
function heureCourte(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
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
