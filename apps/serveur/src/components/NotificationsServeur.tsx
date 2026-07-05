import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { AppelVue, SessionInfo } from '@pos/shared';
import { LIBELLES_APPEL } from '@pos/shared';
import { api } from '@pos/shared-ui';

interface NotifPrete {
  commande_id: string;
  table_numero: string | null;
}

const sonAValider = new Audio('/sons/a-valider.wav');
const sonPrete = new Audio('/sons/prete.wav');

/**
 * Centre de notifications du serveur (CORRECTIONS3 points 1 & 2). Tient aussi
 * la connexion WebSocket qui envoie le battement de cœur — indispensable à la
 * présence côté serveur (routage des appels/commandes). Sons distincts :
 * « à valider / appel » vs « commande prête ».
 */
export function NotificationsServeur({ session, afficherToast }: { session: SessionInfo; afficherToast: (m: string) => void }) {
  const moi = session.utilisateur.id;
  const queryClient = useQueryClient();
  const [pretes, setPretes] = useState<NotifPrete[]>([]);

  // Appels + commandes à valider qui me sont destinés (réconciliation au montage)
  const { data: appels } = useQuery({
    queryKey: ['appels-en-attente'],
    queryFn: () => api<AppelVue[]>('/api/appels/en-attente'),
    refetchInterval: 15_000,
  });
  const { data: aValider } = useQuery({
    queryKey: ['a-valider'],
    queryFn: () => api<{ id: string; table_numero: string | null; serveur_id: string | null }[]>('/api/commandes/a-valider'),
    refetchInterval: 15_000,
  });

  const mesAppels = (appels ?? []).filter((a) => a.cible === 'SERVEUR' && a.serveur_id === moi);
  const mesValidations = (aValider ?? []).filter((c) => !c.serveur_id || c.serveur_id === moi);

  const rafraichir = () => {
    void queryClient.invalidateQueries({ queryKey: ['appels-en-attente'] });
    void queryClient.invalidateQueries({ queryKey: ['a-valider'] });
    void queryClient.invalidateQueries({ queryKey: ['tables'] });
  };

  // WebSocket + heartbeat (présence)
  const dejaVus = useRef(new Set<string>());
  useEffect(() => {
    let socket: WebSocket | null = null;
    let arrete = false;
    let battement: ReturnType<typeof setInterval> | null = null;

    const connecter = () => {
      if (arrete) return;
      const protocole = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocole}://${location.host}/ws`);
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'heartbeat' }));
        battement = setInterval(() => socket?.send(JSON.stringify({ type: 'heartbeat' })), 30_000);
      };
      socket.onmessage = (evt) => {
        let m: Record<string, unknown>;
        try { m = JSON.parse(evt.data as string); } catch { return; }
        const type = m.type as string;
        const cle = `${type}:${m.appel_id ?? m.commande_id ?? ''}:${m.quand}`;

        if (type === 'appel:nouveau' && m.cible === 'SERVEUR' && m.serveur_id === moi) {
          if (!dejaVus.current.has(cle)) { dejaVus.current.add(cle); void sonAValider.play().catch(() => undefined); }
          afficherToast(`Table ${m.table_numero} — ${LIBELLES_APPEL[m.type_appel as keyof typeof LIBELLES_APPEL] ?? 'appel'}`);
          rafraichir();
        }
        if (type === 'commande:client_a_valider' && m.cible === 'SERVEUR' && (!m.serveur_id || m.serveur_id === moi)) {
          if (!dejaVus.current.has(cle)) { dejaVus.current.add(cle); void sonAValider.play().catch(() => undefined); }
          afficherToast(`Table ${m.table_numero} — commande client à valider`);
          rafraichir();
        }
        if (type === 'commande:prete' && m.cible === 'SERVEUR' && m.serveur_id === moi) {
          if (!dejaVus.current.has(cle)) { dejaVus.current.add(cle); void sonPrete.play().catch(() => undefined); }
          setPretes((p) => (p.some((x) => x.commande_id === m.commande_id) ? p : [...p, { commande_id: m.commande_id as string, table_numero: (m.table_numero as string) ?? null }]));
        }
        if (type === 'commande:servie' || type === 'commande') rafraichir();
        if (typeof type === 'string' && type.startsWith('table')) void queryClient.invalidateQueries({ queryKey: ['tables'] });
      };
      socket.onclose = () => {
        if (battement) clearInterval(battement);
        if (!arrete) setTimeout(connecter, 2000);
      };
    };
    connecter();
    return () => { arrete = true; if (battement) clearInterval(battement); socket?.close(); };
  }, [moi]);

  const valider = async (id: string) => { try { await api(`/api/commandes/${id}/valider`, { method: 'POST', corps: {} }); rafraichir(); } catch (e) { afficherToast((e as Error).message); } };
  const refuser = async (id: string) => {
    const motif = window.prompt('Motif du refus (montré au client) :');
    if (!motif) return;
    try { await api(`/api/commandes/${id}/refuser`, { method: 'POST', corps: { motif } }); rafraichir(); } catch (e) { afficherToast((e as Error).message); }
  };
  const traiterAppel = async (id: string) => { try { await api(`/api/appels/${id}/traiter`, { method: 'POST', corps: {} }); rafraichir(); } catch (e) { afficherToast((e as Error).message); } };
  const servir = async (id: string) => {
    try { await api(`/api/commandes/${id}/servir`, { method: 'POST', corps: {} }); setPretes((p) => p.filter((x) => x.commande_id !== id)); rafraichir(); }
    catch (e) { afficherToast((e as Error).message); }
  };

  const rien = mesAppels.length === 0 && mesValidations.length === 0 && pretes.length === 0;
  if (rien) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[55] w-80 space-y-2">
      {pretes.map((p) => (
        <div key={p.commande_id} className="carte border-2 border-ok bg-ok-tint p-3">
          <div className="font-bold text-ok">Table {p.table_numero} — commande prête</div>
          <button type="button" className="btn-ok mt-2 min-h-[44px] w-full" onClick={() => servir(p.commande_id)}>Servie</button>
        </div>
      ))}
      {mesValidations.map((c) => (
        <div key={c.id} className="carte border-2 border-info bg-info-tint p-3">
          <div className="font-bold text-info">Table {c.table_numero} — commande client à valider</div>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-ok min-h-[44px] flex-1" onClick={() => valider(c.id)}>Valider</button>
            <button type="button" className="btn-alerte min-h-[44px] flex-1" onClick={() => refuser(c.id)}>Refuser</button>
          </div>
        </div>
      ))}
      {mesAppels.map((a) => (
        <div key={a.id} className="carte border-2 border-marque bg-marque-tint p-3">
          <div className="font-bold text-marque-fonce">Table {a.table_numero} — {LIBELLES_APPEL[a.type]}</div>
          <button type="button" className="btn-blanc mt-2 min-h-[44px] w-full" onClick={() => traiterAppel(a.id)}>C’est fait</button>
        </div>
      ))}
    </div>
  );
}
