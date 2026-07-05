import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { CarteKds, KdsVue, SessionInfo } from '@pos/shared';
import { LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { api } from '@pos/shared-ui';
import { sons } from '../sons';

export function Grille({ session, onDeconnexion }: { session: SessionInfo; onDeconnexion: () => void }) {
  const queryClient = useQueryClient();
  const [connecte, setConnecte] = useState(true);
  const [muet, setMuet] = useState(sons.muet);
  const [, forcerTic] = useState(0);
  const idsConnus = useRef<Set<string> | null>(null);
  const idsAlertes = useRef(new Set<string>());

  const { data } = useQuery({
    queryKey: ['kds'],
    queryFn: () => api<KdsVue>('/api/kds/commandes'),
    refetchInterval: 10000, // filet de sécurité si le WebSocket tombe
  });

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

  // Sons : nouvelle carte → son selon type ; passage en rouge → alerte unique (§A3)
  useEffect(() => {
    if (!data) return;
    const actuels = new Set(data.en_cuisine.map((c) => c.id));
    if (idsConnus.current !== null) {
      for (const carte of data.en_cuisine) {
        if (!idsConnus.current.has(carte.id)) sons.nouvelleCommande(carte.type);
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
    mutationFn: (id: string) => api(`/api/kds/commandes/${id}/commencer`, { method: 'POST', corps: {} }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['kds'] }),
  });
  const pret = useMutation({
    mutationFn: (id: string) => api(`/api/kds/commandes/${id}/pret`, { method: 'POST', corps: {} }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['kds'] }),
  });
  const reprendre = useMutation({
    mutationFn: (id: string) => api(`/api/kds/commandes/${id}/reprendre`, { method: 'POST', corps: {} }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['kds'] }),
  });

  const deconnecter = async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    onDeconnexion();
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b border-zinc-800 px-4 py-2">
        <h1 className="text-2xl font-black text-accent">CUISINE</h1>
        <span className="text-zinc-400">{session.utilisateur.nom_complet}</span>
        {!connecte && (
          <span className="animate-pulse rounded-full bg-amber-900 px-4 py-1 text-amber-200">
            Reconnexion…
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className={`btn ${muet ? 'bg-red-900 text-red-100' : 'bg-zinc-800'}`}
            onClick={() => { sons.basculerMute(); setMuet(sons.muet); }}
          >
            {muet ? '🔇 Muet (30 min)' : '🔊 Son'}
          </button>
          <button type="button" className="btn-sombre" onClick={deconnecter}>
            Quitter
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Grille : plus ancienne → plus récente (§A1) */}
        <main className="grid flex-1 auto-rows-min grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2 xl:grid-cols-3">
          {(data?.en_cuisine ?? []).map((carte) => (
            <Carte
              key={carte.id}
              carte={carte}
              seuils={data!.seuils}
              onCommencer={() => commencer.mutate(carte.id)}
              onPret={() => pret.mutate(carte.id)}
            />
          ))}
          {data?.en_cuisine.length === 0 && (
            <div className="col-span-full pt-20 text-center text-3xl text-zinc-600">
              Aucune commande en attente 👨‍🍳
            </div>
          )}
        </main>

        {/* Colonne « Prêtes » : 10 dernières, rappelables (§A2) */}
        <aside className="w-64 shrink-0 space-y-2 overflow-y-auto border-l border-zinc-800 p-3">
          <h2 className="text-lg font-bold text-emerald-400">Prêtes ✔</h2>
          {(data?.pretes ?? []).map((carte) => (
            <div key={carte.id} className="carte border-emerald-900 p-3">
              <div className="text-2xl font-black">N° {carte.numero_ticket}</div>
              <div className="text-sm text-zinc-400">
                {carte.table_numero ? `Table ${carte.table_numero}` : LIBELLES_TYPES_COMMANDE[carte.type]}
              </div>
              <button type="button" className="btn-sombre mt-2 w-full min-h-[48px] text-base" onClick={() => reprendre.mutate(carte.id)}>
                ↩ Reprendre
              </button>
            </div>
          ))}
        </aside>
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

  const couleurChrono =
    minutes > seuils.rouge_minutes
      ? 'bg-red-600 text-white'
      : minutes > seuils.orange_minutes
        ? 'bg-orange-500 text-zinc-950'
        : 'bg-emerald-600 text-white';

  const enAttente = carte.items.some((i) => i.statut_cuisine === 'A_PREPARER');

  return (
    <div className={`carte flex flex-col p-4 ${minutes > seuils.rouge_minutes ? 'border-red-600' : ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          {/* Numéro de ticket en TRÈS grand (§A1) */}
          <div className="text-5xl font-black leading-none">N° {carte.numero_ticket}</div>
          <div className="mt-1 text-lg text-zinc-300">
            {LIBELLES_TYPES_COMMANDE[carte.type]}
            {carte.partenaire ? ` — ${carte.partenaire}` : ''}
            {carte.table_numero ? ` — Table ${carte.table_numero}` : ''}
          </div>
          <div className="text-sm text-zinc-500">
            Envoyée à {new Date(carte.envoyee_le).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
          </div>
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
              item.statut_cuisine === 'ANNULE' ? 'text-red-500 line-through' : ''
            }`}
          >
            {item.quantite} × {item.nom_snapshot}
            {item.statut_cuisine === 'ANNULE' && <span className="ml-2 no-underline">ANNULÉ</span>}
            {item.supplements.map((s) => (
              <div key={s.nom} className="ml-6 text-lg font-semibold text-amber-300">+ {s.nom}</div>
            ))}
            {item.options
              .filter((o) => o.choix.length > 0)
              .map((o) => (
                <div key={o.groupe} className="ml-6 text-lg font-semibold text-sky-300">
                  {o.groupe} : {o.choix.join(', ')}
                </div>
              ))}
          </li>
        ))}
      </ul>

      {/* 2 boutons par carte, la carte entière change d'état (§A2) */}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-sombre py-5" disabled={!enAttente} onClick={onCommencer}>
          {enAttente ? 'Commencer' : 'En cours…'}
        </button>
        <button type="button" className="btn-accent py-5" onClick={onPret}>
          Prêt ✔
        </button>
      </div>
    </div>
  );
}
