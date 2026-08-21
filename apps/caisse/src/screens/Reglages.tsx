import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowLeft, IconLock } from '@tabler/icons-react';
import { DISPONIBILITES, type Disponibilite, formatFCFA, LIBELLES_DISPONIBILITE, LIBELLES_POSTE_IMPRESSION, POSTES_IMPRESSION, type PosteImpression, SECTIONS_PERMISSIONS, PERMISSION_PROTEGEE, type SessionInfo } from '@pos/shared';
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
        { cle: 'options', perm: 'reglages.catalogue', libelle: 'Options', rendu: () => <Options /> },
        { cle: 'promotions', perm: 'reglages.catalogue', libelle: 'Promotions', rendu: () => <Promotions /> },
        { cle: 'reglages.fidelite', libelle: 'Fidélité', rendu: () => <Fidelite /> },
        { cle: 'imprimante', perm: 'reglages.parametres', libelle: 'Imprimantes', rendu: () => <Imprimante /> },
        { cle: 'routage', perm: 'reglages.parametres', libelle: 'Routage impression', rendu: () => <RoutageImpression /> },
        { cle: 'recettes', perm: 'reglages.parametres', libelle: 'Recettes d’inventaire', rendu: () => <RecettesInventaire /> },
        { cle: 'reglages.parametres', libelle: 'Paramètres', rendu: () => <Parametres /> },
        { cle: 'reglages.restaurant', libelle: 'Restaurant', rendu: () => <ConfigRestaurant /> },
        { cle: 'reglages.audit', libelle: "Journal d'audit", rendu: () => <Audit /> },
        { cle: 'roles.gerer', libelle: 'Rôles & accès', rendu: () => <Roles /> },
      ].filter((s) => a(s.perm ?? s.cle)),
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

/**
 * Fiche employé en CARTE (et non en ligne de tableau) : tout ce qui identifie
 * la personne est visible d'un coup — photo, nom, rôle, poste, téléphone,
 * disponibilité, état du PIN. Les trois actions (Modifier, Réinitialiser le
 * PIN, Désactiver) vivent derrière « Détails » : ce sont des gestes rares, et
 * les afficher sur chaque fiche remplissait l'écran de boutons identiques.
 */
