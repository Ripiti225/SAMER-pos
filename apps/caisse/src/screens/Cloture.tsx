import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { RapportZ, UtilisateurPublic } from '@pos/shared';
import { formatFCFA, LIBELLES_MODES, type ModePaiement } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { Numpad } from '../components/Numpad';
import { useCaisse } from '../stores/session';

type Etape = 'compter' | 'saisir' | 'confirmer' | 'rapport';

/**
 * « J'ai fini » — assistant pas à pas, aucune étape sautable (§15) :
 * Compter → Saisir → Confirmer → Rapport Z.
 * Le théorique n'apparaît qu'à la dernière étape, renvoyé par le serveur
 * APRÈS enregistrement du comptage (comptage à l'aveugle §14.3).
 */
interface VentesService {
  service: { id: string } | null;
  commandes: { id: string; numero_ticket: number; statut: string; total: number }[];
}

export function Cloture() {
  const { aller, poserSession, afficherToast, session } = useCaisse();
  const queryClient = useQueryClient();
  const [etape, setEtape] = useState<Etape>('compter');
  const [montant, setMontant] = useState('');
  const [rapport, setRapport] = useState<RapportZ | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [transfertOuvert, setTransfertOuvert] = useState(false);

  // Commandes non encaissées du service : à encaisser, annuler… ou transférer
  const { data: ventes } = useQuery({
    queryKey: ['mes-ventes'],
    queryFn: () => api<VentesService>('/api/rapports/mes-ventes'),
    enabled: etape === 'compter',
  });
  const commandesEnCours = (ventes?.commandes ?? []).filter(
    (c) => c.statut !== 'PAYEE' && c.statut !== 'ANNULEE',
  );

  const cloturer = async () => {
    setEnCours(true);
    try {
      const z = await api<RapportZ>('/api/services/cloturer', {
        method: 'POST',
        corps: { especes_comptees: Number(montant) },
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
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    poserSession(null);
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="mb-6 flex items-center justify-between text-sm text-zinc-400">
          {(['compter', 'saisir', 'confirmer', 'rapport'] as Etape[]).map((e, i) => (
            <span key={e} className={etape === e ? 'font-bold text-accent' : ''}>
              {i + 1}. {{ compter: 'Compter', saisir: 'Saisir', confirmer: 'Confirmer', rapport: 'Rapport Z' }[e]}
            </span>
          ))}
        </div>

        {etape === 'compter' && (
          <div className="carte space-y-4 p-6 text-center">
            <h1 className="text-2xl font-bold">Comptez votre caisse</h1>

            {commandesEnCours.length > 0 && (
              <div className="rounded-xl bg-amber-950 p-4 text-left">
                <div className="font-semibold text-amber-300">
                  {commandesEnCours.length} commande(s) non encaissée(s)
                </div>
                <p className="mt-1 text-sm text-zinc-300">
                  Encaissez-les, ou confiez-les au caissier suivant : il devra accepter
                  le transfert en saisissant son propre PIN.
                </p>
                <div className="mt-2 max-h-24 overflow-y-auto text-sm text-zinc-400">
                  {commandesEnCours.map((c) => (
                    <div key={c.id}>Ticket n° {c.numero_ticket} — {formatFCFA(c.total)}</div>
                  ))}
                </div>
                <button type="button" className="btn-accent mt-3 w-full" onClick={() => setTransfertOuvert(true)}>
                  Transférer au caissier suivant
                </button>
              </div>
            )}

            <p className="text-zinc-400">
              Comptez TOUTES les espèces du tiroir (fond de caisse inclus), à l’abri des regards.
              Le montant attendu ne sera affiché qu’après votre saisie.
            </p>
            <button
              type="button"
              className="btn-accent w-full py-4 text-lg"
              disabled={commandesEnCours.length > 0}
              onClick={() => setEtape('saisir')}
            >
              {commandesEnCours.length > 0 ? 'Commandes en cours à régler d’abord' : 'J’ai compté'}
            </button>
            <button type="button" className="btn-sombre w-full" onClick={() => aller('accueil')}>
              ← Revenir à l’accueil
            </button>
          </div>
        )}

        {etape === 'saisir' && (
          <div className="carte space-y-3 p-6">
            <h1 className="text-center text-2xl font-bold">Espèces comptées</h1>
            <div className="champ flex items-center justify-center text-3xl font-bold">
              {montant ? formatFCFA(Number(montant)) : <span className="text-base font-normal text-zinc-500">Montant compté…</span>}
            </div>
            <Numpad
              valeur={montant}
              onChange={setMontant}
              onValider={() => setEtape('confirmer')}
              libelleValider="Continuer"
              validerDesactive={montant === ''}
            />
          </div>
        )}

        {etape === 'confirmer' && (
          <div className="carte space-y-4 p-6 text-center">
            <h1 className="text-2xl font-bold">Confirmer la clôture ?</h1>
            <div className="text-4xl font-black text-accent">{formatFCFA(Number(montant))}</div>
            <p className="text-zinc-400">
              Cette action est définitive : le service sera clôturé et le rapport Z figé.
            </p>
            <button type="button" className="btn-accent w-full py-4 text-lg" disabled={enCours} onClick={cloturer}>
              {enCours ? 'Clôture…' : 'Clôturer le service'}
            </button>
            <button type="button" className="btn-sombre w-full" disabled={enCours} onClick={() => setEtape('saisir')}>
              ← Corriger le montant
            </button>
          </div>
        )}

        {etape === 'rapport' && rapport && (
          <div className="carte space-y-3 p-6">
            <h1 className="text-center text-2xl font-bold">Rapport Z</h1>
            <div className="text-center text-sm text-zinc-400">
              {rapport.caissier} — service du {new Date(rapport.ouvert_le).toLocaleString('fr-FR')}
            </div>

            <div className={`rounded-xl p-4 text-center ${Math.abs(rapport.ecart) > 0 ? (Math.abs(rapport.ecart) > 2000 ? 'bg-red-950' : 'bg-amber-950') : 'bg-emerald-950'}`}>
              <div className="text-sm text-zinc-300">Écart de caisse</div>
              <div className="text-4xl font-black">{rapport.ecart > 0 ? '+' : ''}{formatFCFA(rapport.ecart)}</div>
              <div className="mt-1 text-xs text-zinc-400">
                Comptées {formatFCFA(rapport.especes_comptees)} / Théoriques {formatFCFA(rapport.especes_theorique)}
              </div>
            </div>

            <div className="space-y-1 text-sm">
              <Ligne libelle="Commandes encaissées" valeur={String(rapport.nb_commandes_payees)} />
              <Ligne libelle="Commandes annulées" valeur={String(rapport.nb_commandes_annulees)} />
              <Ligne libelle="Total ventes" valeur={formatFCFA(rapport.total_ventes)} />
              <Ligne libelle="Remises" valeur={formatFCFA(rapport.total_remises)} />
              <Ligne libelle="Promotions" valeur={formatFCFA(rapport.total_promos)} />
              <div className="border-t border-zinc-800 pt-1" />
              {(Object.entries(rapport.par_mode) as [ModePaiement, number][])
                .filter(([, v]) => v > 0)
                .map(([m, v]) => (
                  <Ligne key={m} libelle={LIBELLES_MODES[m]} valeur={formatFCFA(v)} />
                ))}
              {Object.keys(rapport.partenaires).length > 0 && (
                <>
                  <div className="border-t border-zinc-800 pt-1 font-semibold">Partenaires livraison</div>
                  {Object.entries(rapport.partenaires).map(([p, s]) => (
                    <Ligne key={p} libelle={`${p} (${s.nb} commandes)`} valeur={formatFCFA(s.total)} />
                  ))}
                </>
              )}
            </div>

            <button type="button" className="btn-accent w-full py-4 text-lg" onClick={terminer}>
              Terminer — se déconnecter
            </button>
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

/**
 * Relève de caisse : choix du caissier suivant, puis ACCEPTATION par le
 * receveur qui saisit son propre PIN sur ce terminal.
 */
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
          <p className="text-sm text-zinc-400">Qui prend la relève ?</p>
          {candidats.map((u) => (
            <button
              key={u.id}
              type="button"
              className="carte w-full p-4 text-left hover:border-accent"
              onClick={() => setReceveur(u)}
            >
              <div className="font-bold">{u.nom_complet}</div>
              <div className="text-sm text-zinc-400">{u.role === 'CAISSIER' ? 'Caissier' : u.role === 'MANAGER' ? 'Manager' : 'Propriétaire'}</div>
            </button>
          ))}
          {candidats.length === 0 && <div className="text-zinc-400">Aucun autre caissier disponible.</div>}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-zinc-400">
            <span className="font-semibold text-zinc-200">{receveur.nom_complet}</span> accepte le
            transfert en saisissant <span className="font-semibold text-zinc-200">son propre PIN</span>.
          </p>
          <div className="champ flex items-center justify-center text-2xl tracking-[0.5em]">
            {'•'.repeat(pin.length) || <span className="text-base tracking-normal text-zinc-500">PIN du receveur…</span>}
          </div>
          <Numpad
            valeur={pin}
            onChange={setPin}
            longueurMax={6}
            onValider={transferer}
            libelleValider={enCours ? 'Transfert…' : 'Accepter le transfert'}
            validerDesactive={pin.length < 4 || enCours}
          />
          <button type="button" className="btn-sombre w-full" onClick={() => { setReceveur(null); setPin(''); }}>
            ← Changer de caissier
          </button>
        </div>
      )
    } />
  );
}

function Ligne({ libelle, valeur }: { libelle: string; valeur: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-400">{libelle}</span>
      <span className="font-semibold">{valeur}</span>
    </div>
  );
}
