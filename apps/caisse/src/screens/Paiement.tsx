import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  IconArrowLeft,
  IconArrowsSplit2,
  IconBackspace,
  IconCash,
  IconCircleCheck,
  IconCirclePlus,
  IconCreditCard,
  IconDeviceMobile,
} from '@tabler/icons-react';
import type { CommandeVue, ModePaiement } from '@pos/shared';
import { formatFCFA, LIBELLES_MODES, MODES_PAIEMENT } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { Fidelite } from '../components/Fidelite';
import { useCaisse } from '../stores/session';

const RACCOURCIS = [1000, 2000, 5000, 10000];

function iconeMode(mode: ModePaiement) {
  if (mode === 'ESPECES') return IconCash;
  if (mode === 'CARTE') return IconCreditCard;
  return IconDeviceMobile; // Wave, Orange Money, MTN MoMo, Moov
}

export function Paiement() {
  const { commandeId, aller, afficherToast } = useCaisse();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ModePaiement>('ESPECES');
  const [montant, setMontant] = useState('');
  const [noteId, setNoteId] = useState<string | null>(null);
  const [splitOuvert, setSplitOuvert] = useState(false);
  const [especesDonnees, setEspecesDonnees] = useState('');

  const { data: commande } = useQuery({
    queryKey: ['commande', commandeId],
    queryFn: () => api<CommandeVue>(`/api/commandes/${commandeId}`),
    enabled: !!commandeId,
  });

  const rafraichir = (vue: CommandeVue) => queryClient.setQueryData(['commande', commandeId], vue);

  const encaisser = useMutation({
    mutationFn: (corps: { mode: ModePaiement; montant: number; note_id?: string | null }) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/paiements`, { method: 'POST', corps }),
    onSuccess: (vue) => {
      rafraichir(vue);
      setMontant('');
      setEspecesDonnees('');
      if (vue.statut === 'PAYEE') afficherToast(`Ticket n° ${vue.numero_ticket} encaissé ✔ — reçu imprimé`);
    },
    onError: (e: Error) => afficherToast(e.message),
  });

  const creerSplit = useMutation({
    mutationFn: (notes: { libelle: string; montant: number }[]) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/split`, { method: 'POST', corps: { notes } }),
    onSuccess: (vue) => { rafraichir(vue); setSplitOuvert(false); },
    onError: (e: Error) => afficherToast(e.message),
  });

  const commandePrete = !!commande;
  const estPayee = commande?.statut === 'PAYEE';

  // Clavier physique (dev) : chiffres → montant, Backspace, Échap (efface).
  useEffect(() => {
    if (!commandePrete || estPayee) return;
    const gerer = (e: KeyboardEvent) => {
      const cible = e.target as HTMLElement;
      if (cible?.tagName === 'INPUT') return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); setMontant((v) => (v.length < 9 ? v + e.key : v)); }
      else if (e.key === 'Backspace') { e.preventDefault(); setMontant((v) => v.slice(0, -1)); }
      else if (e.key === 'Escape') { e.preventDefault(); setMontant(''); }
    };
    window.addEventListener('keydown', gerer);
    return () => window.removeEventListener('keydown', gerer);
  }, [commandePrete, estPayee]);

  if (!commande) {
    return <div className="flex min-h-full items-center justify-center text-doux">Chargement…</div>;
  }

  const noteActive = commande.notes.find((n) => n.id === noteId) ?? null;
  const resteCible = noteActive ? noteActive.reste : commande.reste;
  const montantSaisi = montant === '' ? resteCible : Number(montant);
  const donnees = Number(especesDonnees || '0');
  const monnaie = mode === 'ESPECES' && donnees > montantSaisi ? donnees - montantSaisi : 0;
  const peutAjouter = montantSaisi > 0 && montantSaisi <= resteCible && !encaisser.isPending;

  const ajouter = () => { if (peutAjouter) encaisser.mutate({ mode, montant: montantSaisi, note_id: noteId }); };
  const taper = (c: string) => setMontant((v) => (v.length < 9 ? v + c : v));
  const ajouterRaccourci = (n: number) => setMontant((v) => String(Number(v || '0') + n));

  const splitEgal = (nb: number) => {
    const base = Math.floor(commande.total / nb);
    const notes = Array.from({ length: nb }, (_, i) => ({
      libelle: `Client ${String.fromCharCode(65 + i)}`,
      montant: i === 0 ? commande.total - base * (nb - 1) : base,
    }));
    creerSplit.mutate(notes);
  };
  const splitPossible = commande.notes.length === 0 && !estPayee && commande.paye === 0;

  return (
    <div className="flex h-screen flex-col bg-fond">
      {/* ---------- Barre supérieure ---------- */}
      <header className="flex h-16 flex-none items-center justify-between border-b border-bordure bg-surface px-4 shadow-e1">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => aller('commande', commande.id)}
            disabled={estPayee}
            className="flex items-center gap-2 font-semibold uppercase tracking-wider text-doux transition hover:text-marque-fonce disabled:opacity-40"
          >
            <IconArrowLeft size={20} /> <span className="hidden sm:inline">Retour à la commande</span>
          </button>
          <span className="hidden h-6 w-px bg-bordure sm:block" />
          <h2 className="text-xl font-semibold text-fort">
            Paiement · {commande.table_numero ? `Table ${commande.table_numero}` : `Ticket n° ${commande.numero_ticket}`}
          </h2>
        </div>
      </header>

      {/* ---------- Grille de paiement ---------- */}
      <div className="grid min-h-0 flex-1 grid-cols-12 gap-4 overflow-hidden p-4">
        {/* Colonne gauche : résumé + partage */}
        <div className="col-span-12 flex min-h-0 flex-col gap-4 lg:col-span-4">
          <div className="carte flex min-h-0 flex-1 flex-col p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold">Résumé du ticket</h3>
              <span className="rounded-full bg-marque-tint px-3 py-1 text-xs font-bold text-marque-fonce">
                N° {commande.numero_ticket}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {commande.items.filter((i) => i.statut_cuisine !== 'ANNULE').map((i) => (
                <div key={i.id} className="flex items-start justify-between gap-2">
                  <span className="text-fort">{i.quantite}× {i.nom_snapshot}</span>
                  <span className="font-semibold tabular-nums">{formatFCFA(i.total_ligne)}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-1 border-t border-bordure pt-4">
              {commande.promo_montant > 0 && (
                <LigneTotal libelle={`Promo ${commande.promo_nom ?? ''}`} valeur={`−${formatFCFA(commande.promo_montant)}`} vert />
              )}
              {commande.remise_montant > 0 && (
                <LigneTotal libelle="Remise" valeur={`−${formatFCFA(commande.remise_montant)}`} vert />
              )}
              {commande.fidelite_montant > 0 && (
                <LigneTotal libelle="Fidélité" valeur={`−${formatFCFA(commande.fidelite_montant)}`} vert />
              )}
              <div className="flex items-baseline justify-between pt-1">
                <span className="text-xl font-semibold">Total</span>
                <span className="text-2xl font-extrabold text-marque-fonce tabular-nums">{formatFCFA(commande.total)}</span>
              </div>
            </div>
          </div>

          {!estPayee && (
            <Fidelite commande={commande} onMaj={rafraichir} />
          )}

          {splitPossible && (
            <div className="rounded-2xl bg-surface-moyenne p-5 shadow-e1">
              <div className="mb-3 flex items-center gap-2">
                <IconArrowsSplit2 size={22} className="text-marque-fonce" />
                <h4 className="text-lg font-bold">Partager l’addition</h4>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {[2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => splitEgal(n)}
                    disabled={creerSplit.isPending}
                    className="rounded-xl bg-surface py-3 font-semibold shadow-e1 transition hover:bg-surface-haute disabled:opacity-40"
                  >
                    Par {n}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSplitOuvert(true)}
                className="mt-2 w-full rounded-xl border-2 border-bordure-forte py-3 font-semibold text-marque-fonce transition hover:bg-marque/5"
              >
                Saisie libre par personne
              </button>
            </div>
          )}
        </div>

        {/* Colonne milieu : modes + clavier */}
        <div className="col-span-12 flex min-h-0 flex-col gap-4 lg:col-span-5">
          {commande.notes.length > 0 && !estPayee && (
            <div className="flex flex-wrap gap-2">
              <BoutonNote actif={noteId === null} onClick={() => setNoteId(null)}>Toute la commande</BoutonNote>
              {commande.notes.map((n) => (
                <BoutonNote key={n.id} actif={noteId === n.id} paye={n.reste === 0} onClick={() => setNoteId(n.id)}>
                  {n.libelle} — {n.reste === 0 ? 'payée ✔' : formatFCFA(n.reste)}
                </BoutonNote>
              ))}
            </div>
          )}

          {!estPayee && (
            <>
              <div className="carte p-5">
                <h3 className="mb-4 text-lg font-bold">Mode de paiement</h3>
                <div className="grid grid-cols-3 gap-3">
                  {MODES_PAIEMENT.map((m) => {
                    const Icone = iconeMode(m);
                    const actif = mode === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className={`flex min-h-[84px] flex-col items-center justify-center gap-2 rounded-xl border-2 p-3 text-center transition ${
                          actif ? 'border-marque bg-marque/10 text-marque-fonce' : 'border-bordure text-doux hover:border-marque hover:text-marque-fonce'
                        }`}
                      >
                        <Icone size={30} />
                        <span className="text-xs font-semibold leading-tight">{LIBELLES_MODES[m]}</span>
                      </button>
                    );
                  })}
                </div>

                {mode === 'ESPECES' && (
                  <div className="mt-4 flex items-center gap-3">
                    <label className="text-sm text-doux">Reçu du client</label>
                    <input
                      className="champ h-11 flex-1"
                      inputMode="numeric"
                      value={especesDonnees}
                      onChange={(e) => setEspecesDonnees(e.target.value.replace(/\D/g, ''))}
                      placeholder="ex : 10000"
                    />
                    {monnaie > 0 && (
                      <span className="whitespace-nowrap text-sm">Monnaie : <b className="text-marque-fonce">{formatFCFA(monnaie)}</b></span>
                    )}
                  </div>
                )}
              </div>

              <div className="carte flex min-h-0 flex-1 flex-col p-5">
                <div className="mb-3 text-right">
                  <div className="text-xs font-bold uppercase tracking-widest text-doux">Montant saisi</div>
                  <div className="mt-1 text-4xl font-bold tabular-nums text-fort">{formatFCFA(montantSaisi)}</div>
                </div>
                <div className="grid flex-1 grid-cols-3 gap-2">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => (
                    <button key={c} type="button" onClick={() => taper(c)} className="touche">{c}</button>
                  ))}
                  <button type="button" onClick={() => setMontant('')} className="touche text-lg font-bold text-alerte">C</button>
                  <button type="button" onClick={() => taper('0')} className="touche">0</button>
                  <button type="button" onClick={() => setMontant((v) => v.slice(0, -1))} className="touche" aria-label="Effacer un chiffre">
                    <IconBackspace size={24} className="text-doux" />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-4 gap-2">
                  {RACCOURCIS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => ajouterRaccourci(n)}
                      className="rounded-lg bg-surface-tres-haute py-2 font-bold text-marque-fonce transition hover:brightness-95"
                    >
                      +{n / 1000}k
                    </button>
                  ))}
                </div>
                {montantSaisi > resteCible && (
                  <div className="mt-2 text-center text-sm font-medium text-alerte">Le montant dépasse le reste à payer</div>
                )}
              </div>
            </>
          )}

          {estPayee && (
            <div className="carte flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-ok-tint text-ok">
                <IconCircleCheck size={48} />
              </div>
              <h3 className="text-2xl font-bold">Vente terminée</h3>
              <p className="text-doux">Paiement reçu · reçu imprimé.</p>
            </div>
          )}
        </div>

        {/* Colonne droite : reste + paiements + validation */}
        <div className="col-span-12 flex min-h-0 flex-col gap-4 lg:col-span-3">
          <div className={`flex h-44 flex-none flex-col items-center justify-center rounded-2xl border-4 p-4 text-center shadow-e2 ${estPayee ? 'border-ok bg-fort' : 'border-marque bg-fort'}`}>
            <span className="text-xs font-bold uppercase tracking-widest text-fond/70">
              {estPayee ? 'Encaissé' : noteActive ? `Reste — ${noteActive.libelle}` : 'Reste à payer'}
            </span>
            <div className={`mt-1 text-5xl font-extrabold tabular-nums ${estPayee ? 'text-ok' : 'text-fond'}`}>
              {formatFCFA(resteCible)}
            </div>
            <span className="mt-1 text-xs text-fond/60">Total {formatFCFA(commande.total)} · payé {formatFCFA(commande.paye)}</span>
          </div>

          <div className="carte flex min-h-0 flex-1 flex-col p-5">
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-doux">Paiements enregistrés</h3>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {commande.paiements.length === 0 && (
                <div className="py-10 text-center text-sm italic text-doux/60">Aucun paiement saisi</div>
              )}
              {commande.paiements.map((p) => {
                const Icone = iconeMode(p.mode);
                return (
                  <div key={p.id} className="flex items-center justify-between rounded-xl border border-bordure bg-surface-douce p-3">
                    <span className="flex items-center gap-2 font-semibold">
                      <Icone size={18} className="text-marque-fonce" /> {LIBELLES_MODES[p.mode]}
                    </span>
                    <span className="font-bold tabular-nums">{formatFCFA(p.montant)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {!estPayee && (
            <button
              type="button"
              onClick={ajouter}
              disabled={!peutAjouter}
              className="flex h-14 flex-none items-center justify-center gap-2 rounded-[13px] bg-marque-tint text-lg font-bold text-marque-fonce shadow-e1 transition hover:brightness-95 disabled:opacity-40"
            >
              <IconCirclePlus size={22} /> {encaisser.isPending ? 'Encaissement…' : `Ajouter ${LIBELLES_MODES[mode]}`}
            </button>
          )}
          <button
            type="button"
            onClick={() => aller('accueil')}
            disabled={commande.reste > 0}
            className={`h-16 flex-none rounded-[13px] text-xl font-bold transition ${
              commande.reste > 0
                ? 'cursor-not-allowed border-2 border-dashed border-bordure-forte bg-surface-tres-haute text-doux/50'
                : 'bg-marque text-sur-marque shadow-e2 hover:brightness-105 active:translate-y-px'
            }`}
          >
            {estPayee ? 'Terminer' : 'Valider la vente'}
          </button>
          {commande.reste > 0 && (
            <p className="flex-none text-center text-xs font-bold uppercase leading-tight text-alerte">
              Soldez la totalité avant de valider
            </p>
          )}
        </div>
      </div>

      {splitOuvert && (
        <ModaleSplit
          total={commande.total}
          onConfirmer={(notes) => creerSplit.mutate(notes)}
          onFermer={() => setSplitOuvert(false)}
          enCours={creerSplit.isPending}
        />
      )}
    </div>
  );
}

function LigneTotal({ libelle, valeur, vert }: { libelle: string; valeur: string; vert?: boolean }) {
  return (
    <div className={`flex justify-between text-sm ${vert ? 'text-ok' : 'text-doux'}`}>
      <span>{libelle}</span>
      <span className="tabular-nums">{valeur}</span>
    </div>
  );
}

function BoutonNote({ actif, paye, onClick, children }: { actif: boolean; paye?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
        actif ? 'bg-marque text-sur-marque' : paye ? 'bg-ok-tint text-ok' : 'border border-bordure bg-surface text-doux'
      }`}
    >
      {children}
    </button>
  );
}

function ModaleSplit({
  total,
  onConfirmer,
  onFermer,
  enCours,
}: {
  total: number;
  onConfirmer: (notes: { libelle: string; montant: number }[]) => void;
  onFermer: () => void;
  enCours: boolean;
}) {
  const [nb, setNb] = useState(2);
  const base = Math.floor(total / nb);
  const notes = Array.from({ length: nb }, (_, i) => ({
    libelle: `Client ${String.fromCharCode(65 + i)}`,
    montant: i === 0 ? total - base * (nb - 1) : base,
  }));

  return (
    <Modale titre="Diviser la note" onFermer={onFermer} enfants={
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-4">
          <button type="button" className="touche h-14 w-14" onClick={() => setNb(Math.max(2, nb - 1))}>−</button>
          <div className="text-center">
            <div className="text-4xl font-black">{nb}</div>
            <div className="text-sm text-doux">personnes</div>
          </div>
          <button type="button" className="touche h-14 w-14" onClick={() => setNb(Math.min(10, nb + 1))}>+</button>
        </div>
        <div className="space-y-1 text-sm">
          {notes.map((n) => (
            <div key={n.libelle} className="flex justify-between">
              <span>{n.libelle}</span>
              <span className="font-semibold tabular-nums">{formatFCFA(n.montant)}</span>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="h-14 w-full rounded-[13px] bg-marque text-lg font-bold text-sur-marque shadow-e2 transition hover:brightness-105 disabled:opacity-40"
          disabled={enCours}
          onClick={() => onConfirmer(notes)}
        >
          {enCours ? 'Création…' : 'Créer les notes'}
        </button>
      </div>
    } />
  );
}
