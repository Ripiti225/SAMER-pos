import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowLeft, IconLock } from '@tabler/icons-react';
import { SECTIONS_PERMISSIONS, PERMISSION_PROTEGEE } from '@pos/shared';
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
        { cle: 'reglages.audit', libelle: "Journal d'audit", rendu: () => <Audit /> },
        { cle: 'roles.gerer', libelle: 'Rôles & accès', rendu: () => <Roles /> },
      ].filter((s) => a(s.cle)),
    [perms.join(',')],
  );

  const [active, setActive] = useState(sections[0]?.cle ?? '');
  const sectionActive = sections.find((s) => s.cle === active) ?? sections[0];

  return (
    <div className="flex min-h-full flex-col p-6">
      <header className="mb-6 flex items-center gap-4">
        <button type="button" className="btn-blanc flex items-center gap-2" onClick={rentrer}>
          <IconArrowLeft size={20} /> Accueil
        </button>
        <h1 className="text-2xl font-black text-marque-fonce">Réglages</h1>
      </header>

      <div className="flex flex-1 gap-6">
        <nav className="flex w-56 shrink-0 flex-col gap-1">
          {sections.map((s) => (
            <button
              key={s.cle}
              type="button"
              className={`rounded-xl px-4 py-3 text-left text-lg font-semibold ${
                s.cle === sectionActive?.cle ? 'bg-marque text-white' : 'hover:bg-marque-tint'
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
  telephone: string | null;
  actif: boolean;
  doit_definir_pin: boolean;
  derniere_presence: string | null;
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

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">Équipe</h2>
        <button type="button" className="btn-accent" onClick={() => setNouveau({ nom_complet: '', role_id: rolesActifs[0]?.id ?? '', telephone: '' })}>
          + Ajouter un employé
        </button>
      </div>
      <Message texte={msg?.texte ?? null} ok={msg?.ok} />
      {code && (
        <div className="mb-4 rounded-xl bg-amber-100 px-4 py-3 text-amber-900">
          Code temporaire à communiquer à l’employé (une seule fois) : <b className="text-2xl tracking-widest">{code}</b>
          <button type="button" className="btn-blanc ml-3" onClick={() => setCode(null)}>OK</button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-doux">
            <tr><th className="py-2">Nom</th><th>Rôle</th><th>Téléphone</th><th>État</th><th></th></tr>
          </thead>
          <tbody>
            {(employes ?? []).map((e) => (
              <tr key={e.id} className="border-t border-bordure">
                <td className="py-2 font-semibold">{e.nom_complet}</td>
                <td>{e.role_nom ?? '—'}</td>
                <td>{e.telephone ?? '—'}</td>
                <td>{!e.actif ? <span className="text-red-700">Désactivé</span> : e.doit_definir_pin ? <span className="text-amber-700">PIN à définir</span> : 'Actif'}</td>
                <td className="text-right">
                  {e.actif && (
                    <>
                      <button type="button" className="btn-blanc mr-2" onClick={() => reinit.mutate(e.id)}>Réinit. PIN</button>
                      <button type="button" className="btn-blanc" onClick={() => desactiver.mutate(e.id)}>Désactiver</button>
                    </>
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
    </section>
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

  const invalider = () => void qc.invalidateQueries({ queryKey: ['admin', 'salle'] });
  const creerZone = useMutation({ mutationFn: () => api('/api/admin/zones', { method: 'POST', corps: { nom: nomZone } }), onSuccess: () => { setNomZone(''); invalider(); }, onError: (e: Error) => setMsg(e.message) });
  const creerTable = useMutation({ mutationFn: (v: { zone_id: string; numero: string }) => api('/api/admin/tables', { method: 'POST', corps: v }), onSuccess: invalider, onError: (e: Error) => setMsg(e.message) });
  const desactiver = useMutation({ mutationFn: (id: string) => api(`/api/admin/tables/${id}`, { method: 'PATCH', corps: { actif: false } }), onSuccess: invalider, onError: (e: Error) => setMsg(e.message) });
  const reactiver = useMutation({ mutationFn: (id: string) => api(`/api/admin/tables/${id}`, { method: 'PATCH', corps: { actif: true } }), onSuccess: invalider, onError: (e: Error) => setMsg(e.message) });

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">Salle & QR</h2>
        <a className="btn-blanc" href="/api/admin/tables/qr.pdf" target="_blank" rel="noreferrer">Imprimer les QR</a>
      </div>
      <Message texte={msg} />
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