function CarteEmploye({
  employe: e,
  ouvert,
  onBasculer,
  onModifier,
  onReinitPin,
  onDesactiver,
  onDisponibilite,
}: {
  employe: Employe;
  ouvert: boolean;
  onBasculer: () => void;
  onModifier: () => void;
  onReinitPin: () => void;
  onDesactiver: () => void;
  onDisponibilite: (d: Disponibilite) => void;
}) {
  const etat = !e.actif
    ? { libelle: 'Désactivé', classe: 'bg-alerte-tint text-alerte-txt' }
    : e.doit_definir_pin
      ? { libelle: 'PIN à définir', classe: 'bg-marque-tint text-marque-sur-plan' }
      : { libelle: 'Actif', classe: 'bg-ok-tint text-ok-txt' };

  return (
    <div
      className={`flex flex-col rounded-jeton border bg-surface p-4 shadow-e1 transition ${
        e.actif ? 'border-bordure' : 'border-bordure bg-surface-douce opacity-70'
      }`}
    >
      <div className="flex items-start gap-3">
        <AvatarEmploye nom={e.nom_complet} photo={e.photo_url} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-bold leading-tight text-fort">{e.nom_complet}</div>
          <div className="mt-0.5 truncate text-sm text-doux">{e.role_nom ?? 'Sans rôle'}</div>
        </div>
        <span className={`flex-none rounded-full px-2.5 py-1 text-[11px] font-bold ${etat.classe}`}>{etat.libelle}</span>
      </div>

      {/* Les infos de la fiche, chacune sur sa ligne et libellée : dans un
          tableau elles étaient collées en « poste · téléphone », illisible. */}
      <dl className="mt-3 space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-doux">Poste</dt>
          <dd className="truncate font-medium">{e.poste || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-doux">Téléphone</dt>
          <dd className="truncate font-medium tabular-nums">{e.telephone || '—'}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-doux">Dernière présence</dt>
          <dd className="truncate font-medium">
            {e.derniere_presence ? new Date(e.derniere_presence).toLocaleDateString('fr-FR') : '—'}
          </dd>
        </div>
      </dl>

      {/* La disponibilité se règle sans ouvrir les détails : c'est le seul
          geste quotidien de cet écran (« il est malade aujourd'hui »). */}
      <div className="mt-3 flex items-center gap-2">
        <span className={`flex-none rounded-full px-2.5 py-1 text-xs font-semibold ${COULEUR_DISPO[e.disponibilite]}`}>
          {LIBELLES_DISPONIBILITE[e.disponibilite]}
        </span>
        <select
          className="min-w-0 flex-1 rounded-btn border border-bordure bg-surface px-2 py-2 text-sm"
          value={e.disponibilite}
          disabled={!e.actif}
          aria-label={`Disponibilité de ${e.nom_complet}`}
          onChange={(ev) => onDisponibilite(ev.target.value as Disponibilite)}
        >
          {DISPONIBILITES.map((d) => (
            <option key={d} value={d}>{LIBELLES_DISPONIBILITE[d]}</option>
          ))}
        </select>
      </div>

      {e.actif && (
        <>
          <button
            type="button"
            onClick={onBasculer}
            className="mt-3 w-full rounded-btn border border-bordure py-2 text-sm font-semibold text-doux transition hover:border-marque hover:text-marque-sur-plan"
          >
            {ouvert ? '▾ Masquer les détails' : '▸ Détails'}
          </button>
          {ouvert && (
            <div className="mt-2 grid gap-2 border-t border-bordure pt-3">
              <button type="button" className="btn-blanc w-full" onClick={onModifier}>Modifier la fiche</button>
              <button type="button" className="btn-blanc w-full" onClick={onReinitPin}>Réinitialiser le PIN</button>
              <button
                type="button"
                className="w-full rounded-btn border border-alerte/40 py-3 text-sm font-bold text-alerte transition hover:bg-alerte/10"
                onClick={onDesactiver}
              >
                Désactiver l’employé
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
  /** Une seule fiche ouverte à la fois : sinon la grille redevient un mur. */
  const [detailsOuverts, setDetailsOuverts] = useState<string | null>(null);

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
      {/* Une CARTE par employé, et non une ligne de tableau : la fiche tient
          tout entière dans un rectangle (photo, nom, rôle, poste, téléphone,
          état), au lieu d'un tableau qui débordait latéralement et empilait
          trois boutons dans la dernière colonne. Les actions sont repliées
          derrière « Détails » — on les ouvre pour l'employé qu'on traite, pas
          pour les quarante autres. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {(employes ?? []).map((e) => (
          <CarteEmploye
            key={e.id}
            employe={e}
            ouvert={detailsOuverts === e.id}
            onBasculer={() => setDetailsOuverts(detailsOuverts === e.id ? null : e.id)}
            onModifier={() => setEdition(e)}
            onReinitPin={() => reinit.mutate(e.id)}
            onDesactiver={() => desactiver.mutate(e.id)}
            onDisponibilite={(disponibilite) => dispo.mutate({ id: e.id, disponibilite })}
          />
        ))}
        {(employes ?? []).length === 0 && (
          <p className="text-doux">Aucun employé. Ajoutez-le à la main, ou synchronisez depuis SamerTrackly.</p>
        )}
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
// Options (migration 0020) — créées ici, liées à une CATÉGORIE ou à un ARTICLE.
// Donnée LOCALE : modifiable hors ligne, jamais écrasée par une descente cloud
// (contrairement au Catalogue ci-dessus, qui s'édite au siège).
// ---------------------------------------------------------------------------
interface LiaisonVue {
  id: string;
  categorie_id: string | null;
  article_id: string | null;
  libelle: string;
}
interface OptionAdminVue {
  id: string;
  nom: string;
  prix: number;
  actif: boolean;
  ordre: number;
  liaisons: LiaisonVue[];
}
interface OptionsAdminVue {
  options: OptionAdminVue[];
  categories: { id: string; nom: string }[];
  articles: { id: string; nom: string; categorie_id: string }[];
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------
// Elles s'appliquent AUTOMATIQUEMENT côté serveur dès que le jour et l'heure
// correspondent : sans cet écran, une promotion héritée de l'image de
// déploiement (« Happy Hour −20 % », 17h–19h) tournait sans que personne puisse
// l'arrêter autrement qu'en ouvrant la base.

interface PromotionVue {
  id: string;
  nom: string;
  type: 'POURCENTAGE' | 'MONTANT';
  valeur: number;
  heure_debut: string | null;
  heure_fin: string | null;
  jours: number[];
  article_id: string | null;
  actif: boolean;
}

interface PromotionsAdminVue {
  promotions: PromotionVue[];
  articles: { id: string; nom: string }[];
}

/** Jour ISO 1 = lundi … 7 = dimanche, comme le stocke le schéma. */
const JOURS_SEMAINE: { n: number; court: string; long: string }[] = [
  { n: 1, court: 'L', long: 'lundi' },
  { n: 2, court: 'M', long: 'mardi' },
  { n: 3, court: 'M', long: 'mercredi' },
  { n: 4, court: 'J', long: 'jeudi' },
  { n: 5, court: 'V', long: 'vendredi' },
  { n: 6, court: 'S', long: 'samedi' },
  { n: 7, court: 'D', long: 'dimanche' },
];

const TOUS_LES_JOURS = [1, 2, 3, 4, 5, 6, 7];

function libelleJours(jours: number[]): string {
  if (jours.length === 7) return 'tous les jours';
  return JOURS_SEMAINE.filter((j) => jours.includes(j.n))
    .map((j) => j.long)
    .join(', ');
}

function libelleCreneau(p: PromotionVue): string {
  if (!p.heure_debut || !p.heure_fin) return 'toute la journée';
  return `${p.heure_debut} → ${p.heure_fin}`;
}

const PROMO_VIERGE: PromotionVue = {
  id: '',
  nom: '',
  type: 'POURCENTAGE',
  valeur: 10,
  heure_debut: '17:00',
  heure_fin: '19:00',
  jours: TOUS_LES_JOURS,
  article_id: null,
  actif: true,
};

function Promotions() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const [edite, setEdite] = useState<PromotionVue | null>(null);
  const [aSupprimer, setASupprimer] = useState<PromotionVue | null>(null);

  const { data } = useQuery({
    queryKey: ['admin', 'promotions'],
    queryFn: () => api<PromotionsAdminVue>('/api/admin/promotions'),
  });

  const rafraichir = () => void qc.invalidateQueries({ queryKey: ['admin', 'promotions'] });
  const surErreur = (e: Error) => setMsg({ texte: e.message });
  const surSucces = (texte: string) => () => {
    setMsg({ texte, ok: true });
    rafraichir();
  };

  const basculer = useMutation({
    mutationFn: ({ id, actif }: { id: string; actif: boolean }) =>
      api(`/api/admin/promotions/${id}/actif`, { method: 'POST', corps: { actif } }),
    onSuccess: (_r, v) => surSucces(v.actif ? 'Promotion activée' : 'Promotion désactivée')(),
    onError: surErreur,
  });

  const enregistrer = useMutation({
    mutationFn: (p: PromotionVue) => {
      const corps = {
        nom: p.nom.trim(),
        type: p.type,
        valeur: p.valeur,
        heure_debut: p.heure_debut || null,
        heure_fin: p.heure_fin || null,
        jours: p.jours,
        article_id: p.article_id,
        actif: p.actif,
      };
      return p.id
        ? api(`/api/admin/promotions/${p.id}`, { method: 'PATCH', corps })
        : api('/api/admin/promotions', { method: 'POST', corps });
    },
    onSuccess: () => {
      setEdite(null);
      surSucces('Promotion enregistrée')();
    },
    onError: surErreur,
  });

  const supprimer = useMutation({
    mutationFn: (id: string) => api(`/api/admin/promotions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setASupprimer(null);
      surSucces('Promotion supprimée')();
    },
    onError: (e: Error) => {
      setASupprimer(null);
      surErreur(e);
    },
  });

  const promos = data?.promotions ?? [];
  const actives = promos.filter((p) => p.actif).length;
  const nomArticle = (id: string | null): string =>
    id ? data?.articles.find((a) => a.id === id)?.nom ?? '(article supprimé)' : '';

  return (
    <section>
      <h2 className="mb-2 text-xl font-bold">Promotions</h2>
      <div className="mb-4 rounded-xl bg-blue-50 px-4 py-3 text-blue-900">
        Une promotion active s’applique <strong>toute seule</strong> aux nouvelles commandes dès que le jour et
        l’heure correspondent — personne n’a besoin de la déclencher. Les commandes déjà encaissées gardent la
        remise qu’elles ont reçue : désactiver n’agit que sur la suite.
      </div>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-accent" onClick={() => setEdite({ ...PROMO_VIERGE })}>
          Nouvelle promotion
        </button>
        <span className="text-sm text-doux">
          {promos.length === 0
            ? 'Aucune promotion enregistrée.'
            : `${actives} active${actives > 1 ? 's' : ''} sur ${promos.length}`}
        </span>
      </div>

      <div className="space-y-3">
        {promos.map((p) => (
          <div
            key={p.id}
            className={`rounded-xl border p-4 ${p.actif ? 'border-bordure-forte bg-surface' : 'border-bordure bg-surface-douce'}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-bold">{p.nom}</span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                      p.actif ? 'bg-emerald-100 text-emerald-900' : 'bg-surface-haute text-doux'
                    }`}
                  >
                    {p.actif ? 'ACTIVE' : 'désactivée'}
                  </span>
                </div>
                <div className="mt-1 text-doux">
                  {p.type === 'POURCENTAGE' ? `−${p.valeur} %` : `−${formatFCFA(p.valeur)}`}
                  {' · '}
                  {libelleCreneau(p)}
                  {' · '}
                  {libelleJours(p.jours)}
                  {p.article_id ? ` · sur « ${nomArticle(p.article_id)} »` : ' · sur toute la commande'}
                </div>
              </div>
              <div className="flex flex-none gap-2">
                <button
                  type="button"
                  className={p.actif ? 'btn-blanc' : 'btn-accent'}
                  disabled={basculer.isPending}
                  onClick={() => basculer.mutate({ id: p.id, actif: !p.actif })}
                >
                  {p.actif ? 'Désactiver' : 'Activer'}
                </button>
                <button type="button" className="btn-blanc" onClick={() => setEdite({ ...p })}>
                  Modifier
                </button>
                <button type="button" className="btn-blanc" onClick={() => setASupprimer(p)}>
                  Supprimer
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {edite && (
        <Modale
          titre={edite.id ? 'Modifier la promotion' : 'Nouvelle promotion'}
          onFermer={() => setEdite(null)}
          enfants={
            <div className="space-y-4">
            <div>
              <label htmlFor="promo-nom" className="mb-1 block text-sm font-semibold text-doux">Nom</label>
              <input
                id="promo-nom"
                className="champ w-full"
                value={edite.nom}
                onChange={(e) => setEdite({ ...edite, nom: e.target.value })}
                placeholder="ex : Happy Hour"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <div>
                <label htmlFor="promo-type" className="mb-1 block text-sm font-semibold text-doux">Type de remise</label>
                <select
                  id="promo-type"
                  className="champ w-48"
                  value={edite.type}
                  onChange={(e) => setEdite({ ...edite, type: e.target.value as PromotionVue['type'] })}
                >
                  <option value="POURCENTAGE">Pourcentage (%)</option>
                  <option value="MONTANT">Montant fixe (FCFA)</option>
                </select>
              </div>
              <div>
                <label htmlFor="promo-valeur" className="mb-1 block text-sm font-semibold text-doux">
                  {edite.type === 'POURCENTAGE' ? 'Pourcentage' : 'Montant (FCFA)'}
                </label>
                <input
                  id="promo-valeur"
                  className="champ w-32"
                  inputMode="numeric"
                  value={String(edite.valeur)}
                  onChange={(e) => setEdite({ ...edite, valeur: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                />
              </div>
            </div>

            <div>
              <span className="mb-1 block text-sm font-semibold text-doux">Créneau horaire</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="time"
                  aria-label="Heure de début"
                  className="champ w-32"
                  value={edite.heure_debut ?? ''}
                  onChange={(e) => setEdite({ ...edite, heure_debut: e.target.value || null })}
                />
                <span className="text-doux">→</span>
                <input
                  type="time"
                  aria-label="Heure de fin"
                  className="champ w-32"
                  value={edite.heure_fin ?? ''}
                  onChange={(e) => setEdite({ ...edite, heure_fin: e.target.value || null })}
                />
                <button
                  type="button"
                  className="btn-blanc"
                  onClick={() => setEdite({ ...edite, heure_debut: null, heure_fin: null })}
                >
                  Toute la journée
                </button>
              </div>
            </div>

            <div>
              <span className="mb-1 block text-sm font-semibold text-doux">Jours d’application</span>
              <div className="flex flex-wrap gap-2">
                {JOURS_SEMAINE.map((j) => {
                  const choisi = edite.jours.includes(j.n);
                  return (
                    <button
                      key={j.n}
                      type="button"
                      aria-pressed={choisi}
                      title={j.long}
                      className={`h-11 w-11 rounded-btn border font-bold ${
                        choisi ? 'border-marque bg-marque text-sur-marque' : 'border-bordure bg-surface text-doux'
                      }`}
                      onClick={() =>
                        setEdite({
                          ...edite,
                          jours: choisi ? edite.jours.filter((n) => n !== j.n) : [...edite.jours, j.n].sort(),
                        })
                      }
                    >
                      {j.court}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor="promo-article" className="mb-1 block text-sm font-semibold text-doux">
                S’applique à
              </label>
              <select
                id="promo-article"
                className="champ w-full"
                value={edite.article_id ?? ''}
                onChange={(e) => setEdite({ ...edite, article_id: e.target.value || null })}
              >
                <option value="">Toute la commande</option>
                {(data?.articles ?? []).map((a) => (
                  <option key={a.id} value={a.id}>{a.nom}</option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={edite.actif}
                onChange={(e) => setEdite({ ...edite, actif: e.target.checked })}
              />
              <span className="font-semibold">Promotion active</span>
            </label>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn-blanc" onClick={() => setEdite(null)}>Annuler</button>
              <button
                type="button"
                className="btn-accent"
                disabled={!edite.nom.trim() || edite.valeur <= 0 || edite.jours.length === 0 || enregistrer.isPending}
                onClick={() => enregistrer.mutate(edite)}
              >
                Enregistrer
              </button>
              </div>
            </div>
          }
        />
      )}

      {aSupprimer && (
        <Modale
          titre="Supprimer la promotion"
          onFermer={() => setASupprimer(null)}
          enfants={
            <>
              <p className="mb-4">
                Supprimer définitivement « <strong>{aSupprimer.nom}</strong> » ? Si elle a déjà été appliquée à
                des commandes, elle ne pourra pas être supprimée — désactivez-la, elle ne s’appliquera plus.
              </p>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-blanc" onClick={() => setASupprimer(null)}>Annuler</button>
                <button
                  type="button"
                  className="btn-alerte"
                  disabled={supprimer.isPending}
                  onClick={() => supprimer.mutate(aSupprimer.id)}
                >
                  Supprimer
                </button>
              </div>
            </>
          }
        />
      )}
    </section>
  );
}

function Options() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const [nom, setNom] = useState('');
  const [prix, setPrix] = useState('0');
  const [ouverte, setOuverte] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['admin', 'options'],
    queryFn: () => api<OptionsAdminVue>('/api/admin/options'),
  });

  const rafraichir = () => void qc.invalidateQueries({ queryKey: ['admin', 'options'] });
  const surErreur = (e: Error) => setMsg({ texte: e.message });
  const surSucces = (texte: string) => () => {
    setMsg({ texte, ok: true });
    rafraichir();
  };

  const creer = useMutation({
    mutationFn: (corps: { nom: string; prix: number }) =>
      api('/api/admin/options', { method: 'POST', corps }),
    onSuccess: () => {
      setNom('');
      setPrix('0');
      surSucces('Option créée')();
    },
    onError: surErreur,
  });
  const modifier = useMutation({
    mutationFn: ({ id, ...corps }: { id: string; nom?: string; prix?: number; actif?: boolean }) =>
      api(`/api/admin/options/${id}`, { method: 'PATCH', corps }),
    onSuccess: surSucces('Option modifiée'),
    onError: surErreur,
  });
  const supprimer = useMutation({
    mutationFn: (id: string) => api(`/api/admin/options/${id}`, { method: 'DELETE' }),
    onSuccess: surSucces('Option supprimée'),
    onError: surErreur,
  });
  const lier = useMutation({
    mutationFn: ({ id, ...corps }: { id: string; categorie_id?: string; article_id?: string }) =>
      api(`/api/admin/options/${id}/liaisons`, { method: 'POST', corps }),
    onSuccess: surSucces('Liaison ajoutée'),
    onError: surErreur,
  });
  const delier = useMutation({
    mutationFn: (liaisonId: string) => api(`/api/admin/liaisons/${liaisonId}`, { method: 'DELETE' }),
    onSuccess: surSucces('Liaison retirée'),
    onError: surErreur,
  });

  const prixValide = /^\d+$/.test(prix);

  return (
    <section>
      <h2 className="mb-2 text-xl font-bold">Options</h2>
      <div className="mb-4 rounded-xl bg-blue-50 px-4 py-3 text-blue-900">
        Créez une option (pâte à l’ail, fromage…), puis liez-la à une catégorie entière ou à un produit
        précis. Un prix de <strong>0</strong> = option offerte. Les commandes déjà passées ne changent jamais.
      </div>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />

      {/* Création */}
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-bordure p-4">
        <div>
          <label htmlFor="opt-nom" className="mb-1 block text-sm font-semibold text-doux">Nom de l’option</label>
          <input id="opt-nom" className="champ w-64" value={nom} onChange={(e) => setNom(e.target.value)} placeholder="ex : Pâte à l’ail" />
        </div>
        <div>
          <label htmlFor="opt-prix" className="mb-1 block text-sm font-semibold text-doux">Prix (FCFA)</label>
          <input id="opt-prix" className="champ w-32" value={prix} onChange={(e) => setPrix(e.target.value)} inputMode="numeric" />
        </div>
        <button
          type="button"
          className="btn-accent"
          disabled={nom.trim().length === 0 || !prixValide || creer.isPending}
          onClick={() => creer.mutate({ nom: nom.trim(), prix: Number(prix) })}
        >
          {creer.isPending ? 'Création…' : 'Créer l’option'}
        </button>
      </div>

      {/* Liste */}
      <div className="space-y-3">
        {(data?.options ?? []).map((o) => (
          <div key={o.id} className={`rounded-xl border border-bordure p-4 ${o.actif ? '' : 'opacity-60'}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg font-bold">{o.nom}</span>
              <span className="rounded-full bg-marque-tint px-3 py-1 text-sm font-semibold text-marque-fonce">
                {o.prix > 0 ? formatFCFA(o.prix) : 'Offert'}
              </span>
              {!o.actif && <span className="text-sm font-semibold text-doux">désactivée</span>}
              <div className="ml-auto flex gap-2">
                <button type="button" className="btn-blanc" onClick={() => setOuverte(ouverte === o.id ? null : o.id)}>
                  {ouverte === o.id ? 'Fermer' : 'Lier à…'}
                </button>
                <button type="button" className="btn-blanc" onClick={() => modifier.mutate({ id: o.id, actif: !o.actif })}>
                  {o.actif ? 'Désactiver' : 'Réactiver'}
                </button>
                <button type="button" className="btn-blanc" onClick={() => supprimer.mutate(o.id)}>
                  Supprimer
                </button>
              </div>
            </div>

            {/* Liaisons existantes */}
            <div className="mt-2 flex flex-wrap gap-2">
              {o.liaisons.length === 0 && (
                <span className="text-sm text-doux">Liée à aucun produit — elle n’apparaît nulle part.</span>
              )}
              {o.liaisons.map((l) => (
                <span key={l.id} className="flex items-center gap-2 rounded-full bg-surface-douce px-3 py-1 text-sm">
                  {l.libelle}
                  <button type="button" className="font-bold text-alerte" title="Retirer" onClick={() => delier.mutate(l.id)}>
                    ×
                  </button>
                </span>
              ))}
            </div>

            {/* Ajout de liaison */}
            {ouverte === o.id && (
              <div className="mt-3 flex flex-wrap gap-3 border-t border-bordure pt-3">
                <div>
                  <label htmlFor={`cat-${o.id}`} className="mb-1 block text-sm font-semibold text-doux">Toute une catégorie</label>
                  <select
                    id={`cat-${o.id}`}
                    className="champ w-56"
                    defaultValue=""
                    onChange={(e) => { if (e.target.value) lier.mutate({ id: o.id, categorie_id: e.target.value }); e.target.value = ''; }}
                  >
                    <option value="">Choisir…</option>
                    {(data?.categories ?? []).map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor={`art-${o.id}`} className="mb-1 block text-sm font-semibold text-doux">Un produit précis</label>
                  <select
                    id={`art-${o.id}`}
                    className="champ w-64"
                    defaultValue=""
                    onChange={(e) => { if (e.target.value) lier.mutate({ id: o.id, article_id: e.target.value }); e.target.value = ''; }}
                  >
                    <option value="">Choisir…</option>
                    {(data?.articles ?? []).map((a) => <option key={a.id} value={a.id}>{a.nom}</option>)}
                  </select>
                </div>
              </div>
            )}
          </div>
        ))}
        {(data?.options ?? []).length === 0 && (
          <p className="text-doux">Aucune option pour l’instant — créez la première ci-dessus.</p>
        )}
      </div>
    </section>
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
// Imprimante (découverte + sélection + test)
// ---------------------------------------------------------------------------
interface ImprimanteSysteme { nom: string; port: string; partagee: boolean; nom_partage: string | null; virtuelle: boolean }
type ModeLogo = 'aucun' | 'raster' | 'bandes';
interface ImprimantesVue {
  disponibles: ImprimanteSysteme[];
  postes: Record<PosteImpression, string>;
  logo: ModeLogo;
  colonnes: number;
  colonnes_possibles: number[];
}

function Imprimante() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['admin', 'imprimantes'],
    queryFn: () => api<ImprimantesVue>('/api/admin/imprimantes'),
  });

  return (
    <section className="max-w-2xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-xl font-bold">Imprimantes</h2>
        <button type="button" className="btn-blanc" disabled={isFetching} onClick={() => refetch()}>
          {isFetching ? 'Recherche…' : 'Actualiser la liste'}
        </button>
      </div>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />
      <p className="mb-4 text-sm text-doux">
        Reliez chaque poste à son imprimante. Le <b>reçu</b> et le <b>rapport Z</b> sortent à la
        <b> Caisse</b> ; à l’envoi en cuisine, chaque article imprime un bon sur l’imprimante de son poste
        (défini dans « Routage impression »). Les imprimantes installées apparaissent directement — aucune
        configuration Windows nécessaire.
      </p>

      {isLoading ? (
        <p className="text-doux">Recherche des imprimantes…</p>
      ) : (
        <div className="grid gap-3">
          {(data?.disponibles.length ?? 0) === 0 && (
            <div className="rounded-xl bg-amber-100 px-4 py-3 text-amber-900">
              Aucune imprimante détectée. Installez le pilote, ou saisissez le nom manuellement dans chaque poste.
            </div>
          )}
          {POSTES_IMPRESSION.map((poste) => (
            <LignePosteImprimante
              key={poste}
              poste={poste}
              valeur={data?.postes[poste] ?? ''}
              disponibles={data?.disponibles ?? []}
              onMessage={setMsg}
              onEnregistre={() => void qc.invalidateQueries({ queryKey: ['admin', 'imprimantes'] })}
            />
          ))}
          <LargeurPapier
            valeur={data?.colonnes ?? 48}
            possibles={data?.colonnes_possibles ?? [32, 42, 48]}
            onMessage={setMsg}
            onEnregistre={() => void qc.invalidateQueries({ queryKey: ['admin', 'imprimantes'] })}
          />
          <LogoTicket
            valeur={data?.logo ?? 'aucun'}
            onMessage={setMsg}
            onEnregistre={() => void qc.invalidateQueries({ queryKey: ['admin', 'imprimantes'] })}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Largeur du papier. Trop grande, la fin de chaque ligne bascule à la ligne
 * suivante : c'est ce qui séparait le « 5 » de « 000 F » sur les montants.
 */
function LargeurPapier({
  valeur,
  possibles,
  onMessage,
  onEnregistre,
}: {
  valeur: number;
  possibles: number[];
  onMessage: (m: { texte: string; ok?: boolean }) => void;
  onEnregistre: () => void;
}) {
  const [choix, setChoix] = useState<number>(valeur);
  useEffect(() => setChoix(valeur), [valeur]);

  const enregistrer = useMutation({
    mutationFn: (colonnes: number) => api('/api/admin/imprimante/colonnes', { method: 'POST', corps: { colonnes } }),
    onSuccess: (_r, colonnes) => {
      onMessage({ texte: `Largeur du papier : ${colonnes} colonnes.`, ok: true });
      onEnregistre();
    },
    onError: (e: Error) => onMessage({ texte: e.message }),
  });

  return (
    <div className="rounded-xl border border-bordure p-4">
      <div className="mb-2 font-bold">Largeur du papier</div>
      <p className="mb-3 text-sm text-doux">
        Si les montants se coupent en deux (le <b>5</b> en haut, <b>000 F</b> en dessous), c’est que la
        largeur est trop grande. Lancez « Tester » sur la <b>Caisse</b> : la partie <b>1</b> du ticket
        imprime un essai par largeur — gardez <b>le plus grand qui tient sur une seule ligne</b>.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="champ w-auto min-w-[16rem]" value={choix} onChange={(e) => setChoix(Number(e.target.value))}>
          {possibles.map((n) => (
            <option key={n} value={n}>{n} colonnes{n === 48 ? ' (80 mm classique)' : n === 32 ? ' (58 mm)' : ''}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn-accent"
          disabled={choix === valeur || enregistrer.isPending}
          onClick={() => enregistrer.mutate(choix)}
        >
          {enregistrer.isPending ? '…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

/**
 * Choix de l'encodage du logo. Toutes les imprimantes ne comprennent pas la
 * même commande image, et celle qui ne comprend pas imprime du charabia : on
 * fait donc choisir sur pièce, à partir des modes A et B du ticket de test.
 */
const LIBELLES_LOGO: Record<ModeLogo, string> = {
  aucun: 'Pas de logo (sûr)',
  raster: 'Mode A — raster',
  bandes: 'Mode B — bandes',
};

function LogoTicket({
  valeur,
  onMessage,
  onEnregistre,
}: {
  valeur: ModeLogo;
  onMessage: (m: { texte: string; ok?: boolean }) => void;
  onEnregistre: () => void;
}) {
  const [choix, setChoix] = useState<ModeLogo>(valeur);
  useEffect(() => setChoix(valeur), [valeur]);

  const enregistrer = useMutation({
    mutationFn: (mode: ModeLogo) => api('/api/admin/imprimante/logo', { method: 'POST', corps: { mode } }),
    onSuccess: (_r, mode) => {
      onMessage({ texte: `Logo du ticket : ${LIBELLES_LOGO[mode].toLowerCase()}.`, ok: true });
      onEnregistre();
    },
    onError: (e: Error) => onMessage({ texte: e.message }),
  });

  return (
    <div className="rounded-xl border border-bordure p-4">
      <div className="mb-2 font-bold">Logo sur le ticket</div>
      <p className="mb-3 text-sm text-doux">
        Lancez « Tester » sur la <b>Caisse</b> ci-dessus : le ticket imprime le logo en <b>mode A</b> et en
        <b> mode B</b>. Gardez celui qui sort proprement. Si les deux donnent des caractères bizarres,
        laissez « Pas de logo » — cette imprimante ne sait pas imprimer d’image.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="champ w-auto min-w-[16rem]" value={choix} onChange={(e) => setChoix(e.target.value as ModeLogo)}>
          {(Object.keys(LIBELLES_LOGO) as ModeLogo[]).map((m) => (
            <option key={m} value={m}>{LIBELLES_LOGO[m]}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn-accent"
          disabled={choix === valeur || enregistrer.isPending}
          onClick={() => enregistrer.mutate(choix)}
        >
          {enregistrer.isPending ? '…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

function LignePosteImprimante({
  poste,
  valeur,
  disponibles,
  onMessage,
  onEnregistre,
}: {
  poste: PosteImpression;
  valeur: string;
  disponibles: ImprimanteSysteme[];
  onMessage: (m: { texte: string; ok?: boolean }) => void;
  onEnregistre: () => void;
}) {
  const [choix, setChoix] = useState<string>(valeur);
  // Suit la valeur serveur quand elle change (après enregistrement / actualisation).
  useEffect(() => setChoix(valeur), [valeur]);
  const connue = disponibles.some((d) => d.nom === choix);

  const enregistrer = useMutation({
    mutationFn: (queue: string) => api('/api/admin/imprimante/poste', { method: 'POST', corps: { poste, queue } }),
    onSuccess: (_r, queue) => {
      onMessage({ texte: queue ? `${LIBELLES_POSTE_IMPRESSION[poste]} : ${queue}` : `${LIBELLES_POSTE_IMPRESSION[poste]} désactivée (console).`, ok: true });
      onEnregistre();
    },
    onError: (e: Error) => onMessage({ texte: e.message }),
  });
  const tester = useMutation({
    mutationFn: (queue: string) => api('/api/admin/imprimante/test', { method: 'POST', corps: { queue } }),
    onSuccess: () => onMessage({ texte: `Ticket de test envoyé vers ${LIBELLES_POSTE_IMPRESSION[poste]}. Vérifiez la sortie papier.`, ok: true }),
    onError: (e: Error) => onMessage({ texte: e.message }),
  });

  return (
    <div className="rounded-xl border border-bordure p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-bold">{LIBELLES_POSTE_IMPRESSION[poste]}</span>
        {valeur ? <span className="text-xs text-ok">· {valeur}</span> : <span className="text-xs text-doux">· non configurée</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="champ w-auto min-w-[16rem]"
          value={connue ? choix : '__manuel__'}
          onChange={(e) => setChoix(e.target.value === '__manuel__' ? '' : e.target.value)}
        >
          <option value="">— aucune (mode console) —</option>
          {disponibles.map((d) => (
            <option key={d.nom} value={d.nom}>{d.nom}{d.virtuelle ? ' (virtuelle)' : ''}</option>
          ))}
          <option value="__manuel__">Saisir manuellement…</option>
        </select>
        {!connue && (
          <input
            className="champ w-auto min-w-[16rem]"
            value={choix}
            onChange={(e) => setChoix(e.target.value)}
            placeholder="Nom d’imprimante ou \\poste\partage"
          />
        )}
        <button type="button" className="btn-blanc" disabled={!choix || tester.isPending} onClick={() => tester.mutate(choix)}>
          {tester.isPending ? 'Test…' : 'Tester'}
        </button>
        <button type="button" className="btn-accent" disabled={choix === valeur || enregistrer.isPending} onClick={() => enregistrer.mutate(choix)}>
          {enregistrer.isPending ? '…' : 'Enregistrer'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routage impression (catégories + exceptions par article)
// ---------------------------------------------------------------------------
interface RoutageCatVue { id: string; nom: string; poste: PosteImpression | null }
interface RoutageArtVue { id: string; nom: string; categorie_id: string; poste: PosteImpression | null }
interface RoutageVue { defaut: PosteImpression; categories: RoutageCatVue[]; articles: RoutageArtVue[] }

function RoutageImpression() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const [ouvertes, setOuvertes] = useState<Set<string>>(new Set());
  const { data } = useQuery({ queryKey: ['admin', 'routage'], queryFn: () => api<RoutageVue>('/api/admin/routage') });

  const invalider = () => void qc.invalidateQueries({ queryKey: ['admin', 'routage'] });
  const majCat = useMutation({
    mutationFn: (v: { categorie_id: string; poste: PosteImpression | null }) => api('/api/admin/routage/categorie', { method: 'PUT', corps: v }),
    onSuccess: () => { setMsg({ texte: 'Routage catégorie enregistré.', ok: true }); invalider(); },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const majArt = useMutation({
    mutationFn: (v: { article_id: string; poste: PosteImpression | null }) => api('/api/admin/routage/article', { method: 'PUT', corps: v }),
    onSuccess: () => { setMsg({ texte: 'Routage article enregistré.', ok: true }); invalider(); },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });

  const basculer = (id: string) => {
    const s = new Set(ouvertes);
    if (s.has(id)) s.delete(id); else s.add(id);
    setOuvertes(s);
  };
  const posteEffectifCat = (c: RoutageCatVue): PosteImpression => c.poste ?? (data?.defaut ?? 'CUISINE');

  return (
    <section className="max-w-3xl">
      <h2 className="mb-1 text-xl font-bold">Routage impression</h2>
      <p className="mb-4 text-sm text-doux">
        Sur quelle imprimante sort chaque produit à l’envoi en cuisine. On règle par <b>catégorie</b> ;
        un article peut faire exception. Par défaut : <b>{LIBELLES_POSTE_IMPRESSION[data?.defaut ?? 'CUISINE']}</b>.
      </p>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />

      <div className="grid gap-2">
        {(data?.categories ?? []).map((c) => {
          const arts = (data?.articles ?? []).filter((a) => a.categorie_id === c.id);
          const nbExceptions = arts.filter((a) => a.poste !== null).length;
          return (
            <div key={c.id} className="rounded-xl border border-bordure p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" className="text-left font-semibold" onClick={() => basculer(c.id)}>
                  {ouvertes.has(c.id) ? '▾' : '▸'} {c.nom}
                  <span className="ml-2 text-xs font-normal text-doux">
                    {arts.length} article(s){nbExceptions ? ` · ${nbExceptions} exception(s)` : ''}
                  </span>
                </button>
                <SelectPoste
                  valeur={c.poste}
                  labelHerite={`Défaut (${LIBELLES_POSTE_IMPRESSION[data?.defaut ?? 'CUISINE']})`}
                  onChange={(poste) => majCat.mutate({ categorie_id: c.id, poste })}
                />
              </div>
              {ouvertes.has(c.id) && (
                <div className="mt-3 grid gap-1.5 border-t border-bordure pt-3">
                  {arts.length === 0 && <p className="text-sm text-doux">Aucun article dans cette catégorie.</p>}
                  {arts.map((a) => (
                    <div key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm">{a.nom}</span>
                      <SelectPoste
                        valeur={a.poste}
                        labelHerite={`Comme la catégorie (${LIBELLES_POSTE_IMPRESSION[posteEffectifCat(c)]})`}
                        onChange={(poste) => majArt.mutate({ article_id: a.id, poste })}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Sélecteur de poste d'impression avec option « hérité » (valeur null). */
function SelectPoste({
  valeur,
  labelHerite,
  onChange,
}: {
  valeur: PosteImpression | null;
  labelHerite: string;
  onChange: (poste: PosteImpression | null) => void;
}) {
  return (
    <select
      className="champ w-auto"
      value={valeur ?? ''}
      onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as PosteImpression))}
    >
      <option value="">{labelHerite}</option>
      {POSTES_IMPRESSION.map((p) => (
        <option key={p} value={p}>{LIBELLES_POSTE_IMPRESSION[p]}</option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Recettes d'inventaire (migration 0022) — « que consomme un article vendu ? »
// ---------------------------------------------------------------------------
interface RecetteLigne { article_id: string; quantite: number }
interface ProduitRecetteVue {
  id: string;
  code: string;
  categorie: string;
  nom: string;
  unite: string;
  role: string;
  ratio: number | null;
  recettes: RecetteLigne[];
}
interface ArticleRecetteVue { id: string; nom: string; categorie: string }
interface RecettesVue { produits: ProduitRecetteVue[]; articles: ArticleRecetteVue[] }

const LIBELLES_CATEGORIE_INVENTAIRE: Record<string, string> = {
  PAIN: 'Pains',
  POUL: 'Poulet',
  APER: 'Apéritifs',
  PLAT: 'Plats',
  FROM: 'Fromage',
  BOIS: 'Boissons',
  GLAC: 'Glaces',
  FRIT: 'Frites',
};

/**
 * C'est cet écran qui donne leurs SORTIES aux produits de comptage : sans
 * recette, un produit reste à 0 et son théorique se réduit à initial + entrées.
 * Les lignes dérivées (Total poulet, Total fromage, Pot de glace, Darina…) n'en
 * prennent jamais : leurs sorties se déduisent des lignes de consommation.
 */
function RecettesInventaire() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);
  const [ouvert, setOuvert] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ['admin', 'recettes-inventaire'],
    queryFn: () => api<RecettesVue>('/api/admin/recettes-inventaire'),
  });

  const invalider = () => void qc.invalidateQueries({ queryKey: ['admin', 'recettes-inventaire'] });
  const enregistrer = useMutation({
    mutationFn: (v: { produit_id: string; recettes: RecetteLigne[] }) =>
      api(`/api/admin/recettes-inventaire/${v.produit_id}`, { method: 'PUT', corps: { recettes: v.recettes } }),
    onSuccess: () => { setMsg({ texte: 'Recette enregistrée.', ok: true }); invalider(); },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });
  const poserDefaut = useMutation({
    mutationFn: () => api<{ inserees: number }>('/api/admin/recettes-inventaire/defaut', { method: 'POST', corps: {} }),
    onSuccess: (r) => {
      setMsg({
        texte: r.inserees > 0
          ? `${r.inserees} liaison(s) ajoutée(s) sur les produits qui n’avaient aucune recette.`
          : 'Rien à ajouter : chaque produit a déjà sa recette (ou a été vidé exprès).',
        ok: true,
      });
      invalider();
    },
    onError: (e: Error) => setMsg({ texte: e.message }),
  });

  // Les lignes qui ne prennent pas de recette : leurs sorties sont dérivées.
  const derive = (role: string) =>
    role === 'ENTREE' || role === 'AUTO_ENT' || role === 'DARINA' || role.startsWith('TOTAL');

  const parCategorie = new Map<string, ProduitRecetteVue[]>();
  for (const p of data?.produits ?? []) {
    parCategorie.set(p.categorie, [...(parCategorie.get(p.categorie) ?? []), p]);
  }
  const sansRecette = (data?.produits ?? []).filter((p) => !derive(p.role) && p.recettes.length === 0).length;

  return (
    <section className="max-w-3xl">
      <h2 className="mb-1 text-xl font-bold">Recettes d’inventaire</h2>
      <p className="mb-3 text-sm text-doux">
        Ce que chaque produit de comptage perd quand un article est <b>vendu et encaissé</b>. C’est ce
        qui remplit la colonne <b>Sorties</b> de l’inventaire : sans recette, le théorique se réduit à
        « stock initial + entrées » et l’écart ne veut plus rien dire. La <b>quantité</b> est le nombre
        d’unités consommées par article vendu — 1 pain par chawarma, <b>0,5</b> poulet par demi-poulet.
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn-blanc"
          disabled={poserDefaut.isPending}
          onClick={() => poserDefaut.mutate()}
        >
          {poserDefaut.isPending ? 'Application…' : 'Proposer les recettes par défaut'}
        </button>
        {sansRecette > 0 && (
          <span className="text-sm font-semibold text-attente-txt">
            {sansRecette} produit(s) sans recette — leurs sorties restent à 0.
          </span>
        )}
      </div>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />

      <div className="grid gap-4">
        {[...parCategorie.entries()].map(([categorie, produits]) => (
          <div key={categorie}>
            <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-doux">
              {LIBELLES_CATEGORIE_INVENTAIRE[categorie] ?? categorie}
            </h3>
            <div className="grid gap-2">
              {produits.map((p) => (
                <LigneRecette
                  key={p.id}
                  produit={p}
                  articles={data?.articles ?? []}
                  derive={derive(p.role)}
                  ouvert={ouvert === p.id}
                  onBasculer={() => setOuvert(ouvert === p.id ? null : p.id)}
                  onEnregistrer={(recettes) => enregistrer.mutate({ produit_id: p.id, recettes })}
                  enCours={enregistrer.isPending}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function LigneRecette({
  produit,
  articles,
  derive,
  ouvert,
  onBasculer,
  onEnregistrer,
  enCours,
}: {
  produit: ProduitRecetteVue;
  articles: ArticleRecetteVue[];
  derive: boolean;
  ouvert: boolean;
  onBasculer: () => void;
  onEnregistrer: (recettes: RecetteLigne[]) => void;
  enCours: boolean;
}) {
  // Brouillon local : on enregistre la liste en bloc, comme elle est à l'écran.
  const [brouillon, setBrouillon] = useState<RecetteLigne[]>(produit.recettes);
  const [recherche, setRecherche] = useState('');
  useEffect(() => { setBrouillon(produit.recettes); }, [produit.recettes]);

  const nomArticle = (id: string) => articles.find((a) => a.id === id)?.nom ?? '(article supprimé)';
  const dejaPris = new Set(brouillon.map((r) => r.article_id));
  const rech = recherche.trim().toLowerCase();
  const candidats = rech.length === 0
    ? []
    : articles.filter((a) => !dejaPris.has(a.id) && a.nom.toLowerCase().includes(rech)).slice(0, 8);

  return (
    <div className="rounded-xl border border-bordure p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="text-left font-semibold" onClick={onBasculer} disabled={derive}>
          {!derive && (ouvert ? '▾ ' : '▸ ')}{produit.nom}
          <span className="ml-2 text-xs font-normal text-doux">
            {derive
              ? 'ligne dérivée — sorties calculées, pas de recette'
              : `${produit.recettes.length} article(s)`}
            {produit.ratio !== null && ` · ratio ${produit.ratio} ${produit.unite}`}
          </span>
        </button>
        {!derive && produit.recettes.length === 0 && (
          <span className="rounded-full bg-attente-tint px-2.5 py-1 text-[11px] font-bold text-attente-txt">
            Sorties à 0
          </span>
        )}
      </div>

      {ouvert && !derive && (
        <div className="mt-3 grid gap-2 border-t border-bordure pt-3">
          {brouillon.length === 0 && (
            <p className="text-sm text-doux">Aucun article ne consomme ce produit pour l’instant.</p>
          )}
          {brouillon.map((r) => (
            <div key={r.article_id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">{nomArticle(r.article_id)}</span>
              <input
                type="number"
                step="0.5"
                min="0.001"
                className="champ w-24 text-right"
                value={r.quantite}
                onChange={(e) =>
                  setBrouillon(brouillon.map((x) =>
                    x.article_id === r.article_id ? { ...x, quantite: Number(e.target.value) } : x,
                  ))
                }
              />
              <button
                type="button"
                className="rounded-btn px-3 py-2 text-sm font-semibold text-alerte hover:bg-alerte/10"
                onClick={() => setBrouillon(brouillon.filter((x) => x.article_id !== r.article_id))}
              >
                Retirer
              </button>
            </div>
          ))}

          <div>
            <input
              type="text"
              className="champ"
              placeholder="Ajouter un article vendu…"
              value={recherche}
              onChange={(e) => setRecherche(e.target.value)}
            />
            {candidats.length > 0 && (
              <div className="mt-1 grid gap-1">
                {candidats.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="rounded-btn px-3 py-2 text-left text-sm hover:bg-surface-douce"
                    onClick={() => {
                      setBrouillon([...brouillon, { article_id: a.id, quantite: 1 }]);
                      setRecherche('');
                    }}
                  >
                    {a.nom} <span className="text-doux">· {a.categorie}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-accent"
              disabled={enCours}
              onClick={() => onEnregistrer(brouillon.filter((r) => r.quantite > 0))}
            >
              {enCours ? 'Enregistrement…' : 'Enregistrer la recette'}
            </button>
            <button type="button" className="btn-blanc" onClick={() => setBrouillon(produit.recettes)}>
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
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
    mutationFn: (id: string) =>
      api<{ sync_a_reenroler?: boolean }>('/api/admin/restaurant/config', { method: 'POST', corps: { samtrackly_restaurant_id: id } }),
    onSuccess: async (rep) => {
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
      // Le poste a reçu une identité neuve : l'ancienne clé de synchro cloud a
      // été effacée exprès (elle appartenait au restaurant précédent).
      const reenroler = rep?.sync_a_reenroler
        ? ' ⚠ Synchro cloud à ré-enrôler (`pnpm site:enroler`) avant la prochaine remontée.'
        : '';
      setMsg({ texte: `Restaurant configuré.${equipe}${reenroler}`, ok: true });
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
