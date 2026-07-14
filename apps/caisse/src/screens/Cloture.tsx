import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RapportZ, ReconciliationPreview, UtilisateurPublic } from '@pos/shared';
import { formatFCFA, LIBELLES_MODES, type ModePaiement } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { Numpad } from '../components/Numpad';
import { useCaisse } from '../stores/session';

type Etape = 'compter' | 'saisir' | 'confirmer' | 'rapport';

const LIBELLES_LIVRAISON: Record<string, string> = {
  YANGO: 'Yango',
  GLOVO: 'Glovo',
  SAMER_DELIV: 'Samer Deliv',
};
const PARTENAIRES_ORDRE = ['YANGO', 'GLOVO', 'SAMER_DELIV'];
const MODES_ELECTRO: ModePaiement[] = ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'MOOV_MONEY', 'CARTE', 'DJAMO'];

interface VentesService {
  service: { id: string } | null;
  commandes: { id: string; numero_ticket: number; statut: string; total: number }[];
}

const nombre = (s: string) => Number(s || '0');

/**
 * « J'ai fini » — assistant pas à pas (§15) : Compter → Réconcilier → Confirmer
 * → Ticket. Comptage à l'aveugle préservé : le caissier saisit tout SANS voir
 * l'écart ni le total système ; ceux-ci n'apparaissent qu'au ticket final.
 */
