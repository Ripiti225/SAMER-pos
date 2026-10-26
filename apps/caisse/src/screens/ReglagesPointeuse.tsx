/**
 * Réglages › Pointeuse (2026-10-26) : les présences viennent de la pointeuse
 * Hikvision. Ici : son adresse sur le réseau du restaurant, l'état de la
 * lecture, et le n° de chaque employé dans l'appareil.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

interface VuePointeuse {
  config: { url: string; utilisateur: string; mot_de_passe_defini: boolean; par_environnement: boolean };
  etat: { configuree: boolean; appareil: string | null; modele: string | null; derniere_lecture: string | null; derniere_erreur: string | null };
  employes: { id: string; nom_complet: string; pointeuse_no: string | null }[];
  inconnus: { employe_no: string; nom_appareil: string | null; nb: number; dernier: string }[];
  derniers: { id: string; employe_no: string; nom: string; sens: 'ENTREE' | 'SORTIE'; pointe_le: string; statut: string }[];
}

interface ResultatEnvoi {
  envoyes: number;
  attribues: number;
  visages: number;
  a_enroler: { nom: string; numero: string; raison: string }[];
  echecs: { nom: string; erreur: string }[];
}

const LIBELLES_STATUT: Record<string, string> = {
  APPLIQUE: 'Reporté',
  EN_ATTENTE: 'En attente du shift',
  INCONNU: 'N° inconnu',
  IGNORE: 'Sans effet',
};

const heure = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function Pointeuse() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const { data } = useQuery({
    queryKey: ['admin', 'pointeuse'],
    queryFn: () => api<VuePointeuse>('/api/admin/pointeuse'),
    refetchInterval: 20000,
  });
  const [url, setUrl] = useState<string | null>(null);
  const [utilisateur, setUtilisateur] = useState<string | null>(null);
  const [motDePasse, setMotDePasse] = useState('');
  const rafraichir = () => void qc.invalidateQueries({ queryKey: ['admin', 'pointeuse'] });

  const enregistrer = useMutation({
    mutationFn: () =>
      api<{ appareil: { numero_serie: string; modele: string | null } | null }>('/api/admin/pointeuse', {
        method: 'PUT',
        corps: {
          url: url ?? data?.config.url ?? '',
          utilisateur: utilisateur ?? data?.config.utilisateur ?? 'admin',
          ...(motDePasse ? { mot_de_passe: motDePasse } : {}),
        },
      }),
    onSuccess: (r) => {
      setMotDePasse('');
      setMsg(r.appareil
        ? { texte: `Pointeuse connectée : ${r.appareil.modele ?? 'Hikvision'} (n° ${r.appareil.numero_serie})`, ok: true }
        : { texte: 'Pointeuse retirée : l’équipe se coche de nouveau à la main à l’ouverture', ok: true });
      rafraichir();
    },
    onError: (e: Error) => { setMsg({ texte: e.message }); rafraichir(); },
  });
  const lire = useMutation({
    mutationFn: () => api<{ nouveaux: number }>('/api/admin/pointeuse/lire', { method: 'POST' }),
    onSuccess: (r) => { setMsg({ texte: `${r.nouveaux} nouveau(x) pointage(s) lu(s)`, ok: true }); rafraichir(); },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const [aEnroler, setAEnroler] = useState<ResultatEnvoi['a_enroler']>([]);
  const envoyer = useMutation({
    mutationFn: () => api<ResultatEnvoi>('/api/admin/pointeuse/envoyer-equipe', { method: 'POST' }),
    onSuccess: (r) => {
      setAEnroler(r.a_enroler);
      setMsg({
        texte: `${r.envoyes} employé(s) envoyé(s) à la pointeuse, ${r.visages} visage(s) enregistré(s) depuis leur photo`
          + (r.attribues ? `, ${r.attribues} nouveau(x) n°` : '')
          + (r.echecs.length ? ` — échec pour : ${r.echecs.map((e) => e.nom).join(', ')}` : ''),
        ok: r.echecs.length === 0,
      });
      rafraichir();
    },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const numeroter = useMutation({
    mutationFn: (v: { id: string; pointeuse_no: string | null }) =>
      api<{ pointages_rattrapes: number }>(`/api/admin/pointeuse/employes/${v.id}`, {
        method: 'PATCH', corps: { pointeuse_no: v.pointeuse_no },
      }),
    onSuccess: (r) => {
      setMsg({ texte: r.pointages_rattrapes ? `Enregistré — ${r.pointages_rattrapes} pointage(s) récupéré(s)` : 'Enregistré', ok: true });
      rafraichir();
    },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });

  if (!data) return <p className="text-doux">Chargement…</p>;
  const { config, etat } = data;

  return (
    <section className="max-w-3xl">
      <h2 className="mb-4 text-xl font-bold">Pointeuse</h2>
      {msg && (
        <div className={`mb-4 rounded-jeton px-4 py-3 ${msg.ok ? 'bg-ok-tint text-ok-txt' : 'bg-alerte-tint text-alerte-txt'}`}>
          {msg.texte}
        </div>
      )}
      <p className="mb-4 text-sm text-doux">
        Les arrivées et les sorties se pointent sur la pointeuse (touches <b>Entrée</b> / <b>Sortie</b>). Le POS
        la lit toutes les 20 secondes. À « J’ai fini », la caisse demande « reste ou part » pour chaque
        personne qui n’a pas pointé sa sortie.
      </p>

      <div className="mb-4 rounded-jeton border border-bordure bg-surface p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="font-semibold">Appareil</div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${
            !etat.configuree ? 'bg-surface-douce text-doux' : etat.derniere_erreur ? 'bg-alerte-tint text-alerte-txt' : 'bg-ok-tint text-ok-txt'
          }`}>
            {!etat.configuree ? 'Non configurée' : etat.derniere_erreur ? 'Injoignable' : 'Connectée'}
          </span>
        </div>
        {etat.derniere_erreur && <p className="mb-3 text-sm text-alerte-txt">{etat.derniere_erreur}</p>}
        {etat.appareil && (
          <p className="mb-3 text-sm text-doux">
            {etat.modele ?? 'Hikvision'} · n° de série {etat.appareil}
            {etat.derniere_lecture ? ` · lue à ${new Date(etat.derniere_lecture).toLocaleTimeString('fr-FR')}` : ''}
          </p>
        )}
        {config.par_environnement ? (
          <p className="text-sm text-doux">Réglée sur ce poste par le fichier .env ({config.url}).</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-doux">Adresse IP</span>
              <input className="champ w-full" placeholder="192.168.1.50" value={url ?? config.url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-doux">Utilisateur</span>
              <input className="champ w-full" value={utilisateur ?? config.utilisateur} onChange={(e) => setUtilisateur(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-doux">Mot de passe</span>
              <input
                className="champ w-full"
                type="password"
                placeholder={config.mot_de_passe_defini ? '•••••• (inchangé)' : ''}
                value={motDePasse}
                onChange={(e) => setMotDePasse(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {!config.par_environnement && (
            <button type="button" className="btn-accent" disabled={enregistrer.isPending} onClick={() => enregistrer.mutate()}>
              {enregistrer.isPending ? 'Connexion…' : 'Enregistrer et tester'}
            </button>
          )}
          <button type="button" className="btn-blanc" disabled={!etat.configuree || lire.isPending} onClick={() => lire.mutate()}>
            {lire.isPending ? 'Lecture…' : 'Lire maintenant'}
          </button>
          <button type="button" className="btn-blanc" disabled={!etat.configuree || envoyer.isPending} onClick={() => envoyer.mutate()}>
            {envoyer.isPending ? 'Envoi…' : 'Envoyer l’équipe à la pointeuse'}
          </button>
        </div>
      </div>

      {aEnroler.length > 0 && (
        <div className="mb-4 rounded-jeton bg-attente-tint px-4 py-3 text-sm text-attente-txt">
          <b>À enrôler sur la pointeuse</b> (Utilisateur › n° › Visage, ou Empreinte si le visage ne passe pas) :
          <ul className="mt-1 list-disc pl-5">
            {aEnroler.map((p) => (
              <li key={p.numero}>n° {p.numero} · {p.nom} — {p.raison}</li>
            ))}
          </ul>
        </div>
      )}

      {data.inconnus.length > 0 && (
        <div className="mb-4 rounded-jeton bg-attente-tint px-4 py-3 text-sm text-attente-txt">
          <b>Numéros pointés mais inconnus du POS</b> — renseignez-les ci-dessous : leurs pointages des 16 dernières
          heures seront récupérés.
          <ul className="mt-1 list-disc pl-5">
            {data.inconnus.map((i) => (
              <li key={i.employe_no}>
                n° {i.employe_no}{i.nom_appareil ? ` (${i.nom_appareil})` : ''} · {i.nb} pointage(s), dernier le {heure(i.dernier)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 rounded-jeton border border-bordure bg-surface p-4">
        <div className="mb-1 font-semibold">N° des employés dans la pointeuse</div>
        <p className="mb-3 text-sm text-doux">
          Le « N° employé » affiché par l’appareil. « Envoyer l’équipe » attribue les numéros manquants, crée
          les fiches sur la pointeuse et y enregistre le visage de chacun à partir de sa photo SamerTrackly.
        </p>
        <div className="grid gap-2">
          {data.employes.map((e) => (
            <LigneNumero key={e.id} employe={e} onEnregistrer={(no) => numeroter.mutate({ id: e.id, pointeuse_no: no })} />
          ))}
        </div>
      </div>

      <div className="rounded-jeton border border-bordure bg-surface p-4">
        <div className="mb-3 font-semibold">Derniers pointages</div>
        {data.derniers.length === 0 && <p className="text-sm text-doux">Aucun pointage lu pour l’instant.</p>}
        <div className="grid gap-1 text-sm">
          {data.derniers.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 border-b border-bordure py-1.5 last:border-0">
              <span className="min-w-0 truncate">
                <b>{d.nom || `n° ${d.employe_no}`}</b> · {d.sens === 'ENTREE' ? 'Entrée' : 'Sortie'}
              </span>
              <span className="flex-none text-doux">
                {heure(d.pointe_le)} · {LIBELLES_STATUT[d.statut] ?? d.statut}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LigneNumero({ employe, onEnregistrer }: {
  employe: { nom_complet: string; pointeuse_no: string | null };
  onEnregistrer: (no: string | null) => void;
}) {
  const [v, setV] = useState(employe.pointeuse_no ?? '');
  useEffect(() => setV(employe.pointeuse_no ?? ''), [employe.pointeuse_no]);
  const change = v.trim() !== (employe.pointeuse_no ?? '');
  return (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate">{employe.nom_complet}</span>
      <input
        className="champ w-28"
        inputMode="numeric"
        placeholder="—"
        value={v}
        onChange={(e) => setV(e.target.value.replace(/\D/g, ''))}
      />
      <button type="button" className="btn-blanc w-28" disabled={!change} onClick={() => onEnregistrer(v.trim() || null)}>
        Enregistrer
      </button>
    </div>
  );
}
