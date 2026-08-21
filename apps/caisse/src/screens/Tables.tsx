import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconArrowLeft, IconArrowsExchange } from '@tabler/icons-react';
import type { CommandeVue, EtatTable, TableVue, UtilisateurPublic } from '@pos/shared';
import {
  estTableKdo,
  ETATS_TABLE,
  formatFCFA,
  LIBELLE_KDO,
  libellePartenaire,
  LIBELLES_ETAT_TABLE,
  LIBELLES_STATUTS_COMMANDE,
} from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { useCaisse } from '../stores/session';

/**
 * Plan de salle (DESIGN_V2 § 6.3) — trois colonnes : zones en ardoise à gauche,
 * cartes de table sur le plan de travail clair au centre, « Coup d'œil salle »
 * en ardoise à droite.
 *
 * La caisse a sa propre mise en page : le composant partagé `PlanSalle`
 * (@pos/shared-ui) reste celui de la TABLETTE SERVEUR, qui n'a ni la place ni
 * l'usage de ces trois colonnes. Les deux écrans lisent les mêmes états dérivés
 * côté serveur, donc ils ne peuvent pas diverger sur le fond.
 */

/**
 * Couleur d'état, reprise telle quelle de la maquette. LIBRE n'a pas de
 * couleur : sa carte reste blanche avec un filet pointillé — c'est ce qui la
 * distingue d'un coup d'œil des tables occupées, toutes peintes en plein.
 */
const COULEURS: Record<EtatTable, string | null> = {
  LIBRE: null,
  OCCUPEE: '#64748b',
  COMMANDE_CLIENT_A_VALIDER: '#7c3aed',
  EN_PREPARATION: '#ef9f27',
  PRETE: '#16a34a',
  SERVIE: '#3b82f6',
  ADDITION_DEMANDEE: '#1e40af',
};

/** États qui appellent une intervention : ils allument le point de la zone. */
const APPELLE = (t: TableVue) =>
  t.etat === 'ADDITION_DEMANDEE' || t.etat === 'PRETE' || t.etat === 'COMMANDE_CLIENT_A_VALIDER';

const prenom = (nom: string | null): string => (nom ? (nom.split(/\s+/)[0] ?? nom) : '');

/** « 12 min », « 1 h 40 » — depuis l'ouverture de la plus ancienne commande. */
function anciennete(tables: TableVue): string | null {
  const debuts = tables.commandes_ouvertes.map((c) => new Date(c.created_at).getTime());
  if (debuts.length === 0) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - Math.min(...debuts)) / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

const montantEnCours = (t: TableVue): number =>
  t.commandes_ouvertes.reduce((s, c) => s + c.total, 0);

