import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RapportZ, ReconciliationPreview, UtilisateurPublic } from '@pos/shared';
import { formatFCFA, libellePartenaire, LIBELLES_MODES, type ModePaiement, PARTENAIRES } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { Numpad } from '../components/Numpad';
import { ModaleDeblocage } from './Inventaire';
import { useCaisse } from '../stores/session';

type Etape = 'compter' | 'saisir' | 'confirmer' | 'rapport';

/** État léger de l'inventaire : sert le verrou d'étape 1, ne crée rien. */
interface EtatInventaire {
  commence: boolean;
  valide: boolean;
  debloque: boolean;
  restants_a_compter: number | null;
}

const PARTENAIRES_ORDRE = [...PARTENAIRES];
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
  const [deblocageOuvert, setDeblocageOuvert] = useState(false);

  // Saisies de réconciliation. Les DÉPENSES n'en font plus partie (§ 6.8) :
  // elles sont la somme du registre, calculée par le serveur et affichée ici en
  // lecture seule — la caissière ne retape rien.
  const [espece, setEspece] = useState('');
  const [modes, setModes] = useState<Record<string, string>>({});

  const { data: ventes } = useQuery({
    queryKey: ['mes-ventes'],
    queryFn: () => api<VentesService>('/api/rapports/mes-ventes'),
    enabled: etape === 'compter',
  });
  const commandesEnCours = (ventes?.commandes ?? []).filter((c) => c.statut !== 'PAYEE' && c.statut !== 'ANNULEE');

  // Verrou d'étape 1 (§ 6.10) : sans inventaire validé, pas de clôture. Le
  // serveur applique la même règle — cet écran ne fait que la refléter, et
  // surtout l'expliquer AVANT que le caissier ne compte son tiroir pour rien.
  const { data: inventaire } = useQuery({
    queryKey: ['inventaire-etat'],
    queryFn: () => api<EtatInventaire>('/api/inventaire/etat'),
    enabled: etape === 'compter' && !enAttente,
  });
  const inventaireBloque = !!inventaire && !inventaire.valide && !inventaire.debloque;

  // Décompte des départs, annoncé AVANT la validation (§ 6.8) : la clôture
  // enregistre comme PARTI tout ce qui n'est pas marqué « Reste », et c'est
  // irréversible — le caissier doit le voir venir.
  const { data: equipe } = useQuery({
    queryKey: ['pointage'],
    queryFn: () => api<{ membres: { reste: boolean | null; pointe_le: string | null }[] }>('/api/pointage'),
    enabled: etape === 'confirmer',
  });
  const membres = equipe?.membres ?? [];
  const restent = membres.filter((m) => m.reste === true).length;
  const partent = membres.filter((m) => m.reste !== true).length;

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
  const offerts = preview?.offerts ?? { nb: 0, total: 0 };
  const depenses = preview?.depenses ?? { total: 0, nb_lignes: 0 };
  const retours = preview?.retours ?? { nb: 0, montant: 0, par_produit: [], detail: [] };
  const totalLivraisons = PARTENAIRES_ORDRE.reduce((s, p) => s + (livraisons[p] ?? 0), 0);
  const totalModes = MODES_ELECTRO.reduce((s, m) => s + nombre(modes[m] ?? ''), 0);
  // Les Kdo entrent dans la vente sans passer par le tiroir : vendre 25 000 et
  // offrir 5 000 affiche bien 30 000. Le même calcul est refait côté serveur à
  // la clôture — les deux doivent donner le même chiffre, sinon le caissier
  // verrait un total différent de celui figé sur son ticket.
  const venteTotale = depenses.total + totalLivraisons + totalModes + offerts.total + nombre(espece) - fond;
  const especeValide = espece !== '' && nombre(espece) >= 0;

  const cloturer = async () => {
    setEnCours(true);
    try {
      const z = await api<RapportZ>('/api/services/cloturer', {
        method: 'POST',
        corps: {
          especes_comptees: nombre(espece),
          // `depenses` n'est plus envoyé : le serveur additionne le registre.
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
            {/* Verrou d'inventaire (§ 6.10) : annoncé ICI, avant que le
                caissier ne compte son tiroir pour se heurter au refus ensuite. */}
            {inventaireBloque && (
              <div className="rounded-xl bg-alerte-tint p-4 text-left">
                <div className="font-semibold text-alerte-txt">Inventaire non validé</div>
                <p className="mt-1 text-sm text-alerte-txt/85">
                  {inventaire?.restants_a_compter
                    ? `Il reste ${inventaire.restants_a_compter} produit(s) à compter.`
                    : 'Le comptage du stock doit être validé avant de clôturer.'}{' '}
                  Sans inventaire validé, la caisse ne peut pas être fermée.
                </p>
                <button type="button" className="btn-accent mt-3 w-full" onClick={() => aller('inventaire')}>
                  Aller à l’inventaire
                </button>
                <button type="button" className="btn-blanc mt-2 w-full" onClick={() => setDeblocageOuvert(true)}>
                  Débloquer (manager)
                </button>
              </div>
            )}

            <p className="text-doux">Comptez TOUTES les espèces du tiroir (fond inclus), à l’abri des regards. Le montant attendu n’apparaîtra qu’après validation.</p>
            <button
              type="button"
              className="btn-accent w-full py-4 text-lg"
              disabled={commandesEnCours.length > 0 || inventaireBloque}
              onClick={() => setEtape('saisir')}
            >
              {commandesEnCours.length > 0
                ? 'Commandes en cours à régler d’abord'
                : inventaireBloque
                  ? 'Inventaire à valider d’abord'
                  : 'J’ai compté'}
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

            {/* Dépenses : reportées du registre, en LECTURE SEULE (§ 6.10).
                Un total tapé à la main pouvait diverger de ses propres lignes. */}
            <div className="flex items-center justify-between rounded-xl bg-surface-douce px-4 py-2 text-sm">
              <span className="text-doux">
                Dépenses{' '}
                <span className="text-xs">
                  ({depenses.nb_lignes} ligne{depenses.nb_lignes > 1 ? 's' : ''} du registre)
                </span>
              </span>
              <span className="font-semibold tabular-nums">{formatFCFA(depenses.total)}</span>
            </div>
            <button type="button" className="-mt-2 text-left text-xs font-semibold text-marque-sur-plan" onClick={() => aller('depenses')}>
              Voir ou corriger le registre des dépenses →
            </button>

            {/* RETOURS : articles déjà partis en cuisine puis supprimés au PIN
                manager. En lecture seule, et volontairement à côté des dépenses
                sans jamais s'y ajouter : un retour ne sort pas d'argent du
                tiroir, il ne change ni la vente ni l'inventaire. Il est là pour
                être VU — c'est ce qui dit si un site refait souvent ses plats. */}
            {retours.nb > 0 && (
              <div className="rounded-xl border border-bordure bg-surface px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold text-fort">
                    Retours{' '}
                    <span className="text-xs font-normal text-doux">
                      ({retours.nb} article{retours.nb > 1 ? 's' : ''} refait{retours.nb > 1 ? 's' : ''})
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums text-doux">{formatFCFA(retours.montant)}</span>
                </div>
                <div className="mt-2 space-y-0.5">
                  {retours.par_produit.map((p) => (
                    <div key={p.nom} className="flex justify-between text-xs text-doux">
                      <span className="truncate">{p.quantite} × {p.nom}</span>
                      <span className="tabular-nums">{formatFCFA(p.montant)}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-doux">
                  Lancés en cuisine puis annulés par un manager. <b>Hors vente et hors tiroir</b> — rien à
                  compter ici.
                </p>
              </div>
            )}

            <div className="space-y-1">
              {/* Livraisons : LECTURE SEULE, décision du boss (2026-08-15). Le
                  POS est la source officielle des ventes ; laisser retoucher le
                  montant d'un partenaire ouvrirait un écart entre le ticket Z et
                  les commandes réellement enregistrées. Les Kdo aussi : aucun
                  argent reçu, rien à déclarer — mais le caissier doit les voir. */}
              <div className="text-sm font-semibold text-doux">Livraisons (auto)</div>
              {PARTENAIRES_ORDRE.map((p) => (
                <div key={p} className="flex items-center justify-between rounded-lg border border-bordure bg-surface px-4 py-2 text-sm">
                  <span>{libellePartenaire(p)}</span>
                  <span className="font-semibold tabular-nums">{formatFCFA(livraisons[p] ?? 0)}</span>
                </div>
              ))}
              {offerts.total > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-bordure bg-surface px-4 py-2 text-sm">
                  <span>Kdo offerts ({offerts.nb})</span>
                  <span className="font-semibold tabular-nums">{formatFCFA(offerts.total)}</span>
                </div>
              )}
            </div>
            {offerts.total > 0 && (
              <p className="text-xs text-doux">
                Les Kdo comptent dans la vente mais pas dans le tiroir : ne les cherchez pas dans vos espèces.
              </p>
            )}

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
            <div className="text-sm text-doux">espèce comptée · dépenses {formatFCFA(depenses.total)}</div>
            {membres.length > 0 && (
              <div className="rounded-xl bg-surface-douce p-4 text-left text-sm">
                <div className="font-semibold text-fort">Équipe du jour</div>
                <p className="mt-1 text-doux">
                  <b className="text-fort">{restent}</b> reste{restent > 1 ? 'nt' : ''} ·{' '}
                  <b className="text-fort">{partent}</b> {partent > 1 ? 'seront enregistrés' : 'sera enregistré'} comme
                  parti{partent > 1 ? 's' : ''}.
                </p>
                {partent > 0 && (
                  <button
                    type="button"
                    className="mt-2 text-xs font-semibold text-marque-sur-plan"
                    onClick={() => aller('depenses')}
                  >
                    Corriger dans Dépenses › Paie & départs →
                  </button>
                )}
              </div>
            )}
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
                <Ligne key={p} libelle={libellePartenaire(p)} valeur={formatFCFA(rapport.livraisons[p] ?? 0)} />
              ))}
              {MODES_ELECTRO.filter((m) => (rapport.modes_declares[m] ?? 0) > 0).map((m) => (
                <Ligne key={m} libelle={LIBELLES_MODES[m]} valeur={formatFCFA(rapport.modes_declares[m] ?? 0)} />
              ))}
              {(rapport.offerts?.total ?? 0) > 0 && (
                <Ligne libelle={`Kdo offerts (${rapport.offerts.nb})`} valeur={formatFCFA(rapport.offerts.total)} />
              )}
              <div className="border-t border-bordure pt-1" />
              <Ligne libelle="Vente totale (réconciliée)" valeur={formatFCFA(rapport.vente_totale)} fort />
              <Ligne libelle="Total système" valeur={formatFCFA(rapport.total_systeme)} />
              <div className={`flex justify-between font-bold ${rapport.diff < 0 ? 'text-alerte' : 'text-ok'}`}>
                <span>Écart réconciliation</span>
                <span className="tabular-nums">{rapport.diff > 0 ? '+' : ''}{formatFCFA(rapport.diff)}</span>
              </div>
            </div>

            {/* Bloc Inventaire (§ 6.10) : INFORMATION MANAGER. Le manquant ne
                touche ni la vente, ni l'écart de caisse — il est présenté, le
                manager tranche (contrairement à SamerTrackly, qui déduit). */}
            {rapport.inventaire && (
              <div
                className={`rounded-xl p-3 text-sm ${
                  rapport.inventaire.montant_manquant > 0 ? 'bg-attente-tint text-attente-txt' : 'bg-ok-tint text-ok-txt'
                }`}
              >
                <div className="flex items-baseline justify-between font-semibold">
                  <span>Inventaire</span>
                  <span className="tabular-nums">
                    {rapport.inventaire.manquants === 0
                      ? 'Conforme'
                      : `${rapport.inventaire.manquants} manquant${rapport.inventaire.manquants > 1 ? 's' : ''} · ${formatFCFA(rapport.inventaire.montant_manquant)}`}
                  </span>
                </div>
                <div className="mt-1 text-xs opacity-80">
                  {rapport.inventaire.debloque && !rapport.inventaire.valide
                    ? 'Clôture débloquée par un manager, sans comptage complet. '
                    : ''}
                  Information manager — sans effet sur la vente ni sur l’écart de caisse.
                </div>
              </div>
            )}

            {/* Bloc Retours : même statut que l'inventaire — information, hors
                vente et hors tiroir. Figé dans le ticket Z, donc consultable
                après coup et remonté au siège avec le shift. */}
            {(rapport.retours?.nb ?? 0) > 0 && (
              <div className="rounded-xl bg-surface-douce p-3 text-sm">
                <div className="flex items-baseline justify-between font-semibold">
                  <span>Retours</span>
                  <span className="tabular-nums">
                    {rapport.retours.nb} article{rapport.retours.nb > 1 ? 's' : ''} ·{' '}
                    {formatFCFA(rapport.retours.montant)}
                  </span>
                </div>
                <div className="mt-1.5 space-y-0.5">
                  {rapport.retours.par_produit.map((p) => (
                    <div key={p.nom} className="flex justify-between text-xs text-doux">
                      <span className="truncate">{p.quantite} × {p.nom}</span>
                      <span className="tabular-nums">{formatFCFA(p.montant)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 text-xs text-doux">
                  Lancés en cuisine puis annulés au PIN manager — sans effet sur la vente ni sur le tiroir.
                </div>
              </div>
            )}

            {rapport.equipe && rapport.equipe.presents > 0 && (
              <div className="text-center text-xs text-doux">
                Équipe : {rapport.equipe.presents} présent{rapport.equipe.presents > 1 ? 's' : ''} ·{' '}
                {rapport.equipe.restent} reste{rapport.equipe.restent > 1 ? 'nt' : ''} · {rapport.equipe.partis} parti
                {rapport.equipe.partis > 1 ? 's' : ''}
              </div>
            )}

            <p className="text-center text-xs text-doux">Vente validée — vous devez terminer pour clôturer le point.</p>
            <button type="button" className="btn-accent w-full py-4 text-lg" onClick={terminer}>Valider & terminer — se déconnecter</button>
          </div>
        )}
      </div>

      {deblocageOuvert && (
        <ModaleDeblocage
          restants={inventaire?.restants_a_compter ?? 0}
          onFermer={() => setDeblocageOuvert(false)}
          onDebloque={() => {
            setDeblocageOuvert(false);
            void queryClient.invalidateQueries({ queryKey: ['inventaire-etat'] });
            afficherToast('Clôture débloquée — le déblocage est enregistré au journal');
          }}
          onErreur={afficherToast}
        />
      )}

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
