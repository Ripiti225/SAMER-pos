import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CarteKds, KdsVue } from '@pos/shared';
import { LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { apiKds, ErreurApi } from '../api';
import { sons } from '../sons';

/** Une carte est « en cours » dès qu'un de ses plats a été démarré. */
function enPreparation(carte: CarteKds): boolean {
  return carte.items.some((i) => i.statut_cuisine === 'EN_COURS');
}

/** Heure « HH:MM » à partir d'une date ISO. */
function heure(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function Grille({ onJetonRefuse }: { onJetonRefuse: () => void }) {
  const queryClient = useQueryClient();
  const [connecte, setConnecte] = useState(true);
  const [muet, setMuet] = useState(sons.muet);
  const [historiqueOuvert, setHistoriqueOuvert] = useState(false);
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

  const commencer = useMutation({
    mutationFn: (id: string) => apiKds(`/api/kds/commandes/${id}/commencer`, { method: 'POST', corps: {} }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['kds'] }),
  });
  const pret = useMutation({
    mutationFn: (id: string) => apiKds(`/api/kds/commandes/${id}/pret`, { method: 'POST', corps: {} }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['kds'] }),
  });
  const reprendre = useMutation({
    mutationFn: (id: string) => apiKds(`/api/kds/commandes/${id}/reprendre`, { method: 'POST', corps: {} }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['kds'] }),
  });

  const cartesAttente = (data?.en_cuisine ?? []).filter((c) => !enPreparation(c));
  const cartesEnCours = (data?.en_cuisine ?? []).filter((c) => enPreparation(c));

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-bordure px-4 py-2">
        <h1 className="text-2xl font-black text-marque-fonce">Cuisine</h1>
        {!connecte && (
          <span className="animate-pulse rounded-full bg-alerte-tint px-4 py-1 text-alerte">
            Reconnexion…
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="btn border border-bordure bg-surface"
            onClick={() => setHistoriqueOuvert(true)}
          >
            Historique{data?.pretes.length ? ` (${data.pretes.length})` : ''}
          </button>
          <button
            type="button"
            className={`btn ${muet ? 'bg-alerte text-white' : 'border border-bordure bg-surface'}`}
            onClick={() => { sons.basculerMute(); setMuet(sons.muet); }}
          >
            {muet ? 'Son coupé (30 min max)' : 'Couper le son'}
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Colonne 1 : EN ATTENTE (nouvelles commandes, pas encore démarrées) */}
        <Colonne titre="En attente" nombre={cartesAttente.length} accent="attente">
          {cartesAttente.map((carte) => (
            <Carte
              key={carte.id}
              carte={carte}
              seuils={data!.seuils}
              onCommencer={() => commencer.mutate(carte.id)}
              onPret={() => pret.mutate(carte.id)}
            />
          ))}
        </Colonne>

        {/* Colonne 2 : EN COURS (préparation démarrée) */}
        <Colonne titre="En cours" nombre={cartesEnCours.length} accent="cours">
          {cartesEnCours.map((carte) => (
            <Carte
              key={carte.id}
              carte={carte}
              seuils={data!.seuils}
              onCommencer={() => commencer.mutate(carte.id)}
              onPret={() => pret.mutate(carte.id)}
            />
          ))}
        </Colonne>
      </div>

      {historiqueOuvert && (
        <Historique
          cartes={data?.pretes ?? []}
          onFermer={() => setHistoriqueOuvert(false)}
          onReprendre={(id) => reprendre.mutate(id)}
        />
      )}
    </div>
  );
}

