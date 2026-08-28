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
  IconTruckDelivery,
} from '@tabler/icons-react';
import type { CommandeVue, ModePaiement } from '@pos/shared';
import { estLivraisonSansEncaissement, formatFCFA, LIBELLES_MODES, MODES_PAIEMENT } from '@pos/shared';
import { api } from '../api';
import { SelectionArticlesPaiement, type NouvelleSousNotePaiement } from '../components/SelectionArticlesPaiement';
import { useCaisse } from '../stores/session';

/**
 * Plancher des touches du pavé. `.touche` monte à 64 px, ce qui empêchait les
 * quatre rangées de tenir dans la colonne sur un écran de caisse : la dernière
 * sortait sous la découpe. Ici les rangées se partagent la place disponible et
 * ne descendent jamais sous une cible tactile correcte.
 */
const TOUCHE = { minHeight: 44 } as const;

/** Appoints pour composer le montant à encaisser. */
const RACCOURCIS = [1000, 2000, 5000, 10000];

/**
 * Les COUPURES qui circulent réellement à Abidjan. Elles servent à saisir ce
 * que le client pose sur le comptoir en tapant sur l'écran : sur un kiosque
 * tactile il n'y a pas de clavier physique, et l'ancien petit champ « Reçu du
 * client » ne pouvait donc pas être rempli du tout.
 */
const COUPURES = [500, 1000, 2000, 5000, 10000];

function iconeMode(mode: ModePaiement) {
  if (mode === 'ESPECES') return IconCash;
  if (mode === 'CARTE') return IconCreditCard;
  return IconDeviceMobile; // Wave, Orange Money, MTN MoMo, Moov
}

/**
 * La VRAIE couleur de l'opérateur (DESIGN_V2 § 4.2) : le caissier reconnaît
 * Wave au bleu, Orange Money à l'orange, MTN au jaune, Moov au vert et Djamo
 * au noir avant même de lire le libellé — c'est ce qui évite d'enregistrer un
 * paiement sur le mauvais mode dans un rush. Les jetons sont définis dans
 * packages/theme/theme.css, et JAMAIS en dur ici.
 */
const COULEUR_MODE: Record<ModePaiement, string> = {
  ESPECES: 'var(--pay-especes)',
  WAVE: 'var(--pay-wave)',
  ORANGE_MONEY: 'var(--pay-orange)',
  MTN_MOMO: 'var(--pay-mtn)',
  MOOV_MONEY: 'var(--pay-moov)',
  CARTE: 'var(--pay-carte)',
  DJAMO: 'var(--pay-djamo)',
};

/** Encre posée SUR l'aplat, quand le mode est sélectionné (§ 4.2). */
const TEXTE_SUR_MODE: Record<ModePaiement, string> = {
  ESPECES: 'var(--pay-especes-sur)',
  WAVE: 'var(--pay-wave-sur)',
  ORANGE_MONEY: 'var(--pay-orange-sur)',
  MTN_MOMO: 'var(--pay-mtn-sur)',
  MOOV_MONEY: 'var(--pay-moov-sur)',
  CARTE: 'var(--pay-carte-sur)',
  DJAMO: 'var(--pay-djamo-sur)',
};

