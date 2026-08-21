/**
 * Écran Dépenses (DESIGN_V2 § 6.8) — deux onglets.
 *
 * - **Registre** : la liste chronologique des sorties de caisse. Son total
 *   remonte automatiquement à la clôture, où la ligne « Dépenses » n'est plus
 *   saisissable : la caissière ne retape rien.
 * - **Paie & départs** : TOUTE l'équipe du jour, pas seulement les payés à la
 *   journée — un employé au mois peut recevoir un encouragement, et surtout son
 *   départ doit être marqué. À la clôture, qui n'est pas marqué « Reste » est
 *   enregistré comme PARTI : le caissier ne marque que les exceptions.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCoin, IconPlus, IconTrash, IconUserCheck } from '@tabler/icons-react';
import { api } from '../api';
import { EnteteEcran } from '../components/EnteteEcran';
import { Modale } from '../components/Modale';
import { useCaisse } from '../stores/session';

interface LigneDepense {
  id: string;
  categorie: string;
  libelle: string;
  montant: number;
  agent_id: string | null;
  agent_nom: string | null;
  auto: boolean;
  motif: string | null;
  created_at: string;
}

interface Registre {
  service_id: string;
  total: number;
  par_categorie: Record<string, number>;
  lignes: LigneDepense[];
}

interface LignePaie {
  utilisateur_id: string;
  nom_complet: string;
  poste_jour: string;
  photo_url: string | null;
  taux_journalier: number | null;
  pointe_le: string | null;
  reste: boolean | null;
  salaire_paye: { montant: number; motif: string | null } | null;
  encouragements: number;
}

/** Catégories du registre. Les deux dernières naissent d'un paiement réel. */
const CATEGORIES: { cle: string; libelle: string; couleur: string; saisissable: boolean }[] = [
  { cle: 'MARCHE', libelle: 'Marché', couleur: '#d97706', saisissable: true },
  { cle: 'LEGUMES', libelle: 'Légumes', couleur: '#16a34a', saisissable: true },
  { cle: 'FRUITS', libelle: 'Fruits', couleur: '#e2445c', saisissable: true },
  { cle: 'ANNEXES', libelle: 'Dépenses annexes', couleur: '#3b82f6', saisissable: true },
  { cle: 'SALAIRES', libelle: 'Salaires', couleur: '#8b5cf6', saisissable: false },
  { cle: 'ENCOURAGEMENTS', libelle: 'Encouragements', couleur: '#14b8a6', saisissable: false },
];
const categorie = (cle: string) => CATEGORIES.find((c) => c.cle === cle);

