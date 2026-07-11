import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CommandeVue, ModePaiement } from '@pos/shared';
import { formatFCFA, LIBELLES_MODES, MODES_PAIEMENT } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { Numpad } from '../components/Numpad';
import { Fidelite } from '../components/Fidelite';
import { imprimerRecuNavigateur } from '../facture';
import { useCaisse } from '../stores/session';

export function Paiement() {
  const { commandeId, aller, afficherToast, session } = useCaisse();
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
      if (vue.statut === 'PAYEE') {
        afficherToast(`Ticket n° ${vue.numero_ticket} encaissé ✔`);
        // Reçu thermique automatique à l'encaissement complet.
        if (session) imprimerRecuNavigateur(vue, session.restaurant, 'RECU');
      }
    },
    onError: (e: Error) => afficherToast(e.message),
  });

  const creerSplit = useMutation({
    mutationFn: (notes: { libelle: string; montant: number }[]) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/split`, { method: 'POST', corps: { notes } }),
    onSuccess: (vue) => {
      rafraichir(vue);
      setSplitOuvert(false);
    },
    onError: (e: Error) => afficherToast(e.message),
  });

  if (!commande) {
    return <div className="flex min-h-full items-center justify-center text-doux">Chargement…</div>;
  }

  const noteActive = commande.notes.find((n) => n.id === noteId) ?? null;
  const resteCible = noteActive ? noteActive.reste : commande.reste;
  const montantSaisi = montant === '' ? resteCible : Number(montant);
  const donnees = Number(especesDonnees || '0');
  const monnaie = mode === 'ESPECES' && donnees > montantSaisi ? donnees - montantSaisi : 0;
  const estPayee = commande.statut === 'PAYEE';

  return (
    <div className="flex min-h-screen flex-col p-4">
      <header className="mb-4 flex items-center gap-3">
        <button type="button" className="btn-blanc" onClick={() => aller('commande', commande.id)} disabled={estPayee}>
          ← Commande
        </button>
        <h1 className="text-xl font-bold">Paiement — Ticket n° {commande.numero_ticket}</h1>
        {commande.notes.length === 0 && !estPayee && (
          <button type="button" className="btn-blanc ml-auto" onClick={() => setSplitOuvert(true)}>
            Diviser la note
          </button>
        )}
      </header>

      {/* Reste à payer en TRÈS grand (§ paiement mixte) */}
      <div className="carte mb-4 p-6 text-center">
        <div className="text-doux">{estPayee ? 'Commande encaissée' : noteActive ? `Reste à payer — ${noteActive.libelle}` : 'Reste à payer'}</div>
        <div className={`text-7xl font-black ${estPayee ? 'text-ok' : 'text-marque-fonce'}`}>
          {formatFCFA(resteCible)}
        </div>
        <div className="mt-1 text-sm text-doux">
          Total {formatFCFA(commande.total)} — déjà payé {formatFCFA(commande.paye)}
        </div>
      </div>

      {!estPayee && (
        <Fidelite
          commande={commande}
          onMaj={(vue) => queryClient.setQueryData(['commande', commandeId], vue)}
        />
      )}

      {commande.notes.length > 0 && !estPayee && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button type="button" className={`btn ${noteId === null ? 'bg-marque text-white' : 'border border-bordure bg-surface'}`} onClick={() => setNoteId(null)}>
            Toute la commande
          </button>
          {commande.notes.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`btn ${noteId === n.id ? 'bg-marque text-white' : n.reste === 0 ? 'bg-surface text-ok' : 'border border-bordure bg-surface'}`}
              onClick={() => setNoteId(n.id)}
            >
              {n.libelle} — {n.reste === 0 ? 'payée ✔' : formatFCFA(n.reste)}
            </button>
          ))}
        </div>
      )}

      {!estPayee && (
        <div className="grid flex-1 gap-4 lg:grid-cols-2">
          <div>
            <div className="mb-2 font-semibold text-doux">Mode de paiement</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {MODES_PAIEMENT.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn min-h-[64px] ${mode === m ? 'bg-marque text-white' : 'border border-bordure bg-surface'}`}
                  onClick={() => setMode(m)}
                >
                  {LIBELLES_MODES[m]}
                </button>
              ))}
            </div>

            {mode === 'ESPECES' && (
              <div className="mt-4">
                <label className="mb-1 block text-sm text-doux">Montant donné par le client (optionnel)</label>
                <input
                  className="champ"
                  inputMode="numeric"
                  value={especesDonnees}
                  onChange={(e) => setEspecesDonnees(e.target.value.replace(/\D/g, ''))}
                  placeholder="ex : 10000"
                />
                {monnaie > 0 && (
                  <div className="mt-2 text-lg">
                    Monnaie à rendre : <span className="font-bold text-marque-fonce">{formatFCFA(monnaie)}</span>
                  </div>
                )}
              </div>
            )}

            <div className="mt-4 space-y-1 text-sm text-doux">
              {commande.paiements.map((p) => (
                <div key={p.id} className="flex justify-between">
                  <span>{LIBELLES_MODES[p.mode]}</span>
                  <span>{formatFCFA(p.montant)}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 font-semibold text-doux">Montant encaissé</div>
            <div className="champ mb-2 flex items-center justify-center text-3xl font-bold">
              {formatFCFA(montantSaisi)}
            </div>
            <Numpad
              valeur={montant}
              onChange={setMontant}
              onValider={() =>
                encaisser.mutate({ mode, montant: montantSaisi, note_id: noteId })
              }
              libelleValider={encaisser.isPending ? 'Encaissement…' : `Encaisser ${LIBELLES_MODES[mode]}`}
              validerDesactive={montantSaisi <= 0 || montantSaisi > resteCible || encaisser.isPending}
            />
            {montantSaisi > resteCible && (
              <div className="mt-2 text-sm text-alerte">Le montant dépasse le reste à payer</div>
            )}
          </div>
        </div>
      )}

      {/* Bouton Valider : désactivé tant que reste > 0 (règle §5.5) */}
      <button
        type="button"
        className="btn-ok mt-4 py-5 text-2xl"
        disabled={commande.reste > 0}
        onClick={() => aller('accueil')}
      >
        {estPayee ? 'Terminer — retour à l’accueil' : `Valider (reste ${formatFCFA(commande.reste)})`}
      </button>

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

  // Répartition égale : la somme des notes doit valoir exactement le total
  const base = Math.floor(total / nb);
  const notes = Array.from({ length: nb }, (_, i) => ({
    libelle: `Client ${String.fromCharCode(65 + i)}`,
    montant: i === 0 ? total - base * (nb - 1) : base,
  }));

  return (
    <Modale titre="Diviser la note" onFermer={onFermer} enfants={
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-4">
          <button type="button" className="btn-blanc h-14 w-14 p-0 text-2xl" onClick={() => setNb(Math.max(2, nb - 1))}>−</button>
          <div className="text-center">
            <div className="text-4xl font-black">{nb}</div>
            <div className="text-sm text-doux">personnes</div>
          </div>
          <button type="button" className="btn-blanc h-14 w-14 p-0 text-2xl" onClick={() => setNb(Math.min(10, nb + 1))}>+</button>
        </div>
        <div className="space-y-1 text-sm">
          {notes.map((n) => (
            <div key={n.libelle} className="flex justify-between">
              <span>{n.libelle}</span>
              <span className="font-semibold">{formatFCFA(n.montant)}</span>
            </div>
          ))}
        </div>
        <button type="button" className="btn-accent w-full py-4" disabled={enCours} onClick={() => onConfirmer(notes)}>
          {enCours ? 'Création…' : 'Créer les notes'}
        </button>
      </div>
    } />
  );
}
