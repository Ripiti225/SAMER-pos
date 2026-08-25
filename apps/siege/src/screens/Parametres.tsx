import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSION_PROTEGEE, ROLES_VERROUILLES, SECTIONS_PERMISSIONS } from '@pos/shared';
import { appelSiege, ErreurSiege, type Siege } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { useRestaurants, type FiltreResto } from '../restaurants';

interface RoleCloud {
  restaurant_id: string;
  id: string;
  nom: string;
  systeme: boolean;
  actif: boolean;
  permissions: string[];
}

const cle = (nom: string) => nom.trim().toUpperCase();

/**
 * Onglet Paramètres — changer les accès d'un rôle sur plusieurs restaurants
 * d'un seul geste.
 *
 * **Le rôle se vise par son NOM, pas par son id.** Chaque site a ses propres
 * uuid de rôle ; « CAISSIER » existe partout sous un identifiant différent. La
 * console résout donc le rôle restaurant par restaurant — et ce n'est pas un
 * détail d'ergonomie : `roles.nom` est UNIQUE côté site, y pousser un uuid
 * étranger ferait échouer TOUTE la descente du site, catalogue compris.
 *
 * Deux garde-fous, repris du POS et appliqués aussi côté fonction (jamais
 * « côté UI seulement ») :
 *   - PROPRIETAIRE et SUPERVISEUR sont verrouillés ;
 *   - « Rôles & accès » ne s'attribue à aucun autre rôle.
 *
 * Diffuser un mauvais jeu sur plusieurs restaurants d'un clic est exactement le
 * geste qui enferme tout le monde dehors : l'écran montre donc l'existant AVANT
 * de proposer d'écrire.
 */
