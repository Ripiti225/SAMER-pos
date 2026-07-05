import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { AppelVue } from '@pos/shared';
import { LIBELLES_APPEL } from '@pos/shared';
import { api } from '../api';
import { useCaisse } from '../stores/session';

interface NotifPrete {
  commande_id: string;
  table_numero: string | null;
}

const sonAValider = new Audio('/sons/a-valider.wav');
const sonPrete = new Audio('/sons/prete.wav');

/**
 * Repli caisse (CORRECTIONS3 points 1 & 2) : quand aucun serveur n'est
 * disponible, les appels et commandes client — ainsi que les commandes prêtes
 * sans serveur — arrivent ici avec bip + notification. La caisse peut tout
 * traiter elle-même (valider une commande client, servir, imprimer la note).
 */
export function NotificationsCaisse() {
  const { session, aller, afficherToast } = useCaisse();
  const queryClient = useQueryClient();
  const [pretes, setPretes] = useState<NotifPrete[]>([]);
  const dejaVus = useRef(new Set<string>());

  const { data: appels } = useQuery({
    queryKey: ['appels-caisse'],
    queryFn: () => api<AppelVue[]>('/api/appels/en-attente'),
    enabled: !!session,
    refetchInterval: 15_000,
  });
  const { data: aValider } = useQuery({
    queryKey: ['a-valider-caisse'],
    queryFn: () => api<{ id: string; table_numero: string | null }[]>('/api/commandes/a-valider'),
    enabled: !!session,
    refetchInterval: 15_000,
  });

  const appelsCaisse = (appels ?? []).filter((a) => a.cible === 'CAISSE');
  const validationsCaisse = aValider ?? [];

  const rafraichir = () => {
    void queryClient.invalidateQueries({ queryKey: ['appels-caisse'] });
    void queryClient.invalidateQueries({ queryKey: ['a-valider-caisse'] });
    void queryClient.invalidateQueries({ queryKey: ['tables'] });
  };

  useEffect(() => {
    let socket: WebSocket | null = null;
    let arrete = false;
    const connecter = () => {
      if (arrete) return;
      const protocole = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocole}://${location.host}/ws`);
      socket.onmessage = (evt) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(evt.data as string); } catch { return; }
        const type = m.type as string;
        const cle = `${type}:${m.appel_id ?? m.commande_id ?? ''}:${m.quand}`;
        const bip = (audio: HTMLAudioElement) => {
          if (dejaVus.current.has(cle)) return;
          dejaVus.current.add(cle);
          void audio.play().catch(() => undefined);
        };
        if ((type === 'appel:nouveau' || type === 'commande:client_a_valider') && m.cible === 'CAISSE') {
          bip(sonAValider);
          afficherToast(
            type === 'appel:nouveau'
              ? `Table ${m.table_numero} appelle`
              : `Table ${m.table_numero} : commande client à valider`,
          );
          rafraichir();
        }
        if (type === 'commande:prete' && m.cible === 'CAISSE') {
          bip(sonPrete);
          setPretes((p) => (p.some((x) => x.commande_id === m.commande_id) ? p : [...p, { commande_id: m.commande_id as string, table_numero: (m.table_numero as string) ?? null }]));
        }
        if (type === 'commande:servie' || type === 'commande') rafraichir();
      };
      socket.onclose = () => { if (!arrete) setTimeout(connecter, 2000); };
    };
    connecter();
    return () => { arrete = true; socket?.close(); };
  }, []);

  const valider = async (id: string) => { try { await api(`/api/commandes/${id}/valider`, { method: 'POST', corps: {} }); rafraichir(); } catch (e) { afficherToast((e as Error).message); } };
  const refuser = async (id: string) => {
    const motif = window.prompt('Motif du refus (montré au client) :');
    if (!motif) return;
    try { await api(`/api/commandes/${id}/refuser`, { method: 'POST', corps: { motif } }); rafraichir(); } catch (e) { afficherToast((e as Error).message); }
  };
  const traiterAppel = async (a: AppelVue) => {
    try {
      await api(`/api/appels/${a.id}/traiter`, { method: 'POST', corps: {} });
      rafraichir();
      if (a.type === 'DEMANDE_FACTURE') aller('tables');
    } catch (e) { afficherToast((e as Error).message); }
  };
  const servir = async (id: string) => { try { await api(`/api/commandes/${id}/servir`, { method: 'POST', corps: {} }); setPretes((p) => p.filter((x) => x.commande_id !== id)); rafraichir(); } catch (e) { afficherToast((e as Error).message); } };

  if (appelsCaisse.length === 0 && validationsCaisse.length === 0 && pretes.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[55] w-80 space-y-2">
      {pretes.map((p) => (
        <div key={p.commande_id} className="carte border-2 border-ok bg-ok-tint p-3">
          <div className="font-bold text-ok">Table {p.table_numero} — commande prête</div>
          <button type="button" className="btn-ok mt-2 min-h-[44px] w-full" onClick={() => servir(p.commande_id)}>Servie</button>
        </div>
      ))}
      {validationsCaisse.map((c) => (
        <div key={c.id} className="carte border-2 border-info bg-info-tint p-3">
          <div className="font-bold text-info">Table {c.table_numero} — commande client à valider</div>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-ok min-h-[44px] flex-1" onClick={() => valider(c.id)}>Valider</button>
            <button type="button" className="btn-alerte min-h-[44px] flex-1" onClick={() => refuser(c.id)}>Refuser</button>
          </div>
        </div>
      ))}
      {appelsCaisse.map((a) => (
        <div key={a.id} className="carte border-2 border-marque bg-marque-tint p-3">
          <div className="font-bold text-marque-fonce">Table {a.table_numero} — {LIBELLES_APPEL[a.type]}</div>
          <button type="button" className="btn-blanc mt-2 min-h-[44px] w-full" onClick={() => traiterAppel(a)}>C’est fait</button>
        </div>
      ))}
    </div>
  );
}
