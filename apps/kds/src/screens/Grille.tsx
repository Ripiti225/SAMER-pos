import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  IconArrowBackUp,
  IconBike,
  IconCheck,
  IconChefHat,
  IconClock,
  IconPlayerPlay,
  IconShoppingBag,
  IconToolsKitchen2,
  IconVolume,
  IconVolumeOff,
  IconWifiOff,
} from '@tabler/icons-react';
import type { CarteKds, KdsVue, TypeCommande } from '@pos/shared';
import { LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { apiKds, ErreurApi } from '../api';
import { sons } from '../sons';

/**
 * Écran cuisine — « Duo contrasté » (DESIGN_V2 § 6.13).
 *
 * Il prend la forme de l'appareil :
 *  - grand écran couché (≥ 1024 px) : les trois colonnes côte à côte ;
 *  - tablette debout, téléphone : un onglet par colonne, une seule à la fois,
 *    avec le nombre de commandes sur chaque onglet.
 * Dans une colonne, les cartes se rangent sur autant de files que la largeur
 * en accueille (≥ 17 rem chacune) : jamais une carte écrasée, jamais un texte
 * qui sort de sa case.
 */

type CleColonne = 'attente' | 'cours' | 'pretes';

/** Une carte est « en cours » dès qu'un de ses plats a été démarré. */
function enPreparation(carte: CarteKds): boolean {
  return carte.items.some((i) => i.statut_cuisine === 'EN_COURS');
}

/** Heure « HH:MM » à partir d'une date ISO. */
function heure(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

const ICONE_TYPE: Record<TypeCommande, typeof IconToolsKitchen2> = {
  SUR_PLACE: IconToolsKitchen2,
  EMPORTER: IconShoppingBag,
  LIVRAISON: IconBike,
};

export function Grille({ onJetonRefuse }: { onJetonRefuse: () => void }) {
  const queryClient = useQueryClient();
  const [connecte, setConnecte] = useState(true);
  const [muet, setMuet] = useState(sons.muet);
  const [onglet, setOnglet] = useState<CleColonne>('attente');
  const [, forcerTic] = useState(0);
  const idsConnus = useRef<Set<string> | null>(null);
  const idsAlertes = useRef(new Set<string>());

  const { data, error } = useQuery({
    queryKey: ['kds'],
    queryFn: () => apiKds<KdsVue>('/api/kds/commandes'),
    refetchInterval: 10000, // filet de sécurité si le WebSocket tombe
  });

  // Jeton d'appareil refusé → retour à l'écran d'installation
  useEffect(() => {
    if (error instanceof ErreurApi && error.statusCode === 403) onJetonRefuse();
  }, [error, onJetonRefuse]);

  // Couleur de marque lue depuis la réponse (pas de session sur le KDS)
  useEffect(() => {
    if (data) {
      document.documentElement.dataset.marque = data.marque;
      document.documentElement.style.setProperty('--marque', data.couleur_hex);
    }
  }, [data]);

  // Chronomètres : tic chaque seconde
  useEffect(() => {
    const t = setInterval(() => forcerTic((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Temps réel (§A4) : re-synchronisation complète à chaque événement et à la reconnexion
  useEffect(() => {
    let socket: WebSocket | null = null;
    let arrete = false;
    const connecter = () => {
      if (arrete) return;
      const protocole = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocole}://${location.host}/ws`);
      socket.onopen = () => {
        setConnecte(true);
        void queryClient.invalidateQueries({ queryKey: ['kds'] }); // rien de perdu
      };
      socket.onmessage = (evt) => {
        try {
          const { type } = JSON.parse(evt.data as string) as { type: string };
          if (type.startsWith('commande')) void queryClient.invalidateQueries({ queryKey: ['kds'] });
        } catch { /* ignoré */ }
      };
      socket.onclose = () => {
        setConnecte(false);
        if (!arrete) setTimeout(connecter, 2000);
      };
    };
    connecter();
    return () => { arrete = true; socket?.close(); };
  }, [queryClient]);

  // Sons : nouvelle carte → son selon type + énoncé vocal ; passage en rouge → alerte unique (§A3)
  useEffect(() => {
    if (!data) return;
    const actuels = new Set(data.en_cuisine.map((c) => c.id));
    if (idsConnus.current !== null) {
      for (const carte of data.en_cuisine) {
        if (!idsConnus.current.has(carte.id)) {
          sons.nouvelleCommande(carte.type);
          sons.enoncerCommande(carte);
        }
      }
    }
    idsConnus.current = actuels;
  }, [data]);

  useEffect(() => {
    if (!data) return;
    for (const carte of data.en_cuisine) {
      const minutes = (Date.now() - new Date(carte.envoyee_le).getTime()) / 60000;
      if (minutes > data.seuils.rouge_minutes && !idsAlertes.current.has(carte.id)) {
        idsAlertes.current.add(carte.id);
        sons.alerteRetard();
      }
    }
  });

  const rafraichir = () => queryClient.invalidateQueries({ queryKey: ['kds'] });
  const commencer = useMutation({
    mutationFn: (id: string) => apiKds(`/api/kds/commandes/${id}/commencer`, { method: 'POST', corps: {} }),
    onSettled: rafraichir,
  });
  const pret = useMutation({
    mutationFn: (id: string) => apiKds(`/api/kds/commandes/${id}/pret`, { method: 'POST', corps: {} }),
    onSettled: rafraichir,
  });
  const servir = useMutation({
    mutationFn: (id: string) => apiKds(`/api/kds/commandes/${id}/servir`, { method: 'POST', corps: {} }),
    onSettled: rafraichir,
  });
  const reprendre = useMutation({
    mutationFn: (id: string) => apiKds(`/api/kds/commandes/${id}/reprendre`, { method: 'POST', corps: {} }),
    onSettled: rafraichir,
  });

  const cartesAttente = (data?.en_cuisine ?? []).filter((c) => !enPreparation(c));
  const cartesEnCours = (data?.en_cuisine ?? []).filter((c) => enPreparation(c));
  const cartesPretes = data?.pretes ?? [];

  // `court` : libellé d'onglet sur téléphone, où trois onglets se partagent 390 px.
  const colonnes: { cle: CleColonne; titre: string; court: string; cartes: CarteKds[] }[] = [
    { cle: 'attente', titre: 'En attente', court: 'Attente', cartes: cartesAttente },
    { cle: 'cours', titre: 'En cours', court: 'En cours', cartes: cartesEnCours },
    { cle: 'pretes', titre: 'Prêtes', court: 'Prêtes', cartes: cartesPretes },
  ];

  const rendreCarte = (cle: CleColonne, carte: CarteKds) =>
    cle === 'pretes' ? (
      <CartePrete
        key={carte.id}
        carte={carte}
        onServir={() => servir.mutate(carte.id)}
        onReprendre={() => reprendre.mutate(carte.id)}
      />
    ) : (
      <Carte
        key={carte.id}
        carte={carte}
        seuils={data!.seuils}
        onCommencer={() => commencer.mutate(carte.id)}
        onPret={() => pret.mutate(carte.id)}
      />
    );

  return (
    <div className="kds flex h-[100dvh] flex-col bg-plan">
      {/* Ossature ardoise : la barre ne bouge jamais, quel que soit l'appareil. */}
      <header className="kds-entete flex flex-none items-center gap-3 bg-ard-900 px-4 py-2.5 text-ard-txt shadow-ard">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-btn bg-marque text-sur-marque">
            <IconChefHat size={24} />
          </span>
          <h1 className="truncate text-xl font-bold sm:text-2xl">Cuisine</h1>
        </div>

        {!connecte && (
          <span className="flex flex-none animate-pulse items-center gap-1.5 rounded-full bg-alerte px-3 py-1 text-sm font-bold text-white">
            <IconWifiOff size={16} /> <span className="hidden sm:inline">Reconnexion…</span>
          </span>
        )}

        <Horloge />

        <button
          type="button"
          onClick={() => { sons.basculerMute(); setMuet(sons.muet); }}
          className={`flex min-h-[48px] flex-none items-center gap-2 rounded-btn px-3 font-semibold transition ${
            muet ? 'bg-alerte text-white' : 'bg-ard-750 text-ard-txt hover:bg-ard-700'
          }`}
          aria-label={muet ? 'Réactiver le son' : 'Couper le son'}
        >
          {muet ? <IconVolumeOff size={22} /> : <IconVolume size={22} />}
          <span className="hidden md:inline">{muet ? 'Son coupé (30 min max)' : 'Couper le son'}</span>
        </button>
      </header>

      {/* Onglets : tablette debout et téléphone. Disparaissent sur grand écran. */}
      <nav className="flex flex-none gap-1.5 bg-ard-850 p-1.5 lg:hidden" aria-label="Colonnes">
        {colonnes.map((col) => (
          <BoutonOnglet
            key={col.cle}
            accent={col.cle}
            actif={onglet === col.cle}
            nombre={col.cartes.length}
            onClick={() => setOnglet(col.cle)}
          >
            <span className="sm:hidden">{col.court}</span>
            <span className="hidden sm:inline">{col.titre}</span>
          </BoutonOnglet>
        ))}
      </nav>

      <main className="flex min-h-0 flex-1">
        {colonnes.map((col) => (
          <Colonne
            key={col.cle}
            accent={col.cle}
            titre={col.cle === 'pretes' ? 'Prêtes — à servir' : col.titre}
            nombre={col.cartes.length}
            visibleSurPetit={onglet === col.cle}
            chargement={!data}
          >
            {col.cartes.map((carte) => rendreCarte(col.cle, carte))}
          </Colonne>
        ))}
      </main>
    </div>
  );
}

/** Heure courante : le cuisinier compare les chronos à l'horloge du mur. */
function Horloge() {
  const maintenant = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return (
    <span className="ml-auto hidden flex-none items-center gap-1.5 text-lg font-semibold tabular-nums text-ard-txt-doux sm:flex">
      <IconClock size={20} /> {maintenant}
    </span>
  );
}

const ACCENT: Record<CleColonne, { texte: string; aplat: string; pastille: string }> = {
  attente: { texte: 'text-attente-txt', aplat: 'bg-attente', pastille: 'bg-attente-tint text-attente-txt' },
  cours: { texte: 'text-info-txt', aplat: 'bg-info', pastille: 'bg-info-tint text-info-txt' },
  pretes: { texte: 'text-ok-txt', aplat: 'bg-ok', pastille: 'bg-ok-tint text-ok-txt' },
};

function BoutonOnglet({
  accent,
  actif,
  nombre,
  onClick,
  children,
}: {
  accent: CleColonne;
  actif: boolean;
  nombre: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={actif}
      // Téléphone : le nombre AU-DESSUS du libellé, pour que « Attente »,
      // « En cours » et « Prêtes » tiennent entiers même sur 320 px.
      className={`flex min-h-[56px] min-w-0 flex-1 flex-col-reverse items-center justify-center gap-0.5 rounded-btn px-1 py-1 font-bold transition sm:flex-row sm:gap-2 sm:px-2 ${
        actif ? 'bg-carte text-txt shadow-e1' : 'text-ard-txt-doux hover:bg-ard-750'
      }`}
    >
      <span className="max-w-full truncate text-sm sm:text-lg">{children}</span>
      <span
        className={`flex h-6 min-w-[1.5rem] flex-none items-center justify-center rounded-full px-1.5 text-sm tabular-nums text-white sm:h-7 sm:min-w-[1.75rem] ${
          nombre > 0 ? ACCENT[accent].aplat : 'bg-ard-650'
        }`}
      >
        {nombre}
      </span>
    </button>
  );
}

/** Une colonne : en-tête (grand écran seulement) + zone défilante des cartes. */
function Colonne({
  titre,
  nombre,
  accent,
  visibleSurPetit,
  chargement,
  children,
}: {
  titre: string;
  nombre: number;
  accent: CleColonne;
  visibleSurPetit: boolean;
  chargement: boolean;
  children: ReactNode;
}) {
  return (
    // `min-w-0` : sans lui, une colonne flex refuse de rétrécir sous la
    // largeur de son contenu, et les cartes débordent les unes sur les autres.
    <section
      className={`${visibleSurPetit ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col lg:flex ${
        accent !== 'pretes' ? 'lg:border-r lg:border-filet' : ''
      }`}
    >
      <div className="hidden flex-none items-center gap-2.5 border-b border-filet bg-carte px-5 py-3 lg:flex">
        <span className={`h-3 w-3 flex-none rounded-full ${ACCENT[accent].aplat}`} />
        <h2 className={`truncate text-xl font-bold ${ACCENT[accent].texte}`}>{titre}</h2>
        <span className={`ml-auto rounded-full px-3 py-0.5 text-lg font-bold tabular-nums ${ACCENT[accent].pastille}`}>
          {nombre}
        </span>
      </div>
      <div className="kds-defile grid flex-1 auto-rows-min content-start gap-3 overflow-y-auto p-3 sm:gap-4 sm:p-4">
        {chargement ? (
          <>
            <div className="kds-squelette h-56" />
            <div className="kds-squelette h-44" />
          </>
        ) : nombre === 0 ? (
          <div className="col-span-full flex flex-col items-center gap-3 pt-16 text-center text-txt-faible">
            <IconChefHat size={48} stroke={1.5} />
            <span className="text-xl font-semibold">Aucune commande</span>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/** En-tête commun aux cartes : numéro très grand, provenance, heure. */
function EnteteCarte({ carte, droite }: { carte: CarteKds; droite: ReactNode }) {
  const Icone = ICONE_TYPE[carte.type];
  const provenance = [
    carte.table_numero ? `Table ${carte.table_numero}` : LIBELLES_TYPES_COMMANDE[carte.type],
    carte.partenaire,
  ].filter(Boolean).join(' · ');
  return (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        {/* Numéro de ticket en TRÈS grand (§A1) — il rétrécit avec la carte
            au lieu de déborder. */}
        <div className="kds-numero break-words font-black leading-none text-txt">
          {carte.code_commande ?? `N° ${carte.numero_ticket}`}
        </div>
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-base font-semibold text-txt-doux">
          <Icone size={18} className="flex-none" />
          <span className="truncate">{provenance}</span>
        </div>
        <div className="text-sm text-txt-faible">Commandé à {heure(carte.heure_commande)}</div>
      </div>
      <div className="flex-none">{droite}</div>
    </div>
  );
}

/** Lignes de plats : quantité dans une case fixe, nom qui revient à la ligne. */
function ListePlats({ carte, masquerAnnules = false }: { carte: CarteKds; masquerAnnules?: boolean }) {
  const items = masquerAnnules ? carte.items.filter((i) => i.statut_cuisine !== 'ANNULE') : carte.items;
  return (
    <ul className="my-3 flex-1 space-y-2.5">
      {items.map((item) => {
        const annule = item.statut_cuisine === 'ANNULE';
        return (
          <li key={item.id} className="flex items-start gap-2.5">
            <span
              className={`flex h-9 min-w-[2.25rem] flex-none items-center justify-center rounded-[var(--r-sm)] px-1.5 text-xl font-black tabular-nums ${
                annule ? 'bg-alerte-tint text-alerte-txt' : 'bg-carte-douce text-txt'
              }`}
            >
              {item.quantite}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className={`break-words text-xl font-bold leading-tight ${annule ? 'text-alerte-txt line-through' : 'text-txt'}`}>
                {item.nom_snapshot}
              </div>
              {annule && <div className="text-sm font-bold uppercase tracking-wide text-alerte-txt">Annulé</div>}
              {item.supplements.map((s) => (
                <div key={s.nom} className="break-words text-base font-semibold text-marque-sur-plan">+ {s.nom}</div>
              ))}
              {item.options
                .filter((o) => o.choix.length > 0)
                .map((o) => (
                  <div key={o.groupe} className="break-words text-base font-semibold text-info-txt">
                    {o.groupe} : {o.choix.join(', ')}
                  </div>
                ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Carte({
  carte,
  seuils,
  onCommencer,
  onPret,
}: {
  carte: CarteKds;
  seuils: KdsVue['seuils'];
  onCommencer: () => void;
  onPret: () => void;
}) {
  const ecouleMs = Date.now() - new Date(carte.envoyee_le).getTime();
  const minutes = ecouleMs / 60000;
  const mm = String(Math.floor(ecouleMs / 60000)).padStart(2, '0');
  const ss = String(Math.floor((ecouleMs % 60000) / 1000)).padStart(2, '0');

  // Le chronomètre est le SEUL élément vraiment coloré de la carte :
  // vert < orange, orange, puis rouge au-delà du seuil (correction 5).
  const niveau = minutes > seuils.rouge_minutes ? 'rouge' : minutes > seuils.orange_minutes ? 'orange' : 'vert';
  const couleurChrono =
    niveau === 'rouge' ? 'bg-alerte text-white' : niveau === 'orange' ? 'bg-attente text-white' : 'bg-ok text-white';
  const enAttente = carte.items.some((i) => i.statut_cuisine === 'A_PREPARER');

  return (
    <article
      className={`carte relative flex min-w-0 flex-col overflow-hidden p-4 ${
        niveau === 'rouge' ? 'border-2 border-alerte shadow-e2' : ''
      }`}
    >
      {/* Filet d'état à gauche : on lit la colonne d'une carte sans lire son titre. */}
      <span className={`absolute inset-y-0 left-0 w-1.5 ${enAttente ? 'bg-attente' : 'bg-info'}`} />
      <EnteteCarte
        carte={carte}
        droite={
          <div className={`rounded-btn px-2.5 py-1.5 text-2xl font-black tabular-nums ${couleurChrono}`}>
            {mm}:{ss}
          </div>
        }
      />
      <ListePlats carte={carte} />

      {/* 2 boutons, la carte entière change d'état (§A2). Ils passent l'un
          sous l'autre si la carte est trop étroite pour les deux. */}
      <div className="flex flex-wrap gap-2">
        {enAttente && (
          <button
            type="button"
            onClick={onCommencer}
            className="flex h-14 min-w-[8rem] flex-1 items-center justify-center gap-2 rounded-btn border-2 border-filet-fort bg-carte text-lg font-bold text-txt transition hover:border-info hover:bg-info-tint active:translate-y-px"
          >
            <IconPlayerPlay size={20} className="text-info" /> Commencer
          </button>
        )}
        <button
          type="button"
          onClick={onPret}
          className="flex h-14 min-w-[8rem] flex-1 items-center justify-center gap-2 rounded-btn bg-ok text-lg font-bold text-white shadow-e1 transition hover:brightness-105 active:translate-y-px"
        >
          <IconCheck size={22} stroke={3} /> Prêt
        </button>
      </div>
    </article>
  );
}

/** Carte d'une commande PRÊTE : reste affichée jusqu'à « Servi » (§ demande terrain). */
function CartePrete({
  carte,
  onServir,
  onReprendre,
}: {
  carte: CarteKds;
  onServir: () => void;
  onReprendre: () => void;
}) {
  return (
    <article className="carte relative flex min-w-0 flex-col overflow-hidden border-ok p-4">
      <span className="absolute inset-y-0 left-0 w-1.5 bg-ok" />
      <EnteteCarte
        carte={carte}
        droite={
          <span className="flex items-center gap-1 rounded-full bg-ok-tint px-3 py-1 text-sm font-bold text-ok-txt">
            <IconCheck size={16} stroke={3} /> Prête
          </span>
        }
      />
      <ListePlats carte={carte} masquerAnnules />

      {/* « Servi » est le geste attendu : toute la largeur. « Reprendre »
          (erreur de clic) reste à portée, mais en retrait. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onReprendre}
          className="flex h-14 flex-[1_1_7rem] items-center justify-center gap-2 rounded-btn border-2 border-filet-fort bg-carte px-3 text-base font-bold text-txt-doux transition hover:border-attente hover:text-attente-txt active:translate-y-px"
          aria-label="Reprendre en cuisine"
        >
          <IconArrowBackUp size={20} /> Reprendre
        </button>
        <button
          type="button"
          onClick={onServir}
          className="flex h-14 flex-[2_1_8rem] items-center justify-center gap-2 rounded-btn bg-ok text-xl font-bold text-white shadow-e1 transition hover:brightness-105 active:translate-y-px"
        >
          <IconCheck size={24} stroke={3} /> Servi
        </button>
      </div>
    </article>
  );
}
