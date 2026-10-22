import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconBell, IconBellOff, IconCheck, IconChefHat, IconHandStop, IconX } from '@tabler/icons-react';
import type { AppelVue, SessionInfo } from '@pos/shared';
import { LIBELLES_APPEL } from '@pos/shared';
import { api, evenementToucheStock } from '@pos/shared-ui';
import { arreterSonnerie, DUREE_SONNERIE_S, sonner } from '../sonnerie';

interface NotifPrete {
  commande_id: string;
  table_numero: string | null;
}

const sonAValider = new Audio('/sons/a-valider.wav');

/**
 * Centre de notifications du serveur (CORRECTIONS3 points 1 & 2). Tient aussi
 * la connexion WebSocket qui envoie le battement de cœur — indispensable à la
 * présence côté serveur (routage des appels/commandes). Sons distincts :
 * « à valider / appel » vs « commande prête ».
 */
export function NotificationsServeur({ session, afficherToast }: { session: SessionInfo; afficherToast: (m: string) => void }) {
  const moi = session.utilisateur.id;
  const queryClient = useQueryClient();

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

  /**
   * Pastilles « prête » : la liste vient du SERVEUR, pas d'un état local. Si la
   * cuisine ou la caisse sert la commande, la pastille disparaît d'elle-même —
   * avant, elle restait affichée jusqu'au rechargement de la page.
   */
  const { data: pretesServeur } = useQuery({
    queryKey: ['pretes'],
    queryFn: () => api<NotifPrete[]>('/api/commandes/pretes'),
    refetchInterval: 15_000,
  });

  /**
   * Sonnerie « commande prête » : au moins 10 s, jusqu'à « Servie » ou
   * « Arrêter ». Une commande ne fait sonner qu'UNE fois par écran ouvert.
   * Elle part sur le message temps réel ET sur la liste relue toutes les 15 s :
   * un message perdu pendant une coupure Wi-Fi ne laisse plus un plat muet.
   */
  const [sonneEnCours, setSonneEnCours] = useState(false);
  const sonnees = useRef(new Set<string>());
  const minuteurSonnerie = useRef<ReturnType<typeof setTimeout> | null>(null);
  const faireSonner = (commandeId: string) => {
    if (sonnees.current.has(commandeId)) return;
    sonnees.current.add(commandeId);
    sonner();
    setSonneEnCours(true);
    if (minuteurSonnerie.current) clearTimeout(minuteurSonnerie.current);
    minuteurSonnerie.current = setTimeout(() => setSonneEnCours(false), DUREE_SONNERIE_S * 1000);
  };
  const couperSonnerie = () => {
    arreterSonnerie();
    setSonneEnCours(false);
  };
  useEffect(() => {
    const ids = (pretesServeur ?? []).map((p) => p.commande_id);
    for (const id of ids) faireSonner(id);
    // Servie ailleurs (caisse, cuisine) : plus rien à annoncer.
    if (pretesServeur && ids.length === 0) couperSonnerie();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pretesServeur]);
  useEffect(() => () => {
    arreterSonnerie();
    if (minuteurSonnerie.current) clearTimeout(minuteurSonnerie.current);
  }, []);

  const mesAppels = (appels ?? []).filter((a) => a.cible === 'SERVEUR' && a.serveur_id === moi);
  const mesValidations = (aValider ?? []).filter((c) => !c.serveur_id || c.serveur_id === moi);
  const pretes = pretesServeur ?? [];

  const rafraichir = () => {
    void queryClient.invalidateQueries({ queryKey: ['appels-en-attente'] });
    void queryClient.invalidateQueries({ queryKey: ['a-valider'] });
    void queryClient.invalidateQueries({ queryKey: ['pretes'] });
    void queryClient.invalidateQueries({ queryKey: ['tables'] });
  };

  // WebSocket + heartbeat (présence)
  const dejaVus = useRef(new Set<string>());
  useEffect(() => {
    let socket: WebSocket | null = null;
    let arrete = false;
    let battement: ReturnType<typeof setInterval> | null = null;
    let minuteurStock: ReturnType<typeof setTimeout> | null = null;

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
          if (typeof m.commande_id === 'string') faireSonner(m.commande_id);
          rafraichir();
        }
        // Servie / encaissée / annulée / modifiée : on relit la liste des
        // commandes prêtes au lieu de deviner ce qui a changé.
        if (type === 'commande:servie' || type === 'commande' || type === 'commande:modifiee') rafraichir();
        if (typeof type === 'string' && type.startsWith('table')) void queryClient.invalidateQueries({ queryKey: ['tables'] });
        // Stock sous la photo des plats : relu une fois la rafale retombée.
        if (typeof type === 'string' && evenementToucheStock(type)) {
          if (minuteurStock) clearTimeout(minuteurStock);
          minuteurStock = setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['stock-plats'] }), 800);
        }
      };
      socket.onclose = () => {
        if (battement) clearInterval(battement);
        if (!arrete) setTimeout(connecter, 2000);
      };
    };
    connecter();
    return () => { arrete = true; if (battement) clearInterval(battement); if (minuteurStock) clearTimeout(minuteurStock); socket?.close(); };
  }, [moi]);

  const valider = async (id: string) => { try { await api(`/api/commandes/${id}/valider`, { method: 'POST', corps: {} }); rafraichir(); } catch (e) { afficherToast((e as Error).message); } };
  const refuser = async (id: string) => {
    const motif = window.prompt('Motif du refus (montré au client) :');
    if (!motif) return;
    try { await api(`/api/commandes/${id}/refuser`, { method: 'POST', corps: { motif } }); rafraichir(); } catch (e) { afficherToast((e as Error).message); }
  };
  const traiterAppel = async (id: string) => { try { await api(`/api/appels/${id}/traiter`, { method: 'POST', corps: {} }); rafraichir(); } catch (e) { afficherToast((e as Error).message); } };
  const servir = async (id: string) => {
    couperSonnerie();
    try { await api(`/api/commandes/${id}/servir`, { method: 'POST', corps: {} }); rafraichir(); }
    catch (e) { afficherToast((e as Error).message); }
  };

  const rien = mesAppels.length === 0 && mesValidations.length === 0 && pretes.length === 0;
  if (rien) return null;

  return (
    <div className="au-dessus-barre fixed left-2 right-2 z-[55] max-h-[45dvh] space-y-2 overflow-y-auto sm:left-auto sm:right-4 sm:w-80">
      {sonneEnCours && pretes.length > 0 && (
        <button
          type="button"
          onClick={couperSonnerie}
          className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-btn bg-ard-800 font-bold text-ard-txt shadow-ard"
        >
          <IconBellOff size={20} /> Arrêter la sonnerie
        </button>
      )}
      {pretes.map((p) => (
        <Notification
          key={p.commande_id}
          couleur="var(--ok)"
          icone={<IconChefHat size={20} />}
          titre={`Table ${p.table_numero ?? '—'}`}
          texte="Commande prête"
          action={
            <button type="button" className="btn-ok flex min-h-[48px] items-center justify-center gap-1.5 px-4" onClick={() => servir(p.commande_id)}>
              <IconCheck size={18} stroke={3} /> Servie
            </button>
          }
        />
      ))}
      {mesValidations.map((c) => (
        <Notification key={c.id} couleur="var(--info)" icone={<IconHandStop size={20} />} titre={`Table ${c.table_numero ?? '—'}`} texte="Commande client à valider">
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-ok flex min-h-[48px] flex-1 items-center justify-center gap-1.5" onClick={() => valider(c.id)}>
              <IconCheck size={18} stroke={3} /> Valider
            </button>
            <button type="button" className="btn-blanc flex min-h-[48px] flex-1 items-center justify-center gap-1.5 text-alerte-txt" onClick={() => refuser(c.id)}>
              <IconX size={18} /> Refuser
            </button>
          </div>
        </Notification>
      ))}
      {mesAppels.map((a) => (
        <Notification
          key={a.id}
          couleur="var(--marque)"
          icone={<IconBell size={20} />}
          titre={`Table ${a.table_numero ?? '—'}`}
          texte={LIBELLES_APPEL[a.type]}
          action={
            <button type="button" className="btn-blanc flex min-h-[48px] items-center justify-center gap-1.5 px-3" onClick={() => traiterAppel(a.id)}>
              <IconCheck size={18} /> Fait
            </button>
          }
        />
      ))}
    </div>
  );
}

/**
 * Une notification : carte blanche, liseré et icône de la couleur de son
 * sens (prête = vert, à valider = bleu, appel = marque). Fini les grands
 * aplats teintés : la couleur informe, elle ne repeint pas la carte.
 * Une action unique (`action`) tient sur la même ligne que la table : la pile
 * reste basse et ne cache pas la commande en cours de saisie.
 */
function Notification({
  couleur,
  icone,
  titre,
  texte,
  action,
  children,
}: {
  couleur: string;
  icone: ReactNode;
  titre: string;
  texte: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="carte relative overflow-hidden p-3 pl-4 shadow-e2" style={{ borderLeft: `4px solid ${couleur}` }}>
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-9 w-9 flex-none items-center justify-center rounded-full"
          style={{ background: `color-mix(in srgb, ${couleur} 14%, var(--carte))`, color: couleur }}
        >
          {icone}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-bold leading-tight text-txt">{titre}</div>
          <div className="truncate text-sm text-txt-doux">{texte}</div>
        </div>
        {action && <div className="flex-none">{action}</div>}
      </div>
      {children}
    </div>
  );
}
