import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowLeft, IconLock } from '@tabler/icons-react';
import { DISPONIBILITES, type Disponibilite, LIBELLES_DISPONIBILITE, SECTIONS_PERMISSIONS, PERMISSION_PROTEGEE, type SessionInfo } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { useCaisse } from '../stores/session';

/** Espace Administration (sprint 4C). Sections visibles selon les permissions. */
export function Reglages() {
  const { session, rentrer } = useCaisse();
  const perms = session?.permissions ?? [];
  const a = (cle: string) => perms.includes(cle);

  const sections = useMemo(
    () =>
      [
        { cle: 'reglages.equipe', libelle: 'Équipe', rendu: () => <Equipe /> },
        { cle: 'reglages.salle', libelle: 'Salle & QR', rendu: () => <Salle /> },
        { cle: 'reglages.disponibilite', libelle: 'Plats du jour', rendu: () => <Disponibilite /> },
        { cle: 'reglages.catalogue', libelle: 'Catalogue', rendu: () => <Catalogue /> },
        { cle: 'reglages.fidelite', libelle: 'Fidélité', rendu: () => <Fidelite /> },
        { cle: 'reglages.parametres', libelle: 'Paramètres', rendu: () => <Parametres /> },
        { cle: 'reglages.restaurant', libelle: 'Restaurant', rendu: () => <ConfigRestaurant /> },
        { cle: 'reglages.audit', libelle: "Journal d'audit", rendu: () => <Audit /> },
        { cle: 'roles.gerer', libelle: 'Rôles & accès', rendu: () => <Roles /> },
      ].filter((s) => a(s.cle)),
    [perms.join(',')],
  );

  const [active, setActive] = useState(sections[0]?.cle ?? '');
  const sectionActive = sections.find((s) => s.cle === active) ?? sections[0];

  return (
    <div className="flex min-h-full flex-col bg-fond p-6">
      <header className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={rentrer}
          title="Retour"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-surface-douce text-doux transition hover:bg-marque-tint hover:text-marque-fonce"
        >
          <IconArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-marque-fonce">Réglages</h1>
      </header>

      <div className="flex flex-1 gap-6">
        <nav className="flex w-56 shrink-0 flex-col gap-1">
          {sections.map((s) => (
            <button
              key={s.cle}
              type="button"
              className={`rounded-[13px] px-4 py-3 text-left text-lg font-semibold transition ${
                s.cle === sectionActive?.cle ? 'bg-marque text-sur-marque shadow-e1' : 'text-doux hover:bg-marque-tint hover:text-marque-fonce'
              }`}
              onClick={() => setActive(s.cle)}
            >
              {s.libelle}
            </button>
          ))}
        </nav>
        <main className="flex-1 overflow-auto">{sectionActive?.rendu()}</main>
      </div>
    </div>
  );
}