export function Tables() {
  const { aller, rentrer, afficherToast } = useCaisse();
  const [transfert, setTransfert] = useState<TableVue | null>(null);
  const [virtuelle, setVirtuelle] = useState<TableVue | null>(null);
  const [zoneActive, setZoneActive] = useState<string | null>(null);

  const { data: tables, refetch } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    refetchInterval: 15000,
  });
  const toutes = useMemo(() => tables ?? [], [tables]);

  const zones = useMemo(() => {
    const parNom = new Map<string, TableVue[]>();
    for (const t of toutes) {
      const liste = parNom.get(t.zone_nom) ?? [];
      liste.push(t);
      parNom.set(t.zone_nom, liste);
    }
    return [...parNom.entries()].map(([nom, liste]) => ({
      nom,
      total: liste.length,
      occupees: liste.filter((t) => t.etat !== 'LIBRE').length,
      alerte: liste.some(APPELLE),
    }));
  }, [toutes]);

  const zone = zoneActive && zones.some((z) => z.nom === zoneActive) ? zoneActive : zones[0]?.nom ?? null;
  const visibles = toutes.filter((t) => t.zone_nom === zone);

  // Coup d'œil salle : compteurs sur TOUTE la salle, pas sur la zone affichée —
  // le caissier doit voir ce qui l'attend ailleurs sans changer d'onglet.
  const compteurs = ETATS_TABLE.map((e) => ({
    etat: e,
    nb: toutes.filter((t) => t.etat === e).length,
  })).filter((c) => c.nb > 0);
  const totalSalle = toutes.reduce((s, t) => s + montantEnCours(t), 0);

  const ouvrirTable = async (t: TableVue) => {
    // Les tables VIRTUELLES (Yango, Glovo, Samer Delly, Kdo) ouvrent la liste de
    // leurs commandes : plusieurs y coexistent pendant un rush, il faut choisir.
    if (t.partenaire) {
      setVirtuelle(t);
      return;
    }
    if (t.commande_id) {
      aller(t.etat === 'ADDITION_DEMANDEE' ? 'paiement' : 'commande', t.commande_id);
      return;
    }
    try {
      const commande = await api<CommandeVue>('/api/commandes', {
        method: 'POST',
        corps: { type: 'SUR_PLACE', table_id: t.id },
      });
      aller('commande', commande.id);
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  const transferables = toutes.filter((t) => t.ouverte_par);

  const libres = toutes.filter((t) => !t.partenaire && t.etat === 'LIBRE').length;
  const totalReelles = toutes.filter((t) => !t.partenaire).length;
  const additions = toutes.filter((t) => t.etat === 'ADDITION_DEMANDEE').length;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ---------- Barre ardoise ---------- */}
      <header className="flex h-[62px] flex-none items-center justify-between border-b border-ard-700 bg-ard-900 px-3.5 text-ard-txt">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={rentrer}
            className="flex flex-none items-center gap-2 rounded-btn px-3 py-2 font-semibold text-ard-txt-doux transition hover:bg-ard-750 hover:text-ard-txt"
          >
            <IconArrowLeft size={19} />
            Accueil
          </button>
          <span className="h-6 w-px flex-none bg-ard-600" />
          <h2 className="flex-none text-[17px] font-semibold tracking-tight">Plan de salle</h2>
          <span className="truncate text-[12.5px] font-medium text-ard-txt-doux">
            {libres} libre{libres > 1 ? 's' : ''} sur {totalReelles} · {additions} addition
            {additions > 1 ? 's' : ''} demandée{additions > 1 ? 's' : ''}
          </span>
        </div>
      </header>

      {/* Ossature de la maquette : zones / plan / coup d'œil, TOUJOURS en trois
          colonnes — jamais d'empilement, qui ferait remonter les zones en haut.
          La colonne de droite vaut les 356 px de la maquette dès ~1320 px, mais
          se resserre en dessous : sur un écran 1024, 356 px fixes ne laissaient
          que 482 px au plan de salle, et le centre doit rester nettement le plus
          large — c'est là que le caissier travaille. */}
      <div className="grid min-h-0 flex-1 grid-cols-[186px_1fr_clamp(280px,27vw,356px)]">
        {/* ---------- Colonne ardoise : zones ---------- */}
        <nav className="flex flex-col gap-[7px] overflow-y-auto border-r border-ard-700 bg-ard-800 p-3">
          <p className="px-3 pb-2.5 pt-1.5 text-[10.5px] font-bold uppercase tracking-[0.09em] text-ard-txt-faible">
            Zones
          </p>
          {zones.map((z) => {
            const actif = z.nom === zone;
            return (
              <button
                key={z.nom}
                type="button"
                onClick={() => setZoneActive(z.nom)}
                className={`flex items-center gap-[11px] rounded-btn px-3 py-3.5 text-left text-[14.5px] font-semibold transition ${
                  actif ? 'bg-ard-700 text-ard-txt' : 'text-ard-txt-doux hover:bg-ard-750 hover:text-ard-txt'
                }`}
              >
                {/* Point orange : cette zone demande une intervention. */}
                <span
                  className={`h-2.5 w-2.5 flex-none rounded-full transition-transform ${actif ? 'scale-150' : ''}`}
                  style={{ background: z.alerte ? 'var(--marque)' : 'var(--ard-600)' }}
                />
                <span className="truncate">{z.nom}</span>
                <span className="ml-auto text-[11.5px] font-semibold tabular-nums text-ard-txt-faible">
                  {z.occupees}/{z.total}
                </span>
              </button>
            );
          })}
        </nav>

        {/* ---------- Plan de travail clair : les tables ---------- */}
        <main className="overflow-y-auto bg-plan p-4">
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(152px,1fr))]">
            {visibles.map((t) => (
              <CarteTable key={t.id} table={t} onClick={() => void ouvrirTable(t)} />
            ))}
          </div>
          {visibles.length === 0 && <p className="text-doux">Aucune table dans cette zone.</p>}

          <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2">
            {ETATS_TABLE.map((e) => (
              <span key={e} className="flex items-center gap-[7px] text-xs font-medium text-doux">
                <span
                  className="block h-[11px] w-[11px] rounded-[3px]"
                  style={
                    COULEURS[e]
                      ? { background: COULEURS[e]! }
                      : { background: 'var(--carte)', border: '1.5px dashed var(--filet-fort)' }
                  }
                />
                {LIBELLES_ETAT_TABLE[e]}
              </span>
            ))}
          </div>
        </main>

        {/* ---------- Colonne ardoise : coup d'œil salle ---------- */}
        <aside className="flex min-h-0 flex-col border-l border-ard-700 bg-ard-850 text-ard-txt">
          <div className="flex flex-none items-center justify-between border-b border-ard-700 px-4 py-[15px]">
            <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-ard-txt-faible">
              Coup d’œil salle
            </span>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-[7px] overflow-y-auto p-2">
            {compteurs.map((c) => (
              <div key={c.etat} className="flex items-center gap-[11px] rounded-[7px] bg-ard-800 px-3 py-[11px]">
                <span
                  className="h-2.5 w-2.5 flex-none rounded-full"
                  style={
                    COULEURS[c.etat]
                      ? { background: COULEURS[c.etat]! }
                      : { background: 'transparent', border: '1.5px dashed var(--ard-600)' }
                  }
                />
                <span className="text-[13.5px] font-semibold">{LIBELLES_ETAT_TABLE[c.etat]}</span>
                <span className="ml-auto text-base font-bold tabular-nums">{c.nb}</span>
              </div>
            ))}

            <div className="mt-1 rounded-[7px] bg-ard-800 px-3 py-[11px]">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-ard-txt-faible">
                Total en salle
              </div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{formatFCFA(totalSalle)}</div>
              <p className="mt-1 text-[11px] text-ard-txt-faible">Commandes en cours, non encaissées.</p>
            </div>
          </div>

          <div className="flex-none border-t border-ard-700 bg-ard-900 px-4 pb-4 pt-3.5">
            <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ard-txt-faible">
              Transférer une table
            </p>
            {transferables.length === 0 ? (
              <p className="text-[12.5px] text-ard-txt-faible">Aucune table ouverte par un serveur.</p>
            ) : (
              <div className="flex flex-wrap gap-[7px]">
                {transferables.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTransfert(t)}
                    className="inline-flex items-center gap-[7px] rounded-full bg-ard-700 px-3.5 py-2 text-[12.5px] font-semibold text-ard-txt transition hover:bg-ard-650"
                  >
                    <IconArrowsExchange size={15} />
                    {t.numero} · {prenom(t.ouverte_par_nom)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {virtuelle && <ModaleTableVirtuelle table={virtuelle} onFermer={() => setVirtuelle(null)} />}

      {transfert && (
        <ModaleTransfert
          table={transfert}
          onFait={() => {
            setTransfert(null);
            void refetch();
            afficherToast('Table transférée');
          }}
          onFermer={() => setTransfert(null)}
        />
      )}
    </div>
  );
}

/**
 * Carte de table, telle que la maquette : LIBRE reste blanche avec un filet
 * pointillé, une table occupée est peinte EN PLEIN dans la couleur de son état
 * — c'est ce qui rend la salle lisible d'un coup d'œil depuis le comptoir.
 * En bas, le MONTANT EN COURS et l'ancienneté : les deux chiffres qu'on cherche
 * quand un client demande l'addition.
 */
function CarteTable({ table, onClick }: { table: TableVue; onClick: () => void }) {
  const couleur = COULEURS[table.etat];
  const libre = table.etat === 'LIBRE';
  const montant = montantEnCours(table);
  const age = anciennete(table);

  return (
    <button
      type="button"
      onClick={onClick}
      // Prête : la SEULE animation permanente de l'interface — un plat qui
      // attend en cuisine coûte de l'argent, il doit accrocher l'œil.
      className={`relative flex min-h-[116px] flex-col justify-between gap-2.5 overflow-hidden rounded-jeton p-3.5 text-left transition duration-150 hover:-translate-y-0.5 hover:shadow-e2 active:translate-y-0 ${
        libre
          ? 'border-[1.5px] border-dashed border-filet-fort bg-carte text-txt hover:border-solid hover:border-marque hover:bg-marque-tint'
          : 'text-white shadow-e1'
      } ${table.etat === 'PRETE' ? 'pulse-ok' : ''}`}
      style={libre ? undefined : { background: couleur! }}
    >
      {table.badges.length > 0 && (
        <span className="absolute right-2.5 top-2.5 flex gap-1.5">
          {table.badges.map((b) => (
            <span
              key={b}
              title={b}
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] leading-none ${
                libre ? 'bg-surface-douce' : 'bg-white/30'
              }`}
            >
              {b === 'APPEL' ? '🔔' : b === 'FACTURE' ? '🧾' : '✅'}
            </span>
          ))}
        </span>
      )}

      <span>
        <span className="block text-[25px] font-bold leading-none tracking-tight">{table.numero}</span>
        <span className={`mt-1.5 block text-xs font-semibold ${libre ? 'text-faible' : ''}`}>
          {LIBELLES_ETAT_TABLE[table.etat]}
        </span>
      </span>

      <span>
        <span className="block text-[11.5px] font-medium opacity-85">
          {libre
            ? table.partenaire
              ? 'Aucune commande'
              : 'Table libre'
            : table.partenaire
              ? `${table.commandes_ouvertes.length} commande${table.commandes_ouvertes.length > 1 ? 's' : ''} en cours`
              : prenom(table.ouverte_par_nom) || 'En cours'}
        </span>
        {montant > 0 && (
          <span className="mt-0.5 flex items-baseline justify-between gap-2">
            <b className="text-[14.5px] font-bold tabular-nums">{formatFCFA(montant)}</b>
            {age && <span className="text-[11.5px] font-medium opacity-80">{age}</span>}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Table virtuelle : on entre dans une commande DÉJÀ ouverte pour y ajouter des
 * produits, ou on en démarre une nouvelle. Le Kdo (repas offert) vit en zone RC
 * et se crée comme une commande sur place — c'est le SERVEUR qui la marque
 * offerte d'après la table, jamais la caisse.
 */
function ModaleTableVirtuelle({ table, onFermer }: { table: TableVue; onFermer: () => void }) {
  const { aller, afficherToast } = useCaisse();
  const kdo = estTableKdo(table.partenaire);
  const nom = kdo ? LIBELLE_KDO : libellePartenaire(table.partenaire ?? '');
  const enCours = table.commandes_ouvertes ?? [];

  const nouvelle = async () => {
    try {
      const commande = await api<CommandeVue>('/api/commandes', {
        method: 'POST',
        corps: kdo
          ? { type: 'SUR_PLACE', table_id: table.id }
          : { type: 'LIVRAISON', table_id: table.id, partenaire: table.partenaire },
      });
      aller('commande', commande.id);
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  return (
    <Modale titre={nom} onFermer={onFermer} enfants={
      <div className="space-y-3">
        {enCours.length > 0 && (
          <>
            <p className="text-sm text-doux">
              {enCours.length === 1 ? 'Une commande en cours' : `${enCours.length} commandes en cours`} —
              touchez-la pour ajouter des produits.
            </p>
            {enCours.map((c) => (
              <button
                key={c.id}
                type="button"
                className="carte flex w-full items-center justify-between p-4 text-left hover:border-marque"
                onClick={() => aller('commande', c.id)}
              >
                <span>
                  <span className="text-lg font-semibold">{c.code_commande ?? `N°${c.numero_ticket}`}</span>
                  <span className="ml-2 text-sm text-doux">{LIBELLES_STATUTS_COMMANDE[c.statut]}</span>
                </span>
                <span className="text-lg font-semibold">{formatFCFA(c.total)}</span>
              </button>
            ))}
          </>
        )}
        {enCours.length === 0 && (
          <p className="text-sm text-doux">Aucune commande en cours sur {nom}.</p>
        )}
        <button type="button" className="btn-marque w-full py-5 text-lg" onClick={() => void nouvelle()}>
          {kdo ? 'Nouveau Kdo' : `Nouvelle commande ${nom}`}
        </button>
      </div>
    } />
  );
}

function ModaleTransfert({
  table,
  onFait,
  onFermer,
}: {
  table: TableVue;
  onFait: () => void;
  onFermer: () => void;
}) {
  const { afficherToast } = useCaisse();
  const { data: gens } = useQuery({
    queryKey: ['utilisateurs-login'],
    queryFn: () => api<UtilisateurPublic[]>('/api/auth/utilisateurs'),
  });
  const serveurs = (gens ?? []).filter((u) => u.role === 'SERVEUR' && u.id !== table.ouverte_par);

  const transferer = async (serveurId: string) => {
    try {
      await api(`/api/caisse/tables/${table.id}/transferer`, { method: 'POST', corps: { serveur_id: serveurId } });
      onFait();
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  return (
    <Modale titre={`Transférer la table ${table.numero}`} onFermer={onFermer} enfants={
      <div className="space-y-2">
        <p className="text-sm text-doux">Vers quel serveur ?</p>
        {serveurs.map((s) => (
          <button
            key={s.id}
            type="button"
            className="carte w-full p-4 text-left font-semibold hover:border-marque"
            onClick={() => void transferer(s.id)}
          >
            {s.nom_complet}
          </button>
        ))}
        {serveurs.length === 0 && <div className="text-doux">Aucun autre serveur disponible.</div>}
      </div>
    } />
  );
}