export function Cloture() {
  const { aller, poserSession, afficherToast, session } = useCaisse();
  const queryClient = useQueryClient();
  // « Point à valider » : shift déjà clôturé (machine coupée, reconnexion…) →
  // on démarre directement sur le ticket, sans retour possible.
  const enAttente = session?.cloture_en_attente ?? null;
  const [etape, setEtape] = useState<Etape>(enAttente ? 'rapport' : 'compter');
  const [rapport, setRapport] = useState<RapportZ | null>(enAttente);
  const [enCours, setEnCours] = useState(false);
  const [transfertOuvert, setTransfertOuvert] = useState(false);

  // Saisies de réconciliation
  const [depenses, setDepenses] = useState('');
  const [espece, setEspece] = useState('');
  const [modes, setModes] = useState<Record<string, string>>({});

  const { data: ventes } = useQuery({
    queryKey: ['mes-ventes'],
    queryFn: () => api<VentesService>('/api/rapports/mes-ventes'),
    enabled: etape === 'compter',
  });
  const commandesEnCours = (ventes?.commandes ?? []).filter((c) => c.statut !== 'PAYEE' && c.statut !== 'ANNULEE');

  const { data: preview } = useQuery({
    queryKey: ['recon-preview'],
    queryFn: () => api<ReconciliationPreview>('/api/services/reconciliation-preview'),
    enabled: etape === 'saisir' || etape === 'confirmer',
  });

  // Pré-remplit les modes électroniques depuis le système (modifiables).
  useEffect(() => {
    if (preview && Object.keys(modes).length === 0) {
      setModes(Object.fromEntries(MODES_ELECTRO.map((m) => [m, String(preview.modes[m] ?? 0)])));
    }
  }, [preview, modes]);

  const fond = preview?.fond_de_caisse ?? 0;
  const livraisons = preview?.livraisons ?? {};
  const totalLivraisons = PARTENAIRES_ORDRE.reduce((s, p) => s + (livraisons[p] ?? 0), 0);
  const totalModes = MODES_ELECTRO.reduce((s, m) => s + nombre(modes[m] ?? ''), 0);
  const venteTotale = nombre(depenses) + totalLivraisons + totalModes + nombre(espece) - fond;
  const especeValide = espece !== '' && nombre(espece) >= 0;

  const cloturer = async () => {
    setEnCours(true);
    try {
      const z = await api<RapportZ>('/api/services/cloturer', {
        method: 'POST',
        corps: {
          especes_comptees: nombre(espece),
          depenses: nombre(depenses),
          livraisons,
          modes: Object.fromEntries(MODES_ELECTRO.map((m) => [m, nombre(modes[m] ?? '')])),
        },
      });
      setRapport(z);
      setEtape('rapport');
    } catch (e) {
      afficherToast((e as Error).message);
      setEtape('saisir');
    } finally {
      setEnCours(false);
    }
  };

  const terminer = async () => {
    // Accuse la fin du shift (le « point à valider » disparaît) puis déconnecte.
    try {
      await api('/api/services/remettre-cloture', { method: 'POST' });
    } catch { /* ignore */ }
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    poserSession(null);
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-between text-sm text-doux">
          {(['compter', 'saisir', 'confirmer', 'rapport'] as Etape[]).map((e, i) => (
            <span key={e} className={etape === e ? 'font-bold text-marque-fonce' : ''}>
              {i + 1}. {{ compter: 'Compter', saisir: 'Réconcilier', confirmer: 'Confirmer', rapport: 'Ticket' }[e]}
            </span>
          ))}
        </div>

        {etape === 'compter' && (
          <div className="carte space-y-4 p-6 text-center">
            <h1 className="text-2xl font-bold">Comptez votre caisse</h1>
            {commandesEnCours.length > 0 && (
              <div className="rounded-xl bg-alerte-tint p-4 text-left">
                <div className="font-semibold text-marque-fonce">{commandesEnCours.length} commande(s) non encaissée(s)</div>
                <p className="mt-1 text-sm text-doux">Encaissez-les, ou confiez-les au caissier suivant (il accepte avec son PIN).</p>
                <div className="mt-2 max-h-24 overflow-y-auto text-sm text-doux">
                  {commandesEnCours.map((c) => (
                    <div key={c.id}>Ticket n° {c.numero_ticket} — {formatFCFA(c.total)}</div>
                  ))}
                </div>
                <button type="button" className="btn-accent mt-3 w-full" onClick={() => setTransfertOuvert(true)}>Transférer au caissier suivant</button>
              </div>
            )}
            <p className="text-doux">Comptez TOUTES les espèces du tiroir (fond inclus), à l’abri des regards. Le montant attendu n’apparaîtra qu’après validation.</p>
            <button type="button" className="btn-accent w-full py-4 text-lg" disabled={commandesEnCours.length > 0} onClick={() => setEtape('saisir')}>
              {commandesEnCours.length > 0 ? 'Commandes en cours à régler d’abord' : 'J’ai compté'}
            </button>
            <button type="button" className="btn-blanc w-full" onClick={() => aller('accueil')}>← Revenir à l’accueil</button>
          </div>
        )}

        {etape === 'saisir' && (
          <div className="carte space-y-4 p-6">
            <h1 className="text-center text-2xl font-bold">Réconciliation</h1>
            <div className="flex justify-between rounded-xl bg-surface-douce px-4 py-2 text-sm">
              <span className="text-doux">Fond de caisse</span>
              <span className="font-semibold tabular-nums">{formatFCFA(fond)}</span>
            </div>

            <ChampMontant libelle="Dépenses" valeur={depenses} onChange={setDepenses} />

            <div className="space-y-1">
              <div className="text-sm font-semibold text-doux">Livraisons (auto)</div>
              {PARTENAIRES_ORDRE.map((p) => (
                <div key={p} className="flex items-center justify-between rounded-lg border border-bordure bg-surface px-4 py-2 text-sm">
                  <span>{LIBELLES_LIVRAISON[p] ?? p}</span>
                  <span className="font-semibold tabular-nums">{formatFCFA(livraisons[p] ?? 0)}</span>
                </div>
              ))}
            </div>

            <div className="space-y-1">
              <div className="text-sm font-semibold text-doux">Encaissements électroniques (modifiables)</div>
              {MODES_ELECTRO.map((m) => (
                <ChampMontant key={m} libelle={LIBELLES_MODES[m]} valeur={modes[m] ?? ''} onChange={(v) => setModes((prev) => ({ ...prev, [m]: v }))} compact />
              ))}
            </div>

            <ChampMontant libelle="Espèce en caisse (comptée)" valeur={espece} onChange={setEspece} accent />

            <div className="flex items-baseline justify-between border-t border-bordure pt-3">
              <span className="text-sm text-doux">Total de mes saisies</span>
              <span className="text-xl font-black text-marque-fonce tabular-nums">{formatFCFA(venteTotale)}</span>
            </div>

            <button type="button" className="btn-accent w-full py-4 text-lg" disabled={!especeValide} onClick={() => setEtape('confirmer')}>
              {especeValide ? 'Continuer' : 'Saisissez l’espèce comptée'}
            </button>
            <button type="button" className="btn-blanc w-full" onClick={() => setEtape('compter')}>← Retour</button>
          </div>
        )}

        {etape === 'confirmer' && (
          <div className="carte space-y-4 p-6 text-center">
            <h1 className="text-2xl font-bold">Confirmer la clôture ?</h1>
            <div className="text-4xl font-black text-marque-fonce">{formatFCFA(nombre(espece))}</div>
            <div className="text-sm text-doux">espèce comptée · dépenses {formatFCFA(nombre(depenses))}</div>
            <p className="text-doux">Action définitive : le shift sera clôturé et le ticket figé.</p>
            <button type="button" className="btn-accent w-full py-4 text-lg" disabled={enCours} onClick={cloturer}>
              {enCours ? 'Clôture…' : 'Clôturer le shift'}
            </button>
            <button type="button" className="btn-blanc w-full" disabled={enCours} onClick={() => setEtape('saisir')}>← Corriger</button>
          </div>
        )}

        {etape === 'rapport' && rapport && (
          <div className="carte space-y-3 p-6">
            <h1 className="text-center text-2xl font-bold">Ticket de clôture</h1>
            <div className="text-center text-sm text-doux">{rapport.caissier} — {new Date(rapport.cloture_le).toLocaleString('fr-FR')}</div>

            <div className={`rounded-xl p-4 text-center ${rapport.ecart !== 0 ? 'bg-alerte-tint' : 'bg-ok-tint'}`}>
              <div className="text-sm text-doux">Écart de caisse (espèces)</div>
              <div className="text-4xl font-black">{rapport.ecart > 0 ? '+' : ''}{formatFCFA(rapport.ecart)}</div>
              <div className="mt-1 text-xs text-doux">Comptées {formatFCFA(rapport.especes_comptees)} / Théoriques {formatFCFA(rapport.especes_theorique)}</div>
            </div>

            <div className="space-y-1 text-sm">
              <Ligne libelle="Fond de caisse" valeur={formatFCFA(rapport.fond_de_caisse)} />
              <Ligne libelle="Dépenses" valeur={formatFCFA(rapport.depenses)} />
              {PARTENAIRES_ORDRE.filter((p) => (rapport.livraisons[p] ?? 0) > 0).map((p) => (
                <Ligne key={p} libelle={LIBELLES_LIVRAISON[p] ?? p} valeur={formatFCFA(rapport.livraisons[p] ?? 0)} />
              ))}
              {MODES_ELECTRO.filter((m) => (rapport.modes_declares[m] ?? 0) > 0).map((m) => (
                <Ligne key={m} libelle={LIBELLES_MODES[m]} valeur={formatFCFA(rapport.modes_declares[m] ?? 0)} />
              ))}
              <div className="border-t border-bordure pt-1" />
              <Ligne libelle="Vente totale (réconciliée)" valeur={formatFCFA(rapport.vente_totale)} fort />
              <Ligne libelle="Total système" valeur={formatFCFA(rapport.total_systeme)} />
              <div className={`flex justify-between font-bold ${rapport.diff < 0 ? 'text-alerte' : 'text-ok'}`}>
                <span>Écart réconciliation</span>
                <span className="tabular-nums">{rapport.diff > 0 ? '+' : ''}{formatFCFA(rapport.diff)}</span>
              </div>
            </div>

            <p className="text-center text-xs text-doux">Vente validée — vous devez terminer pour clôturer le point.</p>
            <button type="button" className="btn-accent w-full py-4 text-lg" onClick={terminer}>Valider & terminer — se déconnecter</button>
          </div>
        )}
      </div>

      {transfertOuvert && (
        <ModaleTransfert
          moiId={session?.utilisateur.id ?? ''}
          onTransfere={(resultat) => {
            setTransfertOuvert(false);
            void queryClient.invalidateQueries({ queryKey: ['mes-ventes'] });
            afficherToast(`${resultat.nb_transferees} commande(s) transférée(s) à ${resultat.receveur} ✔`);
          }}
          onFermer={() => setTransfertOuvert(false)}
        />
      )}
    </div>
  );
}