/** Petit bandeau d'erreur/succès. */
function Message({ texte, ok }: { texte: string | null; ok?: boolean }) {
  if (!texte) return null;
  return (
    <div className={`mb-4 rounded-xl px-4 py-3 ${ok ? 'bg-emerald-100 text-emerald-900' : 'bg-red-100 text-red-900'}`}>
      {texte}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Équipe
// ---------------------------------------------------------------------------
interface Employe {
  id: string;
  nom_complet: string;
  role_id: string | null;
  role_nom: string | null;
  poste: string | null;
  photo_url: string | null;
  disponibilite: Disponibilite;
  telephone: string | null;
  actif: boolean;
  doit_definir_pin: boolean;
  derniere_presence: string | null;
}

/** Pastille de couleur par disponibilité. */
const COULEUR_DISPO: Record<Disponibilite, string> = {
  PRESENT: 'bg-ok-tint text-ok',
  MALADE: 'bg-alerte-tint text-alerte',
  CONGE: 'bg-info-tint text-info',
  PERMISSION: 'bg-marque-tint text-marque-fonce',
};

/** Avatar employé : photo si disponible, sinon initiales (repli si l'URL casse). */
function AvatarEmploye({ nom, photo }: { nom: string; photo: string | null }) {
  const [casse, setCasse] = useState(false);
  const initiales = nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('');
  if (photo && !casse) {
    return (
      <img
        src={photo}
        alt=""
        loading="lazy"
        onError={() => setCasse(true)}
        className="h-12 w-12 flex-none rounded-xl border border-bordure object-cover"
      />
    );
  }
  return (
    <div className="flex h-12 w-12 flex-none items-center justify-center rounded-xl bg-marque-tint text-sm font-bold text-marque-fonce">
      {initiales}
    </div>
  );
}
interface RoleAdmin {
  id: string;
  nom: string;
  systeme: boolean;
  actif: boolean;
  verrouille: boolean;
  permissions: string[];
  nb_employes: number;
}

function Equipe() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const [nouveau, setNouveau] = useState<{ nom_complet: string; role_id: string; telephone: string } | null>(null);
  const [code, setCode] = useState<string | null>(null);

  const { data: employes } = useQuery({ queryKey: ['admin', 'equipe'], queryFn: () => api<Employe[]>('/api/admin/equipe') });
  const { data: roles } = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<RoleAdmin[]>('/api/admin/roles').catch(() => [] as RoleAdmin[]) });

  const rolesActifs = (roles ?? []).filter((r) => r.actif);

  const creer = useMutation({
    mutationFn: (corps: Record<string, unknown>) => api<{ code_temporaire: string }>('/api/admin/equipe', { method: 'POST', corps }),
    onSuccess: (r) => {
      setCode(r.code_temporaire);
      setNouveau(null);
      void qc.invalidateQueries({ queryKey: ['admin', 'equipe'] });
    },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const reinit = useMutation({
    mutationFn: (id: string) => api<{ code_temporaire: string }>(`/api/admin/equipe/${id}/reinit-pin`, { method: 'POST' }),
    onSuccess: (r) => setCode(r.code_temporaire),
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const desactiver = useMutation({
    mutationFn: (id: string) => api(`/api/admin/equipe/${id}/desactiver`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'equipe'] }),
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const dispo = useMutation({
    mutationFn: ({ id, disponibilite }: { id: string; disponibilite: Disponibilite }) =>
      api(`/api/admin/equipe/${id}/disponibilite`, { method: 'POST', corps: { disponibilite } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'equipe'] }),
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const sync = useMutation({
    mutationFn: () => api<{ crees: number; maj: number; desactives: number; absents: number; total: number }>('/api/admin/equipe/synchroniser', { method: 'POST' }),
    onSuccess: (r) => {
      setMsg({ texte: `SamerTrackly : ${r.crees} ajouté(s) · ${r.maj} à jour · ${r.absents} en congé/absence · ${r.desactives} parti(s) (sur ${r.total}).`, ok: true });
      void qc.invalidateQueries({ queryKey: ['admin', 'equipe'] });
    },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const [edition, setEdition] = useState<Employe | null>(null);
  const modif = useMutation({
    mutationFn: ({ id, corps }: { id: string; corps: Record<string, unknown> }) =>
      api(`/api/admin/equipe/${id}`, { method: 'PATCH', corps }),
    onSuccess: () => {
      setEdition(null);
      setMsg({ texte: 'Fiche employé mise à jour', ok: true });
      void qc.invalidateQueries({ queryKey: ['admin', 'equipe'] });
    },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Équipe</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-blanc" disabled={sync.isPending} onClick={() => sync.mutate()}>
            {sync.isPending ? 'Synchronisation…' : 'Synchroniser (SamerTrackly)'}
          </button>
          <button type="button" className="btn-accent" onClick={() => setNouveau({ nom_complet: '', role_id: rolesActifs[0]?.id ?? '', telephone: '' })}>
            + Ajouter un employé
          </button>
        </div>
      </div>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />
      {code && (
        <div className="mb-4 rounded-xl bg-amber-100 px-4 py-3 text-amber-900">
          Code temporaire à communiquer à l’employé (une seule fois) : <b className="text-2xl tracking-widest">{code}</b>
          <button type="button" className="btn-blanc ml-3" onClick={() => setCode(null)}>OK</button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left align-middle">
          <thead className="text-sm text-doux">
            <tr><th className="py-2">Employé</th><th>Rôle</th><th>Disponibilité</th><th>État</th><th></th></tr>
          </thead>
          <tbody>
            {(employes ?? []).map((e) => (
              <tr key={e.id} className="border-t border-bordure">
                <td className="py-3">
                  <div className="flex items-center gap-3">
                    <AvatarEmploye nom={e.nom_complet} photo={e.photo_url} />
                    <div className="min-w-0">
                      <div className="font-semibold">{e.nom_complet}</div>
                      <div className="truncate text-xs text-doux">{[e.poste, e.telephone].filter(Boolean).join(' · ') || '—'}</div>
                    </div>
                  </div>
                </td>
                <td className="text-sm">{e.role_nom ?? '—'}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${COULEUR_DISPO[e.disponibilite]}`}>
                      {LIBELLES_DISPONIBILITE[e.disponibilite]}
                    </span>
                    <select
                      className="rounded-lg border border-bordure bg-surface px-2 py-1.5 text-sm"
                      value={e.disponibilite}
                      disabled={!e.actif}
                      onChange={(ev) => dispo.mutate({ id: e.id, disponibilite: ev.target.value as Disponibilite })}
                    >
                      {DISPONIBILITES.map((d) => <option key={d} value={d}>{LIBELLES_DISPONIBILITE[d]}</option>)}
                    </select>
                  </div>
                </td>
                <td className="text-sm">
                  {!e.actif ? <span className="text-alerte">Désactivé</span> : e.doit_definir_pin ? <span className="text-marque-fonce">PIN à définir</span> : <span className="text-ok">Actif</span>}
                </td>
                <td className="text-right">
                  {e.actif && (
                    <div className="flex flex-wrap justify-end gap-2">
                      <button type="button" className="btn-blanc" onClick={() => setEdition(e)}>Modifier</button>
                      <button type="button" className="btn-blanc" onClick={() => reinit.mutate(e.id)}>Réinit. PIN</button>
                      <button type="button" className="btn-blanc" onClick={() => desactiver.mutate(e.id)}>Désactiver</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nouveau && (
        <div className="mt-4 rounded-xl border border-bordure p-4">
          <h3 className="mb-3 font-bold">Nouvel employé</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <input className="champ" placeholder="Nom complet" value={nouveau.nom_complet} onChange={(ev) => setNouveau({ ...nouveau, nom_complet: ev.target.value })} />
            <select className="champ" value={nouveau.role_id} onChange={(ev) => setNouveau({ ...nouveau, role_id: ev.target.value })}>
              {rolesActifs.map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
            </select>
            <input className="champ" placeholder="Téléphone (optionnel)" value={nouveau.telephone} onChange={(ev) => setNouveau({ ...nouveau, telephone: ev.target.value })} />
          </div>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-accent" onClick={() => creer.mutate({ nom_complet: nouveau.nom_complet, role_id: nouveau.role_id, telephone: nouveau.telephone || undefined })}>Créer</button>
            <button type="button" className="btn-blanc" onClick={() => setNouveau(null)}>Annuler</button>
          </div>
          <p className="mt-2 text-sm text-doux">L’employé saisira lui-même son PIN avec le code temporaire.</p>
        </div>
      )}

      {edition && (
        <EditionEmploye
          employe={edition}
          roles={rolesActifs}
          enCours={modif.isPending}
          onFermer={() => setEdition(null)}
          onEnregistrer={(corps) => modif.mutate({ id: edition.id, corps })}
        />
      )}
    </section>
  );
}

/** Formulaire de modification d'un employé (nom, rôle, poste, téléphone, photo). */
function EditionEmploye({
  employe,
  roles,
  enCours,
  onFermer,
  onEnregistrer,
}: {
  employe: Employe;
  roles: RoleAdmin[];
  enCours: boolean;
  onFermer: () => void;
  onEnregistrer: (corps: Record<string, unknown>) => void;
}) {
  const [nom, setNom] = useState(employe.nom_complet);
  const [roleId, setRoleId] = useState(employe.role_id ?? '');
  const [poste, setPoste] = useState(employe.poste ?? '');
  const [tel, setTel] = useState(employe.telephone ?? '');
  const [photo, setPhoto] = useState(employe.photo_url ?? '');
  const { data: postes } = useQuery({ queryKey: ['admin', 'postes'], queryFn: () => api<string[]>('/api/admin/postes') });

  return (
    <Modale titre={`Modifier ${employe.nom_complet}`} onFermer={onFermer} enfants={
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <AvatarEmploye nom={nom || employe.nom_complet} photo={photo || null} />
          <div className="text-sm text-doux">Aperçu de la photo</div>
        </div>
        <label className="block text-sm text-doux">Nom complet
          <input className="champ mt-1" value={nom} onChange={(e) => setNom(e.target.value)} />
        </label>
        <label className="block text-sm text-doux">Rôle
          <select className="champ mt-1" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.nom}</option>)}
          </select>
        </label>
        <label className="block text-sm text-doux">Intitulé de poste
          <input className="champ mt-1" list="postes-suggestions" value={poste} onChange={(e) => setPoste(e.target.value)} placeholder="ex : Comptoiriste, Chef cuisinier…" />
          <datalist id="postes-suggestions">
            {(postes ?? []).map((p) => <option key={p} value={p} />)}
          </datalist>
          <span className="mt-1 block text-xs text-doux">Choisir un poste existant (SamerTrackly) ou en saisir un nouveau.</span>
        </label>
        <label className="block text-sm text-doux">Téléphone
          <input className="champ mt-1" value={tel} onChange={(e) => setTel(e.target.value)} placeholder="ex : 0700000000" />
        </label>
        <label className="block text-sm text-doux">Photo (URL)
          <input className="champ mt-1" value={photo} onChange={(e) => setPhoto(e.target.value)} placeholder="https://…" />
        </label>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="btn-accent flex-1"
            disabled={enCours || nom.trim().length < 2 || !roleId}
            onClick={() => onEnregistrer({
              nom_complet: nom.trim(),
              role_id: roleId,
              poste: poste.trim(),
              telephone: tel.trim() || undefined,
              photo_url: photo.trim(),
            })}
          >
            {enCours ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <button type="button" className="btn-blanc" onClick={onFermer}>Annuler</button>
        </div>
      </div>
    } />
  );
}

// ---------------------------------------------------------------------------
// Salle & QR
// ---------------------------------------------------------------------------
interface ZoneAdmin {
  id: string;
  nom: string;
  ordre: number;
  tables: { id: string; numero: string; partenaire: string | null; statut: string; actif: boolean; qr_token: string | null }[];
}

interface TableAdmin { id: string; numero: string; partenaire: string | null; statut: string; actif: boolean; qr_token: string | null }

function Salle() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const { data: zones } = useQuery({ queryKey: ['admin', 'salle'], queryFn: () => api<ZoneAdmin[]>('/api/admin/salle') });
  const [nomZone, setNomZone] = useState('');
  const [qrTable, setQrTable] = useState<TableAdmin | null>(null);
  const [confirmTout, setConfirmTout] = useState(false);

  const invalider = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'salle'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'table-qr'] });
  };
  const regenTout = useMutation({
    mutationFn: () => api<{ nombre: number }>('/api/admin/tables/regenerer-qr', { method: 'POST' }),
    onSuccess: (r) => { setConfirmTout(false); setMsg(`${r.nombre} QR régénérés — réimprimez-les, les anciens ne fonctionnent plus.`); invalider(); },
    onError: (e: Error) => { setConfirmTout(false); setMsg(e.message); },
  });
  const creerZone = useMutation({ mutationFn: () => api('/api/admin/zones', { method: 'POST', corps: { nom: nomZone } }), onSuccess: () => { setNomZone(''); invalider(); }, onError: (e: Error) => setMsg(e.message) });
  const creerTable = useMutation({ mutationFn: (v: { zone_id: string; numero: string }) => api('/api/admin/tables', { method: 'POST', corps: v }), onSuccess: invalider, onError: (e: Error) => setMsg(e.message) });
  const desactiver = useMutation({ mutationFn: (id: string) => api(`/api/admin/tables/${id}`, { method: 'PATCH', corps: { actif: false } }), onSuccess: invalider, onError: (e: Error) => setMsg(e.message) });
  const reactiver = useMutation({ mutationFn: (id: string) => api(`/api/admin/tables/${id}`, { method: 'PATCH', corps: { actif: true } }), onSuccess: invalider, onError: (e: Error) => setMsg(e.message) });

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Salle & QR</h2>
        <div className="flex flex-wrap gap-2">
          {confirmTout ? (
            <>
              <button type="button" className="btn-accent" disabled={regenTout.isPending} onClick={() => regenTout.mutate()}>
                {regenTout.isPending ? 'Régénération…' : 'Confirmer : tout régénérer'}
              </button>
              <button type="button" className="btn-blanc" disabled={regenTout.isPending} onClick={() => setConfirmTout(false)}>Annuler</button>
            </>
          ) : (
            <button type="button" className="btn-blanc" onClick={() => { setMsg(null); setConfirmTout(true); }}>Régénérer tous les QR</button>
          )}
          <a className="btn-blanc" href="/api/admin/tables/qr.pdf" target="_blank" rel="noreferrer">Imprimer les QR</a>
        </div>
      </div>
      {confirmTout && (
        <p className="mb-3 text-sm text-amber-600">
          Tous les QR de toutes les tables vont changer. Les QR déjà imprimés et collés ne fonctionneront plus : il faudra les réimprimer.
        </p>
      )}
      <Message texte={msg} />
      <AdresseReseau />
      <div className="mb-4 flex gap-2">
        <input className="champ" placeholder="Nouvelle zone" value={nomZone} onChange={(e) => setNomZone(e.target.value)} />
        <button type="button" className="btn-accent" disabled={!nomZone} onClick={() => creerZone.mutate()}>Ajouter la zone</button>
      </div>
      <div className="grid gap-4">
        {(zones ?? []).map((z) => (
          <div key={z.id} className="rounded-xl border border-bordure p-4">
            <div className="mb-2 font-bold">{z.nom}</div>
            <div className="flex flex-wrap gap-2">
              {z.tables.map((t) => (
                <div key={t.id} className={`rounded-lg border border-bordure px-3 py-2 ${t.actif ? '' : 'opacity-50'}`}>
                  <div className="font-semibold">{t.numero}{!t.actif && <span className="ml-1 text-xs font-normal text-red-700">· désactivée</span>}</div>
                  <div className="flex gap-2">
                    <button type="button" className="text-xs underline" onClick={() => setQrTable(t)}>QR</button>
                    {t.actif ? (
                      <button type="button" className="text-xs text-red-700 underline" onClick={() => desactiver.mutate(t.id)}>Désactiver</button>
                    ) : (
                      <button type="button" className="text-xs text-marque-fonce underline" onClick={() => reactiver.mutate(t.id)}>Réactiver</button>
                    )}
                  </div>
                </div>
              ))}
              <AjoutTable onAjouter={(numero) => creerTable.mutate({ zone_id: z.id, numero })} />
            </div>
          </div>
        ))}
      </div>
      {qrTable && <QrModale table={qrTable} onFermer={() => setQrTable(null)} onRegenere={invalider} />}
    </section>
  );
}

/**
 * Bandeau : adresse réseau que les QR encodent réellement. Un téléphone doit
 * pouvoir l'atteindre sur le WiFi du restaurant — jamais `localhost`. L'IP LAN
 * est détectée automatiquement ; on prévient si aucun réseau n'est joignable.
 */
interface ReseauVue { ip_detectee: string | null; adresse_detectee: string | null; adresse_configuree: string; base_effective: string }
function AdresseReseau() {
  const { data } = useQuery({ queryKey: ['admin', 'reseau'], queryFn: () => api<ReseauVue>('/api/admin/reseau') });
  if (!data) return null;
  const local = /\/\/(localhost|127\.0\.0\.1)/.test(data.base_effective);

  if (local || !data.ip_detectee) {
    return (
      <div className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <div className="font-semibold text-amber-500">Les QR ne sont pas encore joignables depuis un téléphone</div>
        <p className="mt-1 text-doux">
          {data.ip_detectee
            ? <>Ce poste est sur le réseau <b>{data.ip_detectee}</b>, mais l’adresse configurée reste locale. Renseignez « Adresse web des QR clients » dans <b>Paramètres</b> avec <b>{data.adresse_detectee}</b>.</>
            : <>Aucun réseau local détecté : branchez le serveur au WiFi/réseau du restaurant pour que les QR fonctionnent sur les téléphones.</>}
        </p>
      </div>
    );
  }
  return (
    <div className="mb-4 rounded-xl border border-marque-fonce/40 bg-marque-fonce/10 px-4 py-3 text-sm">
      <div className="font-semibold text-marque-fonce">QR joignables sur le réseau local</div>
      <p className="mt-1 text-doux">
        Adresse encodée : <b className="break-all">{data.base_effective}</b>. Un téléphone connecté au même WiFi que le restaurant l’ouvrira en scannant le QR.
      </p>
      <p className="mt-1 text-xs text-doux">Astuce : pour que les QR imprimés restent valables, réservez une IP fixe pour ce poste sur la box (sinon l’adresse peut changer).</p>
    </div>
  );
}

/** Menu QR d'une table : affiche le code, l'adresse encodée, permet de régénérer. */
function QrModale({ table, onFermer, onRegenere }: { table: TableAdmin; onFermer: () => void; onRegenere: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['admin', 'table-qr', table.id],
    queryFn: () => api<{ qr_token: string; contenu: string; image: string }>(`/api/admin/tables/${table.id}/qr`),
  });
  const regen = useMutation({
    mutationFn: () => api<{ qr_token: string; contenu: string; image: string }>(`/api/admin/tables/${table.id}/regenerer-qr`, { method: 'POST' }),
    onSuccess: () => { setMsg('Nouveau QR généré — l’ancien code ne fonctionne plus.'); void refetch(); onRegenere(); },
    onError: (e: Error) => setMsg(e.message),
  });

  return (
    <Modale titre={`QR — Table ${table.numero}`} onFermer={onFermer} enfants={
      <div className="space-y-3 text-center">
        <Message texte={msg} />
        {isLoading && <p className="text-doux">Chargement du QR…</p>}
        {data && (
          <>
            <img src={data.image} alt={`QR de la table ${table.numero}`} className="mx-auto h-56 w-56 rounded-lg border border-bordure bg-white p-2" />
            <p className="break-all text-xs text-doux">{data.contenu}</p>
          </>
        )}
        <div className="flex gap-2">
          <a className="btn-blanc flex-1" href={`/api/admin/tables/qr.pdf`} target="_blank" rel="noreferrer">Imprimer (PDF)</a>
          <button type="button" className="btn-accent flex-1" disabled={regen.isPending} onClick={() => regen.mutate()}>
            {regen.isPending ? 'Génération…' : 'Régénérer le QR'}
          </button>
        </div>
      </div>
    } />
  );
}
function AjoutTable({ onAjouter }: { onAjouter: (numero: string) => void }) {
  const [numero, setNumero] = useState('');
  return (
    <div className="flex items-center gap-1">
      <input className="champ w-24" placeholder="N°" value={numero} onChange={(e) => setNumero(e.target.value)} />
      <button type="button" className="btn-blanc" disabled={!numero} onClick={() => { onAjouter(numero); setNumero(''); }}>+</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disponibilité (plats du jour)
// ---------------------------------------------------------------------------
interface ArticleDispo { id: string; nom: string; categorie: string | null; image_url: string | null; disponible: boolean }

function Disponibilite() {
  const qc = useQueryClient();
  const { data: arts } = useQuery({
    queryKey: ['admin', 'disponibilite'],
    queryFn: () => api<ArticleDispo[]>('/api/admin/disponibilite'),
  });
  const basculer = useMutation({
    mutationFn: (v: { id: string; disponible: boolean }) => api(`/api/admin/disponibilite/${v.id}`, { method: 'PATCH', corps: { disponible: v.disponible } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'disponibilite'] }),
  });

  // Regroupé par catégorie (ordre serveur conservé), comme le menu.
  const parCategorie: { categorie: string; articles: ArticleDispo[] }[] = [];
  for (const a of arts ?? []) {
    const nom = a.categorie ?? 'Autres';
    let groupe = parCategorie.find((g) => g.categorie === nom);
    if (!groupe) { groupe = { categorie: nom, articles: [] }; parCategorie.push(groupe); }
    groupe.articles.push(a);
  }

  return (
    <section>
      <h2 className="mb-1 text-xl font-bold">Plats du jour</h2>
      <p className="mb-4 text-sm text-doux">Touchez un plat pour le marquer épuisé ou de nouveau disponible.</p>
      <div className="space-y-6">
        {parCategorie.map((g) => (
          <div key={g.categorie}>
            <h3 className="mb-2 font-bold text-marque-fonce">{g.categorie}</h3>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
              {g.articles.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`carte relative flex flex-col overflow-hidden p-0 text-left transition ${a.disponible ? '' : 'opacity-60'}`}
                  onClick={() => basculer.mutate({ id: a.id, disponible: !a.disponible })}
                >
                  <div className="relative aspect-[4/3] w-full overflow-hidden bg-marque-tint">
                    {a.image_url ? (
                      <img src={a.image_url} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xl font-black text-marque-fonce/30">
                        {a.nom.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    {!a.disponible && (
                      <div className="absolute inset-0 flex items-center justify-center bg-fort/45">
                        <span className="rounded-full bg-alerte px-2.5 py-0.5 text-xs font-bold text-white">Épuisé</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-0.5 p-2">
                    <div className="line-clamp-2 text-sm font-semibold leading-tight">{a.nom}</div>
                    <div className={`text-xs font-bold ${a.disponible ? 'text-emerald-700' : 'text-red-700'}`}>
                      {a.disponible ? 'Disponible' : 'Épuisé'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Catalogue (lecture + bandeau ; édition via le cloud)
// ---------------------------------------------------------------------------
function Catalogue() {
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const { data } = useQuery({
    queryKey: ['admin', 'catalogue'],
    queryFn: () => api<{ articles: { id: string; nom: string; prix_base: number }[]; en_ligne: boolean; delai_message: string }>('/api/admin/catalogue'),
  });
  const editerPrix = useMutation({
    mutationFn: (v: { id: string; prix_base: number }) => api<{ message?: string }>('/api/admin/catalogue', { method: 'POST', corps: { entite: 'article', valeurs: v } }),
    onSuccess: (r) => setMsg({ texte: r.message ?? 'Enregistré', ok: true }),
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  return (
    <section>
      <h2 className="mb-2 text-xl font-bold">Catalogue</h2>
      <div className="mb-4 rounded-xl bg-blue-50 px-4 py-3 text-blue-900">
        {data?.delai_message ?? 'Les modifications du catalogue s’appliquent dans les 5 minutes.'}
        {data && !data.en_ligne && <div className="mt-1 text-red-700">Hors ligne : modification du menu impossible. La vente continue normalement.</div>}
      </div>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-doux"><tr><th className="py-2">Article</th><th>Prix (FCFA)</th><th></th></tr></thead>
          <tbody>
            {(data?.articles ?? []).map((art) => <LignePrix key={art.id} art={art} onEnregistrer={(prix) => editerPrix.mutate({ id: art.id, prix_base: prix })} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function LignePrix({ art, onEnregistrer }: { art: { id: string; nom: string; prix_base: number }; onEnregistrer: (prix: number) => void }) {
  const [prix, setPrix] = useState(String(art.prix_base));
  return (
    <tr className="border-t border-bordure">
      <td className="py-2 font-semibold">{art.nom}</td>
      <td><input className="champ w-28" value={prix} onChange={(e) => setPrix(e.target.value)} inputMode="numeric" /></td>
      <td><button type="button" className="btn-blanc" disabled={Number(prix) === art.prix_base || !prix} onClick={() => onEnregistrer(Number(prix))}>Enregistrer</button></td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Fidélité (barème)
// ---------------------------------------------------------------------------
function Fidelite() {
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const { data } = useQuery({ queryKey: ['admin', 'bareme'], queryFn: () => api<Record<string, unknown>>('/api/admin/fidelite/bareme') });
  const [valeur, setValeur] = useState('');
  const [seuil, setSeuil] = useState('');
  const enregistrer = useMutation({
    mutationFn: (corps: Record<string, unknown>) => api<{ message?: string }>('/api/admin/fidelite/bareme', { method: 'PUT', corps }),
    onSuccess: (r) => setMsg({ texte: r.message ?? 'Enregistré', ok: true }),
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  return (
    <section>
      <h2 className="mb-4 text-xl font-bold">Barème fidélité</h2>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />
      <div className="grid max-w-md gap-3">
        <label className="grid gap-1">Valeur d’un point (FCFA)
          <input className="champ" defaultValue={String(data?.valeur_point_fcfa ?? '')} onChange={(e) => setValeur(e.target.value)} inputMode="numeric" />
        </label>
        <label className="grid gap-1">Seuil d’utilisation (points)
          <input className="champ" defaultValue={String(data?.seuil_utilisation ?? '')} onChange={(e) => setSeuil(e.target.value)} inputMode="numeric" />
        </label>
        <button
          type="button"
          className="btn-accent"
          onClick={() => enregistrer.mutate({ ...(valeur ? { valeur_point_fcfa: Number(valeur) } : {}), ...(seuil ? { seuil_utilisation: Number(seuil) } : {}) })}
        >
          Enregistrer
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------
interface ParametreVue { cle: string; libelle: string; type: string; unite?: string; valeur: unknown }
function Parametres() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const { data } = useQuery({ queryKey: ['admin', 'parametres'], queryFn: () => api<ParametreVue[]>('/api/admin/parametres') });
  const maj = useMutation({
    mutationFn: (v: { cle: string; valeur: unknown }) => api('/api/admin/parametres', { method: 'PATCH', corps: v }),
    onSuccess: () => { setMsg({ texte: 'Enregistré', ok: true }); void qc.invalidateQueries({ queryKey: ['admin', 'parametres'] }); },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  return (
    <section>
      <h2 className="mb-4 text-xl font-bold">Paramètres</h2>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />
      <div className="grid gap-3">
        {(data ?? []).map((p) => <LigneParam key={p.cle} p={p} onEnregistrer={(v) => maj.mutate({ cle: p.cle, valeur: v })} />)}
      </div>
    </section>
  );
}
function LigneParam({ p, onEnregistrer }: { p: ParametreVue; onEnregistrer: (v: unknown) => void }) {
  const [v, setV] = useState(typeof p.valeur === 'object' ? JSON.stringify(p.valeur) : String(p.valeur ?? ''));
  const soumettre = () => {
    if (p.type === 'entier' || p.type === 'position') onEnregistrer(Number(v));
    else onEnregistrer(v);
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-bordure px-4 py-2">
      <div className="flex-1"><div className="font-semibold">{p.libelle}</div><div className="text-xs text-doux">{p.cle}{p.unite ? ` (${p.unite})` : ''}</div></div>
      <input className="champ w-40" value={v} onChange={(e) => setV(e.target.value)} />
      <button type="button" className="btn-blanc" onClick={soumettre}>OK</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Journal d'audit
// ---------------------------------------------------------------------------
interface LigneAudit { seq: number; created_at: string; action: string; entite: string; user_nom: string | null; motif: string | null }
function Audit() {
  const [action, setAction] = useState('');
  const { data } = useQuery({
    queryKey: ['admin', 'audit', action],
    queryFn: () => api<LigneAudit[]>(`/api/admin/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`),
  });
  return (
    <section>
      <h2 className="mb-4 text-xl font-bold">Journal d’audit</h2>
      <input className="champ mb-3 w-64" placeholder="Filtrer par action (ex : REMISE)" value={action} onChange={(e) => setAction(e.target.value.toUpperCase())} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-doux"><tr><th className="py-2">Quand</th><th>Action</th><th>Employé</th><th>Entité</th><th>Motif</th></tr></thead>
          <tbody>
            {(data ?? []).map((l) => (
              <tr key={l.seq} className="border-t border-bordure">
                <td className="py-1">{new Date(l.created_at).toLocaleString('fr-FR')}</td>
                <td className="font-semibold">{l.action}</td>
                <td>{l.user_nom ?? '—'}</td>
                <td>{l.entite}</td>
                <td>{l.motif ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rôles & accès
// ---------------------------------------------------------------------------
function Roles() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const { data: roles } = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<RoleAdmin[]>('/api/admin/roles') });
  const [edite, setEdite] = useState<RoleAdmin | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [nouveauNom, setNouveauNom] = useState('');

  const invalider = () => void qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
  const ouvrir = (r: RoleAdmin) => { setEdite(r); setSelection(new Set(r.permissions)); };
  const enregistrer = useMutation({
    mutationFn: () => api(`/api/admin/roles/${edite!.id}`, { method: 'PATCH', corps: { permissions: [...selection] } }),
    onSuccess: () => { setEdite(null); invalider(); },
    onError: (e: Error) => setMsg(e.message),
  });
  const creer = useMutation({
    mutationFn: () => api('/api/admin/roles', { method: 'POST', corps: { nom: nouveauNom, permissions: [] } }),
    onSuccess: () => { setNouveauNom(''); invalider(); },
    onError: (e: Error) => setMsg(e.message),
  });
  const dupliquer = useMutation({
    mutationFn: (r: RoleAdmin) => api(`/api/admin/roles/${r.id}/dupliquer`, { method: 'POST', corps: { nom: `${r.nom} (copie)` } }),
    onSuccess: invalider,
    onError: (e: Error) => setMsg(e.message),
  });
  const desactiver = useMutation({
    mutationFn: (r: RoleAdmin) => api(`/api/admin/roles/${r.id}/desactiver`, { method: 'POST' }),
    onSuccess: invalider,
    onError: (e: Error) => setMsg(e.message),
  });

  const bascule = (cle: string) => {
    const s = new Set(selection);
    if (s.has(cle)) s.delete(cle); else s.add(cle);
    setSelection(s);
  };

  return (
    <section>
      <h2 className="mb-4 text-xl font-bold">Rôles & accès</h2>
      <Message texte={msg} />
      {!edite && (
        <>
          <div className="mb-4 flex gap-2">
            <input className="champ" placeholder="Nouveau rôle" value={nouveauNom} onChange={(e) => setNouveauNom(e.target.value)} />
            <button type="button" className="btn-accent" disabled={!nouveauNom} onClick={() => creer.mutate()}>Créer un rôle</button>
          </div>
          <div className="grid gap-2">
            {(roles ?? []).map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-xl border border-bordure px-4 py-3">
                <div className="flex items-center gap-2">
                  {r.verrouille && <IconLock size={18} className="text-doux" />}
                  <span className="font-bold">{r.nom}</span>
                  <span className="text-sm text-doux">{r.nb_employes} employé(s){!r.actif ? ' · désactivé' : ''}</span>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-blanc" disabled={r.verrouille} onClick={() => ouvrir(r)}>Modifier</button>
                  <button type="button" className="btn-blanc" onClick={() => dupliquer.mutate(r)}>Dupliquer</button>
                  <button type="button" className="btn-blanc" disabled={r.verrouille || r.nb_employes > 0} onClick={() => desactiver.mutate(r)}>Désactiver</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {edite && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-lg font-bold">{edite.nom}</h3>
            <div className="flex gap-2">
              <button type="button" className="btn-accent" onClick={() => enregistrer.mutate()}>Enregistrer</button>
              <button type="button" className="btn-blanc" onClick={() => setEdite(null)}>Annuler</button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {SECTIONS_PERMISSIONS.map((sec) => (
              <div key={sec.cle} className="rounded-xl border border-bordure p-3">
                <div className="mb-2 font-bold">{sec.libelle}</div>
                {sec.permissions.map((p) => {
                  const protege = p.cle === PERMISSION_PROTEGEE;
                  return (
                    <label key={p.cle} className={`flex items-center gap-2 py-1 ${protege ? 'text-doux' : ''}`}>
                      <input type="checkbox" checked={selection.has(p.cle)} disabled={protege} onChange={() => bascule(p.cle)} />
                      {p.libelle}{protege && ' (réservé)'}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Configurer ce restaurant (déploiement multi-restaurants)
// ---------------------------------------------------------------------------
interface ConfigResto {
  actuel: { code: string; nom: string; marque: string; couleur_hex: string } | null;
  samtrackly_restaurant_id: string;
  restaurants: { id: string; nom: string; couleur: string | null }[];
}

function ConfigRestaurant() {
  const qc = useQueryClient();
  const { poserSession } = useCaisse();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const [choix, setChoix] = useState('');

  const { data } = useQuery({ queryKey: ['admin', 'restaurant-config'], queryFn: () => api<ConfigResto>('/api/admin/restaurant/config') });
  const selection = choix || data?.samtrackly_restaurant_id || '';

  const configurer = useMutation({
    mutationFn: (id: string) => api('/api/admin/restaurant/config', { method: 'POST', corps: { samtrackly_restaurant_id: id } }),
    onSuccess: async () => {
      // Applique la nouvelle identité (nom, marque, couleur) à la session en cours.
      try {
        poserSession(await api<SessionInfo>('/api/auth/moi'));
      } catch { /* ignore */ }
      // Synchronise l'équipe du restaurant choisi.
      let equipe = '';
      try {
        const r = await api<{ crees: number; maj: number }>('/api/admin/equipe/synchroniser', { method: 'POST' });
        equipe = ` · Équipe : ${r.crees} ajouté(s), ${r.maj} à jour.`;
      } catch { /* ignore */ }
      setMsg({ texte: `Restaurant configuré.${equipe}`, ok: true });
      void qc.invalidateQueries();
    },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });

  return (
    <section className="max-w-2xl space-y-4">
      <h2 className="text-xl font-bold">Restaurant de ce poste</h2>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />

      {data?.actuel && (
        <div className="carte flex items-center gap-3 p-4">
          <span className="h-9 w-9 flex-none rounded-full border border-bordure" style={{ background: data.actuel.couleur_hex }} />
          <div>
            <div className="font-bold">{data.actuel.nom}</div>
            <div className="text-sm text-doux">
              {data.actuel.marque === 'AL_KAYAN' ? 'Al Kayan' : 'Chez Samer'} · {data.actuel.code}
            </div>
          </div>
        </div>
      )}

      <p className="text-sm text-doux">
        Choisissez le restaurant de CE poste : son identité (nom, marque, couleur) et son
        équipe sont récupérées depuis SamerTrackly.
      </p>

      {(data?.restaurants.length ?? 0) === 0 ? (
        <div className="rounded-xl bg-alerte-tint p-4 text-sm text-alerte">
          Liste indisponible — vérifiez la clé SamerTrackly (apps/server/.env) et la connexion internet.
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <select className="champ w-auto" value={selection} onChange={(e) => setChoix(e.target.value)}>
            <option value="">— choisir un restaurant —</option>
            {data!.restaurants.map((r) => (
              <option key={r.id} value={r.id}>{r.nom}</option>
            ))}
          </select>
          <button type="button" className="btn-accent" disabled={!selection || configurer.isPending} onClick={() => configurer.mutate(selection)}>
            {configurer.isPending ? 'Configuration…' : 'Configurer ce restaurant'}
          </button>
        </div>
      )}

      <p className="text-xs text-doux">
        Le catalogue reste local à ce poste : les modifications de menu ici n'affectent pas les autres restaurants.
      </p>
    </section>
  );
}