export function Parametres({ filtre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const qc = useQueryClient();
  const { data: restos } = useRestaurants();
  const { data: moi } = useQuery({ queryKey: ['moi'], queryFn: () => appelSiege<Siege>('moi'), staleTime: 5 * 60_000 });
  const { data, isPending, error } = useQuery({
    queryKey: ['roles_groupe'],
    queryFn: () => appelSiege<{ roles: RoleCloud[] }>('roles_groupe'),
    staleTime: 60_000,
  });

  const [roleNom, setRoleNom] = useState('');
  const [cibles, setCibles] = useState<string[]>([]);
  const [choisies, setChoisies] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);

  const enroles = useMemo(() => (restos?.restaurants ?? []).filter((r) => r.enrole && r.restaurant_id), [restos]);

  /** Rôles du groupe par NOM, avec le site qui les porte. */
  const parNom = useMemo(() => {
    const m = new Map<string, RoleCloud[]>();
    for (const r of data?.roles ?? []) {
      if (!r.actif) continue;
      const k = cle(r.nom);
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  }, [data]);

  const nomsModifiables = useMemo(
    () => [...parNom.keys()].filter((n) => !ROLES_VERROUILLES.includes(n)).sort(),
    [parNom],
  );
  const verrouilles = useMemo(() => [...parNom.keys()].filter((n) => ROLES_VERROUILLES.includes(n)).sort(), [parNom]);

  const instances = roleNom ? (parNom.get(roleNom) ?? []) : [];
  const nomResto = useMemo(() => {
    const m = new Map<string, { nom: string; marque: 'SAMER' | 'AL_KAYAN'; sid: string }>();
    for (const r of enroles) if (r.restaurant_id) m.set(r.restaurant_id, { nom: r.nom, marque: r.marque, sid: r.samtrackly_id });
    return m;
  }, [enroles]);

  /**
   * Les DIVERGENCES : une permission que certains sites donnent et d'autres non.
   * C'est ce qu'on vient regarder — un caissier qui peut faire une remise ici et
   * pas là-bas est une anomalie, pas un réglage.
   */
  const divergences = useMemo(() => {
    if (instances.length < 2) return [];
    const compte = new Map<string, number>();
    for (const i of instances) for (const p of new Set(i.permissions)) compte.set(p, (compte.get(p) ?? 0) + 1);
    return [...compte.entries()].filter(([, n]) => n < instances.length).map(([p, n]) => ({ permission: p, sites: n }));
  }, [instances]);

  // Point de départ de l'édition : le jeu du premier site trouvé. On ne fusionne
  // pas les jeux divergents — ça inventerait un état qu'aucun site n'a.
  const permissions = choisies ?? instances[0]?.permissions ?? [];

  const diffuser = useMutation({
    mutationFn: () =>
      appelSiege<{ diffuse_vers: number; permissions: number }>('roles_diffuser', {
        role_nom: roleNom,
        permissions,
        cibles: instances
          .filter((i) => cibles.includes(i.restaurant_id))
          .map((i) => ({ restaurant_id: i.restaurant_id, role_id: i.id })),
      }),
    onSuccess: (r) => {
      setMsg({
        texte: `Accès du rôle ${roleNom} diffusés vers ${r.diffuse_vers} restaurant(s) — ${r.permissions} permission(s). Chaque site les appliquera à sa prochaine descente.`,
        ok: true,
      });
      void qc.invalidateQueries({ queryKey: ['roles_groupe'] });
    },
    onError: (e: Error) => setMsg({ texte: e instanceof ErreurSiege ? e.message : 'Diffusion impossible' }),
  });

  const lectureSeule = moi?.niveau === 'LECTURE';
  const choisir = (nom: string) => {
    setRoleNom(nom);
    setChoisies(null);
    setCibles([]);
    setMsg(null);
  };

  return (
    <section className="max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold">Paramètres</h1>
      <p className="mb-4 text-doux">Accès d’un rôle, changés sur plusieurs restaurants d’un seul geste.</p>

      {lectureSeule && <Info>Votre compte est en <b>lecture seule</b> : vous voyez les accès, vous ne les changez pas.</Info>}
      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}
      {msg && (msg.ok ? <Info>{msg.texte}</Info> : <Erreur texte={msg.texte} />)}

      {isPending ? (
        <Squelette lignes={4} />
      ) : (
        <div className="space-y-4">
          <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">1. Quel rôle</h2>
            <div className="flex flex-wrap gap-2">
              {nomsModifiables.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => choisir(n)}
                  className={`min-h-[40px] rounded-btn border px-4 text-sm font-semibold transition ${
                    n === roleNom ? 'border-marque bg-marque text-sur-marque' : 'border-filet bg-carte text-doux hover:border-marque hover:text-txt'
                  }`}
                >
                  {n}
                  <span className="ml-1.5 text-xs font-normal opacity-70">{parNom.get(n)?.length} site(s)</span>
                </button>
              ))}
            </div>
            {verrouilles.length > 0 && (
              <p className="mt-2 text-xs text-faible">
                {verrouilles.join(', ')} — <b>verrouillé{verrouilles.length > 1 ? 's' : ''}</b>, ni ici ni depuis la
                caisse. Le compte propriétaire est protégé.
              </p>
            )}
          </div>

          {roleNom && (
            <>
              {/* L'existant AVANT d'écrire : on ne diffuse pas à l'aveugle. */}
              <div className="rounded-jeton border border-filet bg-carte p-4">
                <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">
                  2. Ce que chaque restaurant donne aujourd’hui
                </h2>
                <div className="space-y-1.5">
                  {instances.map((i) => {
                    const r = nomResto.get(i.restaurant_id);
                    return (
                      <div key={i.restaurant_id} className="flex items-baseline justify-between gap-3 border-b border-filet py-1.5 last:border-0">
                        <span className="flex min-w-0 items-center gap-2 font-semibold">
                          {r && <PastilleMarque marque={r.marque} />}
                          <span className="truncate">{r?.nom ?? 'Site inconnu'}</span>
                        </span>
                        <span className="chiffres flex-none text-doux">{i.permissions.length} permission(s)</span>
                      </div>
                    );
                  })}
                </div>
                {divergences.length > 0 && (
                  <div className="mt-3 rounded-sm bg-attente-tint px-3 py-2 text-sm text-attente-txt">
                    <b>Les restaurants ne donnent pas la même chose.</b>
                    <div className="mt-1 space-y-0.5 text-xs">
                      {divergences.map((d) => (
                        <div key={d.permission}>
                          {d.permission} — accordée par {d.sites} site(s) sur {instances.length}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-jeton border border-filet bg-carte p-4">
                <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">3. Les accès à appliquer</h2>
                {SECTIONS_PERMISSIONS.map((sec) => (
                  <div key={sec.cle} className="mb-3 last:mb-0">
                    <p className="mb-1 text-xs font-bold uppercase tracking-wide text-faible">{sec.libelle}</p>
                    <div className="grid gap-1 sm:grid-cols-2">
                      {sec.permissions.map((p) => {
                        // La permission protégée n'est proposée à AUCUN autre
                        // rôle : la donner, c'est donner tout le reste ensuite.
                        const protegee = p.cle === PERMISSION_PROTEGEE;
                        const active = permissions.includes(p.cle);
                        return (
                          <label
                            key={p.cle}
                            className={`flex items-center gap-2.5 rounded-btn px-2.5 py-1.5 text-sm ${protegee ? 'opacity-45' : 'cursor-pointer hover:bg-carte-douce'}`}
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 flex-none accent-[var(--marque)]"
                              checked={active}
                              disabled={protegee || lectureSeule}
                              onChange={(e) =>
                                setChoisies(e.target.checked ? [...new Set([...permissions, p.cle])] : permissions.filter((x) => x !== p.cle))
                              }
                            />
                            <span className="min-w-0 truncate">{p.libelle}</span>
                            {protegee && <span className="flex-none text-[11px] text-faible">protégée</span>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="rounded-jeton border border-filet bg-carte p-4">
                <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">4. Vers quels restaurants</h2>
                <div className="mb-2 flex gap-2">
                  <button type="button" className="btn-blanc !min-h-[36px] !px-3 !text-sm" onClick={() => setCibles(instances.map((i) => i.restaurant_id))}>
                    Tout cocher
                  </button>
                  <button type="button" className="btn-blanc !min-h-[36px] !px-3 !text-sm" onClick={() => setCibles([])}>
                    Tout décocher
                  </button>
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {instances.map((i) => {
                    const r = nomResto.get(i.restaurant_id);
                    return (
                      <label key={i.restaurant_id} className="flex cursor-pointer items-center gap-2.5 rounded-btn border border-filet px-3 py-2.5 transition hover:border-marque">
                        <input
                          type="checkbox"
                          className="h-4 w-4 flex-none accent-[var(--marque)]"
                          checked={cibles.includes(i.restaurant_id)}
                          onChange={(e) =>
                            setCibles(e.target.checked ? [...new Set([...cibles, i.restaurant_id])] : cibles.filter((x) => x !== i.restaurant_id))
                          }
                        />
                        {r && <PastilleMarque marque={r.marque} />}
                        <span className="min-w-0 flex-1 truncate font-semibold">{r?.nom ?? 'Site inconnu'}</span>
                        <span className="chiffres flex-none text-xs text-faible">{i.permissions.length}</span>
                      </label>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className="btn-accent mt-4 w-full"
                  disabled={cibles.length === 0 || lectureSeule || diffuser.isPending}
                  onClick={() => diffuser.mutate()}
                >
                  {diffuser.isPending
                    ? 'Diffusion…'
                    : `Appliquer ${permissions.length} accès à ${roleNom} sur ${cibles.length} restaurant${cibles.length > 1 ? 's' : ''}`}
                </button>
                <p className="mt-2 text-center text-xs text-faible">
                  Le jeu envoyé REMPLACE l’existant sur les sites cochés : ce qui n’est pas coché est retiré.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