export const fcfa = (n: number): string => `${n.toLocaleString('fr-FR')} F`;
const heure = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function Depenses() {
  const { rentrer, afficherToast } = useCaisse();
  const [onglet, setOnglet] = useState<'registre' | 'paie'>('registre');
  const [nouvelle, setNouvelle] = useState(false);
  const [payer, setPayer] = useState<LignePaie | null>(null);
  const [encourager, setEncourager] = useState<LignePaie | null>(null);
  const queryClient = useQueryClient();

  const { data: registre } = useQuery({ queryKey: ['depenses'], queryFn: () => api<Registre>('/api/depenses') });
  const { data: paie } = useQuery({ queryKey: ['depenses-paie'], queryFn: () => api<LignePaie[]>('/api/depenses/paie') });

  const rafraichir = () => {
    for (const cle of [['depenses'], ['depenses-paie'], ['depenses-total'], ['pointage']]) {
      void queryClient.invalidateQueries({ queryKey: cle });
    }
  };

  const supprimer = useMutation({
    mutationFn: (id: string) => api(`/api/depenses/${id}`, { method: 'DELETE' }),
    onSuccess: rafraichir,
    onError: (e: unknown) => afficherToast((e as Error).message),
  });

  const departure = useMutation({
    mutationFn: (v: { id: string; reste: boolean }) =>
      api(`/api/pointage/${v.id}/depart`, { method: 'PATCH', corps: { reste: v.reste } }),
    onSuccess: rafraichir,
    onError: (e: unknown) => afficherToast((e as Error).message),
  });

  return (
    <div className="min-h-full bg-fond p-4 sm:p-6">
      <EnteteEcran
        titre="Dépenses"
        onRetour={rentrer}
        actions={
          <div className="flex rounded-btn border border-bordure bg-surface p-1">
            {(['registre', 'paie'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => setOnglet(o)}
                className={`rounded-[9px] px-4 py-2 text-sm font-semibold transition ${
                  onglet === o ? 'bg-marque text-sur-marque' : 'text-doux hover:bg-surface-douce'
                }`}
              >
                {o === 'registre' ? 'Registre' : 'Paie & départs'}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="carte p-4">
          {onglet === 'registre' ? (
            <>
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-bold">Sorties de caisse du service</h2>
                <button type="button" className="btn-accent flex items-center gap-2" onClick={() => setNouvelle(true)}>
                  <IconPlus size={18} />
                  Nouvelle dépense
                </button>
              </div>

              {registre?.lignes.length === 0 && (
                <p className="py-10 text-center text-doux">Aucune sortie de caisse enregistrée pour l’instant.</p>
              )}

              <ul className="divide-y divide-bordure">
                {(registre?.lignes ?? []).map((l) => {
                  const c = categorie(l.categorie);
                  return (
                    <li key={l.id} className="flex items-center gap-3 py-3">
                      <span
                        className="flex-none rounded-full px-3 py-1 text-xs font-bold"
                        style={{
                          color: c?.couleur,
                          background: `color-mix(in srgb, ${c?.couleur ?? 'var(--marque)'} 14%, var(--surface-carte))`,
                        }}
                      >
                        {c?.libelle ?? l.categorie}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-fort">{l.libelle}</span>
                        <span className="block text-xs text-doux">
                          {heure(l.created_at)}
                          {l.motif ? ` · ${l.motif}` : ''}
                        </span>
                      </span>
                      <span className="flex-none text-lg font-bold tabular-nums text-fort">{fcfa(l.montant)}</span>
                      {/* Une ligne née d'un paiement réel ne s'efface pas :
                          l'argent est sorti du tiroir. */}
                      <button
                        type="button"
                        disabled={l.auto || supprimer.isPending}
                        title={l.auto ? 'Née d’un paiement réel : non supprimable' : 'Supprimer'}
                        onClick={() => supprimer.mutate(l.id)}
                        className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-doux transition hover:bg-alerte/10 hover:text-alerte disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-doux"
                      >
                        <IconTrash size={18} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <>
              <h2 className="mb-4 text-lg font-bold">Paie & départs</h2>
              <ul className="divide-y divide-bordure">
                {(paie ?? []).map((p) => (
                  <li key={p.utilisateur_id} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-fort">{p.nom_complet}</span>
                      <span className="block text-xs text-doux">
                        {p.poste_jour}
                        {p.taux_journalier !== null ? ` · ${fcfa(p.taux_journalier)}/jour` : ' · pas de taux journalier'}
                        {p.encouragements > 0 ? ` · encouragements ${fcfa(p.encouragements)}` : ''}
                      </span>
                    </span>

                    {p.salaire_paye ? (
                      <span className="flex items-center gap-2 rounded-full bg-ok-tint px-3 py-1 text-xs font-bold text-ok-txt">
                        <IconUserCheck size={15} />
                        Payé {fcfa(p.salaire_paye.montant)}
                      </span>
                    ) : (
                      <button type="button" className="btn-accent" onClick={() => setPayer(p)}>
                        Payer
                      </button>
                    )}

                    <button type="button" className="btn-blanc flex items-center gap-2" onClick={() => setEncourager(p)}>
                      <IconCoin size={17} />
                      Encouragement
                    </button>

                    {/* Non marqué = PARTI à la clôture : le cas courant ne
                        demande aucun geste (§ 6.8). */}
                    <div className="flex overflow-hidden rounded-btn border border-bordure">
                      {[
                        { valeur: false, libelle: 'Parti' },
                        { valeur: true, libelle: 'Reste' },
                      ].map((choix) => (
                        <button
                          key={String(choix.valeur)}
                          type="button"
                          onClick={() => departure.mutate({ id: p.utilisateur_id, reste: choix.valeur })}
                          className={`px-3 py-2 text-sm font-semibold transition ${
                            p.reste === choix.valeur ? 'bg-marque text-sur-marque' : 'text-doux hover:bg-surface-douce'
                          }`}
                        >
                          {choix.libelle}
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
                {paie?.length === 0 && (
                  <li className="py-10 text-center text-doux">Aucune équipe enregistrée sur ce service.</li>
                )}
              </ul>
            </>
          )}
        </div>

        {/* Panneau droit : total du service et répartition par catégorie */}
        <aside className="carte h-fit p-4">
          <div className="text-sm font-semibold uppercase tracking-wider text-doux">Total du service</div>
          <div className="mt-1 text-4xl font-bold tabular-nums text-fort">{fcfa(registre?.total ?? 0)}</div>
          <p className="mt-2 text-xs leading-relaxed text-doux">
            Ce total remonte automatiquement à la clôture : la ligne « Dépenses » y est en lecture seule.
          </p>

          <div className="mt-5 space-y-2">
            {CATEGORIES.map((c) => {
              const montant = registre?.par_categorie[c.cle] ?? 0;
              if (montant === 0) return null;
              return (
                <div key={c.cle} className="flex items-center gap-2 text-sm">
                  <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: c.couleur }} />
                  <span className="flex-1 text-doux">{c.libelle}</span>
                  <span className="font-bold tabular-nums text-fort">{fcfa(montant)}</span>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      {nouvelle && (
        <ModaleDepense
          onFermer={() => setNouvelle(false)}
          onEnregistre={() => {
            setNouvelle(false);
            rafraichir();
          }}
          onErreur={afficherToast}
        />
      )}

      {payer && (
        <ModalePayer
          agent={payer}
          onFermer={() => setPayer(null)}
          onEnregistre={() => {
            setPayer(null);
            rafraichir();
          }}
          onErreur={afficherToast}
        />
      )}

      {encourager && (
        <ModaleEncouragement
          agent={encourager}
          onFermer={() => setEncourager(null)}
          onEnregistre={() => {
            setEncourager(null);
            rafraichir();
          }}
          onErreur={afficherToast}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saisies
// ---------------------------------------------------------------------------
function ChampMontant({
  valeur,
  onChange,
  autoFocus,
}: {
  valeur: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      step={1}
      autoFocus={autoFocus}
      value={valeur}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 text-2xl font-bold tabular-nums outline-none focus:border-marque"
      placeholder="0"
    />
  );
}

function ModaleDepense({
  onFermer,
  onEnregistre,
  onErreur,
}: {
  onFermer: () => void;
  onEnregistre: () => void;
  onErreur: (m: string) => void;
}) {
  const [cle, setCle] = useState('MARCHE');
  const [libelle, setLibelle] = useState('');
  const [montant, setMontant] = useState('');

  const enregistrer = useMutation({
    mutationFn: () =>
      api('/api/depenses', {
        method: 'POST',
        corps: { categorie: cle, libelle, montant: Number(montant) },
      }),
    onSuccess: onEnregistre,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  return (
    <Modale
      titre="Nouvelle dépense"
      onFermer={onFermer}
      enfants={
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Catégorie</div>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORIES.filter((c) => c.saisissable).map((c) => (
                <button
                  key={c.cle}
                  type="button"
                  onClick={() => setCle(c.cle)}
                  className={`rounded-btn border px-3 py-3 text-sm font-bold transition ${
                    cle === c.cle ? 'border-transparent text-white' : 'border-bordure bg-surface text-fort'
                  }`}
                  style={cle === c.cle ? { background: c.couleur } : undefined}
                >
                  {c.libelle}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Motif de la dépense</div>
            <input
              type="text"
              value={libelle}
              onChange={(e) => setLibelle(e.target.value)}
              placeholder="Ex. tomates, gaz, taxi livraison…"
              className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 outline-none focus:border-marque"
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Montant (FCFA)</div>
            <ChampMontant valeur={montant} onChange={setMontant} />
          </div>

          <button
            type="button"
            disabled={!libelle.trim() || Number(montant) <= 0 || enregistrer.isPending}
            className="btn-accent w-full py-4 text-lg disabled:opacity-50"
            onClick={() => enregistrer.mutate()}
          >
            Enregistrer la dépense
          </button>
        </div>
      }
    />
  );
}

function ModalePayer({
  agent,
  onFermer,
  onEnregistre,
  onErreur,
}: {
  agent: LignePaie;
  onFermer: () => void;
  onEnregistre: () => void;
  onErreur: (m: string) => void;
}) {
  const [montant, setMontant] = useState(agent.taux_journalier ? String(agent.taux_journalier) : '');
  const [motif, setMotif] = useState('');
  // Le taux est modifiable, mais tout écart exige un motif : sans lui, le
  // manager découvre un montant inexpliqué sans pouvoir remonter à la raison.
  const ecart = Number(montant) !== agent.taux_journalier;

  const payer = useMutation({
    mutationFn: () =>
      api('/api/depenses/payer', {
        method: 'POST',
        corps: { agent_id: agent.utilisateur_id, montant: Number(montant), motif: motif.trim() || undefined },
      }),
    onSuccess: onEnregistre,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  return (
    <Modale
      titre={`Payer ${agent.nom_complet}`}
      onFermer={onFermer}
      enfants={
        <div className="space-y-4">
          <p className="text-sm text-doux">
            {agent.taux_journalier !== null
              ? `Taux de la fiche : ${fcfa(agent.taux_journalier)} par jour.`
              : 'Aucun taux journalier sur sa fiche : le motif est obligatoire.'}
          </p>

          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Montant versé (FCFA)</div>
            <ChampMontant valeur={montant} onChange={setMontant} autoFocus />
          </div>

          {ecart && (
            <div>
              <div className="mb-2 text-sm font-semibold text-alerte">
                Montant différent du taux — motif obligatoire
              </div>
              <input
                type="text"
                value={motif}
                onChange={(e) => setMotif(e.target.value)}
                placeholder="Ex. demi-journée, avance déduite…"
                className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 outline-none focus:border-marque"
              />
            </div>
          )}

          <p className="rounded-jeton bg-surface-douce px-3 py-2 text-xs text-doux">
            Ce paiement crée une ligne de dépense « Salaires » <b>non supprimable</b> : l’argent sort réellement
            du tiroir.
          </p>

          <button
            type="button"
            disabled={Number(montant) <= 0 || (ecart && !motif.trim()) || payer.isPending}
            className="btn-accent w-full py-4 text-lg disabled:opacity-50"
            onClick={() => payer.mutate()}
          >
            Payer {Number(montant) > 0 ? fcfa(Number(montant)) : ''}
          </button>
        </div>
      }
    />
  );
}

function ModaleEncouragement({
  agent,
  onFermer,
  onEnregistre,
  onErreur,
}: {
  agent: LignePaie;
  onFermer: () => void;
  onEnregistre: () => void;
  onErreur: (m: string) => void;
}) {
  const [montant, setMontant] = useState('');
  const [motif, setMotif] = useState('');

  const donner = useMutation({
    mutationFn: () =>
      api('/api/depenses/encouragement', {
        method: 'POST',
        corps: { agent_id: agent.utilisateur_id, montant: Number(montant), motif },
      }),
    onSuccess: onEnregistre,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  return (
    <Modale
      titre={`Encouragement — ${agent.nom_complet}`}
      onFermer={onFermer}
      enfants={
        <div className="space-y-4">
          <p className="text-sm text-doux">
            Prime exceptionnelle, ouverte à toute l’équipe — y compris aux employés au mois.
          </p>
          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Montant (FCFA)</div>
            <ChampMontant valeur={montant} onChange={setMontant} autoFocus />
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Motif (obligatoire)</div>
            <input
              type="text"
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              placeholder="Ex. gros service, aide en cuisine…"
              className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 outline-none focus:border-marque"
            />
          </div>
          <button
            type="button"
            disabled={Number(montant) <= 0 || !motif.trim() || donner.isPending}
            className="btn-accent w-full py-4 text-lg disabled:opacity-50"
            onClick={() => donner.mutate()}
          >
            Enregistrer l’encouragement
          </button>
        </div>
      }
    />
  );
}