/** Une colonne de la grille (en-tête + zone défilante des cartes). */
function Colonne({
  titre,
  nombre,
  accent,
  children,
}: {
  titre: string;
  nombre: number;
  accent: 'attente' | 'cours';
  children: ReactNode;
}) {
  const couleur = accent === 'attente' ? 'text-marque-fonce' : 'text-info';
  return (
    <section className={`flex flex-1 flex-col overflow-hidden ${accent === 'attente' ? 'border-r border-bordure' : ''}`}>
      <div className="flex items-center gap-2 border-b border-bordure px-4 py-2">
        <h2 className={`text-xl font-black ${couleur}`}>{titre}</h2>
        <span className="rounded-full bg-surface px-3 py-0.5 text-lg font-bold text-doux">{nombre}</span>
      </div>
      <div className="grid flex-1 auto-rows-min grid-cols-1 gap-4 overflow-y-auto p-4 xl:grid-cols-2">
        {nombre === 0 ? (
          <div className="col-span-full pt-16 text-center text-2xl text-doux">Aucune commande</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

/** Panneau Historique : les commandes prêtes (rappelables). */
function Historique({
  cartes,
  onFermer,
  onReprendre,
}: {
  cartes: CarteKds[];
  onFermer: () => void;
  onReprendre: (id: string) => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onFermer}>
      <div className="flex h-full w-full max-w-md flex-col bg-fond shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-bordure px-4 py-3">
          <h2 className="text-2xl font-black text-ok">Historique — Prêtes ✔</h2>
          <button type="button" className="btn-blanc px-3" onClick={onFermer}>✕</button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {cartes.length === 0 && <p className="pt-10 text-center text-doux">Aucune commande prête pour l’instant.</p>}
          {cartes.map((carte) => (
            <div key={carte.id} className="carte border-ok p-3">
              <div className="flex items-start justify-between">
                <div className="text-3xl font-black">N° {carte.numero_ticket}</div>
                <div className="text-right text-sm text-doux">
                  <div>{carte.table_numero ? `Table ${carte.table_numero}` : LIBELLES_TYPES_COMMANDE[carte.type]}</div>
                  <div>Commandé à {heure(carte.heure_commande)}</div>
                </div>
              </div>
              <ul className="my-2 space-y-1">
                {carte.items
                  .filter((i) => i.statut_cuisine !== 'ANNULE')
                  .map((item) => (
                    <li key={item.id} className="text-lg font-semibold">{item.quantite} × {item.nom_snapshot}</li>
                  ))}
              </ul>
              <button type="button" className="btn-blanc w-full min-h-[48px]" onClick={() => onReprendre(carte.id)}>
                ↩ Reprendre (renvoyer en cuisine)
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
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
  // vert < 10 min, orange 10–20 min, rouge > 20 min (correction 5)
  const couleurChrono =
    minutes > seuils.rouge_minutes
      ? 'bg-alerte text-white'
      : minutes > seuils.orange_minutes
        ? 'border border-alerte bg-alerte-tint text-alerte'
        : 'bg-ok text-white';

  const enAttente = carte.items.some((i) => i.statut_cuisine === 'A_PREPARER');

  return (
    <div className={`carte flex flex-col p-4 ${minutes > seuils.rouge_minutes ? 'border-alerte' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          {/* Numéro de ticket en TRÈS grand (§A1) */}
          <div className="text-5xl font-black leading-none">N° {carte.numero_ticket}</div>
          <div className="mt-1 text-lg text-doux">
            {LIBELLES_TYPES_COMMANDE[carte.type]}
            {carte.partenaire ? ` — ${carte.partenaire}` : ''}
            {carte.table_numero ? ` — Table ${carte.table_numero}` : ''}
          </div>
          <div className="text-sm text-doux">🕐 Commandé à {heure(carte.heure_commande)}</div>
        </div>
        <div className={`rounded-xl px-3 py-2 text-2xl font-black tabular-nums ${couleurChrono}`}>
          {mm}:{ss}
        </div>
      </div>

      <ul className="my-3 flex-1 space-y-2">
        {carte.items.map((item) => (
          <li
            key={item.id}
            className={`text-2xl font-bold leading-tight ${
              item.statut_cuisine === 'ANNULE' ? 'text-alerte line-through' : ''
            }`}
          >
            {item.quantite} × {item.nom_snapshot}
            {item.statut_cuisine === 'ANNULE' && <span className="ml-2 no-underline">Annulé</span>}
            {item.supplements.map((s) => (
              <div key={s.nom} className="ml-6 text-lg font-semibold text-marque-fonce">+ {s.nom}</div>
            ))}
            {item.options
              .filter((o) => o.choix.length > 0)
              .map((o) => (
                <div key={o.groupe} className="ml-6 text-lg font-semibold text-info">
                  {o.groupe} : {o.choix.join(', ')}
                </div>
              ))}
          </li>
        ))}
      </ul>

      {/* 2 boutons par carte, la carte entière change d'état (§A2) */}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-blanc py-5" disabled={!enAttente} onClick={onCommencer}>
          {enAttente ? 'Commencer' : 'En cours…'}
        </button>
        <button type="button" className="btn-ok py-5" onClick={onPret}>
          Prêt ✔
        </button>
      </div>
    </div>
  );
}