/** Champ de saisie de montant (FCFA, entier ≥ 0). */
function ChampMontant({
  libelle,
  valeur,
  onChange,
  accent,
  compact,
}: {
  libelle: string;
  valeur: string;
  onChange: (v: string) => void;
  accent?: boolean;
  compact?: boolean;
}) {
  return (
    <label className={`flex items-center justify-between gap-3 ${compact ? 'rounded-lg border border-bordure bg-surface px-4 py-1.5' : ''}`}>
      <span className={`text-sm ${accent ? 'font-bold text-marque-fonce' : 'text-doux'}`}>{libelle}</span>
      <input
        className={`champ w-40 text-right ${accent ? 'border-marque' : ''} ${compact ? 'h-10' : ''}`}
        inputMode="numeric"
        value={valeur}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        placeholder="0"
      />
    </label>
  );
}

function ModaleTransfert({
  moiId,
  onTransfere,
  onFermer,
}: {
  moiId: string;
  onTransfere: (r: { nb_transferees: number; receveur: string }) => void;
  onFermer: () => void;
}) {
  const { afficherToast } = useCaisse();
  const [receveur, setReceveur] = useState<UtilisateurPublic | null>(null);
  const [pin, setPin] = useState('');
  const [enCours, setEnCours] = useState(false);

  const { data: utilisateurs } = useQuery({
    queryKey: ['utilisateurs-login'],
    queryFn: () => api<UtilisateurPublic[]>('/api/auth/utilisateurs'),
  });
  const candidats = (utilisateurs ?? []).filter(
    (u) => u.id !== moiId && (u.role === 'CAISSIER' || u.role === 'MANAGER' || u.role === 'PROPRIETAIRE'),
  );

  const transferer = async () => {
    if (!receveur) return;
    setEnCours(true);
    try {
      const resultat = await api<{ nb_transferees: number; receveur: string }>('/api/services/transferer', {
        method: 'POST',
        corps: { receveur_id: receveur.id, pin_receveur: pin },
      });
      onTransfere(resultat);
    } catch (e) {
      afficherToast((e as Error).message);
      setPin('');
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modale titre="Transférer au caissier suivant" onFermer={onFermer} enfants={
      !receveur ? (
        <div className="space-y-2">
          <p className="text-sm text-doux">Qui prend la relève ?</p>
          {candidats.map((u) => (
            <button key={u.id} type="button" className="carte w-full p-4 text-left hover:border-marque" onClick={() => setReceveur(u)}>
              <div className="font-bold">{u.nom_complet}</div>
              <div className="text-sm text-doux">{u.role === 'CAISSIER' ? 'Caissier' : u.role === 'MANAGER' ? 'Manager' : 'Propriétaire'}</div>
            </button>
          ))}
          {candidats.length === 0 && <div className="text-doux">Aucun autre caissier disponible.</div>}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-doux">
            <span className="font-semibold text-fort">{receveur.nom_complet}</span> accepte en saisissant <span className="font-semibold text-fort">son propre PIN</span>.
          </p>
          <div className="champ flex items-center justify-center text-2xl tracking-[0.5em]">
            {'•'.repeat(pin.length) || <span className="text-base tracking-normal text-doux">PIN du receveur…</span>}
          </div>
          <Numpad valeur={pin} onChange={setPin} longueurMax={6} onValider={transferer} libelleValider={enCours ? 'Transfert…' : 'Accepter le transfert'} validerDesactive={pin.length < 4 || enCours} />
          <button type="button" className="btn-blanc w-full" onClick={() => { setReceveur(null); setPin(''); }}>← Changer de caissier</button>
        </div>
      )
    } />
  );
}

function Ligne({ libelle, valeur, fort }: { libelle: string; valeur: string; fort?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={fort ? 'font-semibold' : 'text-doux'}>{libelle}</span>
      <span className="font-semibold tabular-nums">{valeur}</span>
    </div>
  );
}