export function Paiement() {
  const { commandeId, aller, afficherToast } = useCaisse();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ModePaiement>('ESPECES');
  const [montant, setMontant] = useState('');
  const [noteId, setNoteId] = useState<string | null>(null);
  const [selectionOuverte, setSelectionOuverte] = useState(false);
  const [especesDonnees, setEspecesDonnees] = useState('');
  /**
   * Case alimentée par le pavé numérique. Le pavé est le SEUL moyen de saisie
   * du poste : tout ce qui se tape doit pouvoir viser l'une ou l'autre case,
   * sans quoi le champ reste inaccessible au doigt.
   */
  const [cible, setCible] = useState<'montant' | 'recu'>('montant');

  const { data: commande } = useQuery({
    queryKey: ['commande', commandeId],
    queryFn: () => api<CommandeVue>(`/api/commandes/${commandeId}`),
    enabled: !!commandeId,
  });

  const rafraichir = (vue: CommandeVue) => queryClient.setQueryData(['commande', commandeId], vue);

  const encaisser = useMutation({
    mutationFn: (corps: { mode: ModePaiement; montant: number; note_id?: string | null; montant_recu?: number }) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/paiements`, { method: 'POST', corps }),
    onSuccess: (vue) => {
      rafraichir(vue);
      setMontant('');
      setEspecesDonnees('');
      setCible('montant');
      const noteSoldee = noteId ? vue.notes.find((note) => note.id === noteId)?.statut === 'PAYEE' : false;
      if (vue.statut === 'PAYEE') {
        afficherToast(`Ticket n° ${vue.numero_ticket} encaissé ✔ — reçu imprimé`);
      } else if (noteSoldee) {
        afficherToast('Paiement individuel encaissé ✔ — les autres articles restent en attente');
        aller(vue.table_id ? 'tables' : 'accueil');
      }
    },
    onError: (e: Error) => afficherToast(e.message),
  });

  const creerSousNote = useMutation({
    mutationFn: (selection: NouvelleSousNotePaiement) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/sous-notes`, { method: 'POST', corps: selection }),
    onSuccess: (vue) => {
      rafraichir(vue);
      setSelectionOuverte(false);
      const prochaine = [...vue.notes].reverse().find((note) => note.statut === 'A_PAYER');
      setNoteId(prochaine?.id ?? null);
    },
    onError: (e: Error) => afficherToast(e.message),
  });

  // Livraison externe (Yango/Glovo) : réglée chez le partenaire, aucune saisie
  // de mode de paiement — un seul bouton clôture la commande en PAYEE.
  const cloturerLivraison = useMutation({
    mutationFn: () => api<CommandeVue>(`/api/commandes/${commandeId}/cloturer-livraison`, { method: 'POST' }),
    onSuccess: (vue) => {
      rafraichir(vue);
      afficherToast(`Livraison ${vue.partenaire ?? ''} validée ✔ — reçu imprimé`);
    },
    onError: (e: Error) => afficherToast(e.message),
  });

  const commandePrete = !!commande;
  const estPayee = commande?.statut === 'PAYEE';

  useEffect(() => {
    if (!commande || noteId) return;
    const reprise = commande.notes.find((note) => note.statut === 'PARTIELLEMENT_PAYEE')
      ?? commande.notes.find((note) => note.statut === 'A_PAYER');
    if (reprise) setNoteId(reprise.id);
  }, [commande, noteId]);

  // Clavier physique (dev) : chiffres → montant, Backspace, Échap (efface).
  useEffect(() => {
    if (!commandePrete || estPayee) return;
    const gerer = (e: KeyboardEvent) => {
      const source = e.target as HTMLElement;
      if (source?.tagName === 'INPUT') return;
      // Le pavé (et le clavier de dev) écrivent dans la CASE ACTIVE.
      const ecrireCible = mode === 'ESPECES' && cible === 'recu' ? setEspecesDonnees : setMontant;
      if (/^\d$/.test(e.key)) { e.preventDefault(); ecrireCible((v) => (v.length < 9 ? v + e.key : v)); }
      else if (e.key === 'Backspace') { e.preventDefault(); ecrireCible((v) => v.slice(0, -1)); }
      else if (e.key === 'Escape') { e.preventDefault(); ecrireCible(''); }
    };
    window.addEventListener('keydown', gerer);
    return () => window.removeEventListener('keydown', gerer);
  }, [commandePrete, estPayee, mode, cible]);

  if (!commande) {
    return <div className="flex min-h-full items-center justify-center text-doux">Chargement…</div>;
  }

  const sansEncaissement = estLivraisonSansEncaissement(commande.partenaire);
  const noteActive = commande.notes.find((n) => n.id === noteId) ?? null;
  const notesActives = commande.notes.filter((n) => n.statut !== 'ANNULEE');
  /**
   * Le caissier a-t-il VRAIMENT demandé un partage ?
   *
   * Le serveur crée tout seul une sous-note couvrant le ticket entier au
   * premier encaissement, pour que les quantités payées soient tracées comme
   * partout ailleurs. Cette sous-note-là est de la comptabilité interne : elle
   * ne doit pas transformer l'écran en parcours de partage. Seul un partage
   * réel — plusieurs notes, ou une note qui ne couvre pas tout le ticket —
   * oblige à choisir qui on encaisse.
   */
  const partageDemande =
    notesActives.length > 1
    || (notesActives.length === 1 && notesActives[0]!.montant !== commande.total);
  /** Partage en cours, mais aucun convive sélectionné : là seulement, on bloque. */
  const attenteSelection = partageDemande && !noteActive;
  // Sans partage, on encaisse la commande entière : c'est le parcours normal,
  // celui de l'immense majorité des tickets.
  const resteCible = noteActive ? noteActive.reste : partageDemande ? 0 : commande.reste;
  const montantSaisi = montant === '' ? resteCible : Number(montant);
  const donnees = Number(especesDonnees || '0');
  const enEspeces = mode === 'ESPECES';
  // Hors espèces il n'y a ni billet ni monnaie : le pavé retombe sur le montant.
  const cibleActive: 'montant' | 'recu' = enEspeces ? cible : 'montant';
  const billetSaisi = enEspeces && especesDonnees !== '' && donnees > 0;
  // Affichage seulement : le franc qui fait foi est recalculé par le serveur à
  // partir du billet transmis (aucun calcul monétaire côté caisse).
  const monnaie = billetSaisi ? Math.max(0, donnees - montantSaisi) : 0;
  const billetInsuffisant = billetSaisi && donnees < montantSaisi;
  const peutAjouter =
    !attenteSelection && montantSaisi > 0 && montantSaisi <= resteCible && !billetInsuffisant && !encaisser.isPending;

  const ajouter = () => {
    if (!peutAjouter) return;
    encaisser.mutate({
      mode,
      montant: montantSaisi,
      note_id: noteId,
      // Rien n'est transmis si le caissier n'a pas saisi le billet : mieux vaut
      // aucune trace qu'une trace inventée.
      ...(billetSaisi ? { montant_recu: donnees } : {}),
    });
  };
  const ecrire = (maj: (v: string) => string) =>
    cibleActive === 'recu' ? setEspecesDonnees(maj) : setMontant(maj);
  const taper = (c: string) => ecrire((v) => (v.length < 9 ? v + c : v));
  const ajouterRaccourci = (n: number) => ecrire((v) => String(Number(v || '0') + n));

  const articlesDisponibles = commande.items.some((item) => item.quantite_disponible > 0 && item.statut_cuisine !== 'ANNULE');

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
        <div className="col-span-12 flex min-h-0 flex-col gap-4 md:col-span-4">
          <div className="carte flex min-h-0 flex-1 flex-col p-5">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold">Résumé du ticket</h3>
              <span className="rounded-full bg-marque-tint px-3 py-1 text-xs font-bold text-marque-fonce">
                {commande.code_commande ?? `N° ${commande.numero_ticket}`}
              </span>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              {commande.items.filter((i) => i.statut_cuisine !== 'ANNULE').map((i) => (
                <div key={i.id} className="flex items-start justify-between gap-2">
                  <span className="text-fort">
                    {i.quantite}× {i.nom_snapshot}
                    {i.quantite_payee > 0 && <small className="ml-2 rounded-full bg-ok-tint px-2 py-1 font-bold text-ok">{i.quantite_payee} payé{i.quantite_payee > 1 ? 's' : ''}</small>}
                    {i.quantite_reservee > 0 && <small className="ml-2 rounded-full bg-marque-tint px-2 py-1 font-bold text-marque-fonce">{i.quantite_reservee} en cours</small>}
                  </span>
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

          {!estPayee && !sansEncaissement && articlesDisponibles && (
            <div className="rounded-2xl bg-surface-moyenne p-5 shadow-e1">
              <div className="mb-3 flex items-center gap-2">
                <IconArrowsSplit2 size={22} className="text-marque-fonce" />
                <h4 className="text-lg font-bold">Paiement individuel</h4>
              </div>
              <button
                type="button"
                onClick={() => setSelectionOuverte(true)}
                className="min-h-12 w-full rounded-xl bg-marque px-4 py-3 font-bold text-sur-marque shadow-e1 transition hover:brightness-105"
              >
                Payer par articles
              </button>
            </div>
          )}
        </div>

        {/* Colonne milieu : modes + clavier.
            `overflow-y-auto` est un filet, pas une fonctionnalité : la colonne
            est dimensionnée pour tout montrer. Mais le parent est en
            `overflow-hidden`, donc sans ce filet un écran plus court coupe
            purement et simplement la dernière rangée du pavé — invisible, et
            sans le moindre indice que quelque chose manque. */}
        <div className="col-span-12 flex min-h-0 flex-col gap-4 overflow-y-auto md:col-span-5">
          {partageDemande && !estPayee && (
            <div className="flex flex-wrap gap-2">
              {commande.notes.map((n) => (
                <BoutonNote
                  key={n.id}
                  actif={noteId === n.id}
                  paye={n.statut === 'PAYEE'}
                  onClick={() => n.statut !== 'ANNULEE' && setNoteId(n.id)}
                >
                  {n.statut === 'PAYEE' ? `Payé — Paiement ${n.numero} ✔` : n.statut === 'PARTIELLEMENT_PAYEE' ? `Reprendre le paiement ${n.numero} — ${formatFCFA(n.reste)}` : `Paiement ${n.numero} — ${formatFCFA(n.reste)}`}
                </BoutonNote>
              ))}
            </div>
          )}

          {!estPayee && !sansEncaissement && attenteSelection && (
            <div className="carte p-5 text-center text-doux">
              Ce ticket est partagé — choisissez le paiement à encaisser ci-dessus.
            </div>
          )}

          {!estPayee && sansEncaissement && (
            <div className="carte flex min-h-0 flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-info-tint text-info">
                <IconTruckDelivery size={44} />
              </div>
              <div>
                <h3 className="text-2xl font-bold">Livraison {commande.partenaire}</h3>
                <p className="mt-2 max-w-xs text-doux">
                  Le client règle chez {commande.partenaire} — aucun encaissement en caisse.
                  Validez la livraison pour clôturer la commande et imprimer le reçu.
                </p>
              </div>
              <button
                type="button"
                onClick={() => cloturerLivraison.mutate()}
                disabled={cloturerLivraison.isPending}
                className="flex h-16 w-full max-w-sm items-center justify-center gap-2 rounded-[13px] bg-marque text-xl font-bold text-sur-marque shadow-e2 transition hover:brightness-105 active:translate-y-px disabled:opacity-40"
              >
                <IconTruckDelivery size={24} />
                {cloturerLivraison.isPending ? 'Validation…' : `Valider la livraison · ${formatFCFA(commande.total)}`}
              </button>
            </div>
          )}

          {!estPayee && !sansEncaissement && (
            <>
              <div className="carte p-5">
                <h3 className="mb-3 text-base font-bold">Mode de paiement</h3>
                <div className="grid grid-cols-4 gap-2">
                  {MODES_PAIEMENT.map((m) => {
                    const Icone = iconeMode(m);
                    const actif = mode === m;
                    const couleur = COULEUR_MODE[m];
                    const surCouleur = TEXTE_SUR_MODE[m];
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => { setMode(m); setCible('montant'); }}
                        className="flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-xl border-2 p-2 text-center transition"
                        style={
                          actif
                            ? {
                                borderColor: couleur,
                                background: couleur,
                                color: surCouleur,
                                boxShadow: `0 0 0 3px color-mix(in srgb, ${couleur} 30%, transparent)`,
                              }
                            : {
                                // Aplat très dilué + filet teinté : la marque se
                                // reconnaît sans que sept tuiles crient ensemble.
                                borderColor: `color-mix(in srgb, ${couleur} 42%, var(--filet))`,
                                background: `color-mix(in srgb, ${couleur} 8%, var(--carte))`,
                                color: couleur,
                              }
                        }
                      >
                        <Icone size={26} />
                        <span
                          className="text-[11px] font-semibold leading-tight"
                          style={{ color: actif ? surCouleur : 'var(--txt)' }}
                        >
                          {LIBELLES_MODES[m]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="carte flex min-h-0 flex-1 flex-col p-4">
                {/* Les deux cases que le pavé peut remplir. On tape sur l'une
                    pour la rendre active — c'est ce qui rend « Reçu du client »
                    saisissable sur un kiosque, qui n'a pas de clavier. En
                    espèces la case est toujours affichée, même vide : le
                    caissier doit VOIR qu'il peut y noter le billet. */}
                <div className={`mb-3 grid gap-2 ${enEspeces ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  <CaseSaisie
                    titre="À encaisser"
                    valeur={formatFCFA(montantSaisi)}
                    active={cibleActive === 'montant'}
                    onClick={() => setCible('montant')}
                  />
                  {enEspeces && (
                    <CaseSaisie
                      titre="Reçu du client"
                      valeur={billetSaisi ? formatFCFA(donnees) : '—'}
                      indice={billetSaisi ? undefined : 'Le billet posé'}
                      active={cibleActive === 'recu'}
                      onClick={() => setCible('recu')}
                    />
                  )}
                </div>

                {/* Monnaie à rendre : le chiffre que le caissier compte dans sa
                    main. Rouge tant que le billet ne couvre pas la note — on ne
                    laisse pas enregistrer un rendu négatif. */}
                {enEspeces && billetSaisi && (
                  <div
                    className={`mb-3 flex items-baseline justify-between rounded-xl px-4 py-2 ${
                      billetInsuffisant ? 'bg-alerte/10 text-alerte' : 'bg-ok-tint text-ok'
                    }`}
                  >
                    <span className="text-sm font-bold uppercase tracking-wider">
                      {billetInsuffisant ? 'Il manque' : monnaie === 0 ? 'Compte juste' : 'Monnaie à rendre'}
                    </span>
                    <span className="text-2xl font-extrabold tabular-nums">
                      {formatFCFA(billetInsuffisant ? montantSaisi - donnees : monnaie)}
                    </span>
                  </div>
                )}
                <div className="grid min-h-0 flex-1 grid-cols-3 grid-rows-4 gap-2">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((c) => (
                    <button key={c} type="button" onClick={() => taper(c)} className="touche" style={TOUCHE}>{c}</button>
                  ))}
                  <button type="button" onClick={() => ecrire(() => '')} className="touche text-lg font-bold text-alerte" style={TOUCHE}>C</button>
                  <button type="button" onClick={() => taper('0')} className="touche" style={TOUCHE}>0</button>
                  <button type="button" onClick={() => ecrire((v) => v.slice(0, -1))} className="touche" style={TOUCHE} aria-label="Effacer un chiffre">
                    <IconBackspace size={24} className="text-doux" />
                  </button>
                </div>
                {/* Sur la case « Reçu », les raccourcis sont les COUPURES qui
                    circulent : on appuie sur ce que le client a posé, plutôt
                    que de composer 1-0-0-0-0. */}
                {cibleActive === 'recu' ? (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {COUPURES.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => ajouterRaccourci(n)}
                        className="rounded-lg bg-surface-tres-haute py-2 font-bold text-marque-fonce transition hover:brightness-95"
                      >
                        +{n.toLocaleString('fr-FR')}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setEspecesDonnees(String(montantSaisi))}
                      className="rounded-lg bg-ok-tint py-2 font-bold text-ok transition hover:brightness-95"
                    >
                      Compte juste
                    </button>
                  </div>
                ) : (
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
                )}
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
        <div className="col-span-12 flex min-h-0 flex-col gap-4 md:col-span-3">
          {/* Récapitulatif ARDOISE (§ 6.5) : le Reste à payer en très grand,
              détaché du plan de travail clair — c'est le seul chiffre que le
              caissier cherche des yeux pendant un paiement mixte. */}
          <div
            className="flex h-44 flex-none flex-col items-center justify-center rounded-2xl border-4 bg-ard-900 p-4 text-center shadow-ard"
            style={{ borderColor: estPayee ? 'var(--ok)' : 'var(--marque)' }}
          >
            <span className="text-xs font-bold uppercase tracking-widest text-ard-txt-faible">
              {estPayee
                ? 'Encaissé'
                : sansEncaissement
                  ? `À régler chez ${commande.partenaire}`
                  : attenteSelection
                    ? 'Sélection requise'
                    : partageDemande && noteActive
                      ? `Reste — Paiement ${noteActive.numero}`
                      : 'Reste à payer'}
            </span>
            <div className={`mt-1 text-5xl font-extrabold tabular-nums ${estPayee ? 'text-ok' : 'text-ard-txt'}`}>
              {formatFCFA(resteCible)}
            </div>
            <span className="mt-1 text-xs text-ard-txt-faible">Total {formatFCFA(commande.total)} · payé {formatFCFA(commande.paye)}</span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col rounded-2xl bg-ard-850 p-5 text-ard-txt shadow-ard">
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-ard-txt-faible">Paiements enregistrés</h3>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {commande.paiements.length === 0 && (
                <div className="py-10 text-center text-sm italic text-ard-txt-faible">
                  {sansEncaissement ? `Réglé par ${commande.partenaire} — pas d’encaissement en caisse` : 'Aucun paiement saisi'}
                </div>
              )}
              {commande.paiements.map((p) => {
                const Icone = iconeMode(p.mode);
                return (
                  <div key={p.id} className="rounded-xl bg-ard-800 p-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 font-semibold">
                        <Icone size={18} style={{ color: COULEUR_MODE[p.mode] }} /> {LIBELLES_MODES[p.mode]}
                      </span>
                      <span className="font-bold tabular-nums">{formatFCFA(p.montant)}</span>
                    </div>
                    {/* Le billet et la monnaie rendue, tels qu'ils sont partis
                        sur le reçu du client. Absents des paiements enregistrés
                        avant le 2026-08-28. */}
                    {p.montant_recu !== null && (
                      <div className="mt-1 flex justify-between text-xs text-ard-txt-faible">
                        <span>Reçu {formatFCFA(p.montant_recu)}</span>
                        <span>Rendu {formatFCFA(p.monnaie_rendue ?? 0)}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {!estPayee && !sansEncaissement && (
            <button
              type="button"
              onClick={ajouter}
              disabled={!peutAjouter}
              // Le bouton d'ajout porte la couleur du mode sélectionné : on voit
              // sur QUOI on encaisse au moment où on appuie (§ 4.2).
              style={{ background: `color-mix(in srgb, ${COULEUR_MODE[mode]} 16%, var(--carte))`, color: COULEUR_MODE[mode] }}
              className="flex h-14 flex-none items-center justify-center gap-2 rounded-[13px] text-lg font-bold shadow-e1 transition hover:brightness-95 disabled:opacity-40"
            >
              <IconCirclePlus size={22} /> {encaisser.isPending ? 'Encaissement…' : `Ajouter ${LIBELLES_MODES[mode]}`}
            </button>
          )}
          {/* La clôture d'une livraison externe passe par le bouton dédié (colonne
              du milieu) : ici on n'affiche « Terminer » qu'une fois clôturée. */}
          {(estPayee || !sansEncaissement) && (
            <button
              type="button"
              onClick={() => aller('accueil')}
              disabled={!estPayee && commande.reste > 0}
              className={`h-16 flex-none rounded-[13px] text-xl font-bold transition ${
                !estPayee && commande.reste > 0
                  ? 'cursor-not-allowed border-2 border-dashed border-bordure-forte bg-surface-tres-haute text-doux/50'
                  : 'bg-marque text-sur-marque shadow-e2 hover:brightness-105 active:translate-y-px'
              }`}
            >
              {estPayee ? 'Terminer' : 'Valider la vente'}
            </button>
          )}
          {!estPayee && commande.reste > 0 && !sansEncaissement && (
            <p className="flex-none text-center text-xs font-bold uppercase leading-tight text-alerte">
              Soldez la totalité avant de valider
            </p>
          )}
        </div>
      </div>

      {selectionOuverte && (
        <SelectionArticlesPaiement
          commande={commande}
          onConfirmer={(items) => creerSousNote.mutate(items)}
          onFermer={() => setSelectionOuverte(false)}
          enCours={creerSousNote.isPending}
        />
      )}
    </div>
  );
}

/**
 * Case de saisie du pavé. Ce n'est pas un `<input>` : sur le kiosque il n'y a
 * pas de clavier, et l'ancien champ texte étroit coupait le nombre dès le
 * troisième chiffre. Ici le montant a toute la largeur, et la taille de police
 * baisse au lieu de tronquer — un chiffre saisi est toujours un chiffre lu.
 */
function CaseSaisie({
  titre,
  valeur,
  indice,
  active,
  onClick,
}: {
  titre: string;
  valeur: string;
  indice?: string;
  active: boolean;
  onClick: () => void;
}) {
  const taille = valeur.length > 13 ? 'text-xl' : valeur.length > 10 ? 'text-2xl' : 'text-3xl';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-h-[76px] flex-col justify-center rounded-xl border-2 px-3 py-2 text-right transition ${
        active
          ? 'border-marque bg-marque-tint'
          : 'border-bordure bg-surface-douce hover:border-bordure-forte'
      }`}
    >
      <span className={`text-[11px] font-bold uppercase tracking-widest ${active ? 'text-marque-fonce' : 'text-doux'}`}>
        {titre}
      </span>
      <span className={`mt-0.5 break-words font-bold leading-none tabular-nums text-fort ${taille}`}>{valeur}</span>
      {indice && <span className="mt-1 text-[10px] text-doux">{indice}</span>}
    </button>
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
