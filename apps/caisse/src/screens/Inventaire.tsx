/**
 * Écran Inventaire (DESIGN_V2 § 6.9) — sans inventaire validé, pas de clôture.
 *
 * Le caissier ne saisit qu'UNE chose : le compté. Stock initial (repris du
 * service précédent), entrées et sorties (ventes) viennent du serveur, le
 * théorique et l'écart en découlent. Chaque total dérivé affiche son calcul en
 * clair — sinon le caissier voit un chiffre tomber du ciel et ne peut pas le
 * contester.
 *
 * Le montant manquant est une INFORMATION pour le manager, pas une retenue.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconClipboardList, IconLock, IconLockOpen, IconPlus, IconPrinter, IconTrash } from '@tabler/icons-react';
import type { EtatStockInstant, EtatStockLigne } from '@pos/shared';
import { libelleCategorieInventaire } from '@pos/shared';
import { api } from '../api';
import { EnteteEcran } from '../components/EnteteEcran';
import { Modale } from '../components/Modale';
import { useCaisse } from '../stores/session';
import { fcfa } from './Depenses';

interface LigneInventaire {
  produit_id: string;
  code: string;
  categorie: string;
  nom: string;
  unite: string;
  role: string;
  prix: number;
  stock_initial: number;
  entrees: number;
  sorties: number;
  theorique: number;
  stock_compte: number | null;
  ecart: number | null;
  quantite_expliquee: number;
  explication: string | null;
  manque_chiffre: number;
  a_compter: boolean;
  calcul: string;
}

interface EntreeRecue {
  id: string;
  produit_id: string;
  produit_nom: string;
  quantite: number;
  fournisseur: string | null;
  created_at: string;
}

interface VueInventaire {
  service_id: string;
  inventaire_id: string;
  valide: boolean;
  valide_le: string | null;
  debloque: boolean;
  debloque_motif: string | null;
  cloture_autorisee: boolean;
  categories: { categorie: string; total: number; restants: number }[];
  lignes: LigneInventaire[];
  bilan: { a_compter: number; justes: number; manquants: number; surplus: number; montant: number };
  entrees: EntreeRecue[];
}


/** Quantités : jamais des entiers (grammes, pots de 4,5, sachets). */
const qte = (n: number): string => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

export function Inventaire() {
  const { rentrer, afficherToast } = useCaisse();
  const [onglet, setOnglet] = useState<'comptage' | 'entrees'>('comptage');
  const [categorie, setCategorie] = useState<string | null>(null);
  const [debloquer, setDebloquer] = useState(false);
  const [tirage, setTirage] = useState(false);
  const queryClient = useQueryClient();

  const { data } = useQuery({ queryKey: ['inventaire'], queryFn: () => api<VueInventaire>('/api/inventaire') });

  const rafraichir = () => {
    void queryClient.invalidateQueries({ queryKey: ['inventaire'] });
    void queryClient.invalidateQueries({ queryKey: ['inventaire-etat'] });
  };

  const valider = useMutation({
    mutationFn: () => api('/api/inventaire/valider', { method: 'POST' }),
    onSuccess: () => {
      afficherToast('Inventaire validé — la clôture est débloquée');
      rafraichir();
    },
    onError: (e: unknown) => afficherToast((e as Error).message),
  });

  if (!data) return <div className="p-6 text-doux">Chargement de l’inventaire…</div>;

  const categorieActive = categorie ?? data.categories[0]?.categorie ?? null;
  const lignes = data.lignes.filter((l) => l.categorie === categorieActive);
  const verrouille = data.valide;

  return (
    <div className="min-h-full bg-fond p-4 sm:p-6">
      <EnteteEcran
        titre="Inventaire"
        onRetour={rentrer}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Le tirage se lit à tout moment, y compris après validation :
                c'est une photo, pas une étape du comptage. */}
            <button
              type="button"
              className="btn-blanc flex items-center gap-2"
              onClick={() => setTirage(true)}
            >
              <IconClipboardList size={18} />
              Stock à l’instant T
            </button>
            <div className="flex rounded-btn border border-bordure bg-surface p-1">
              {(['comptage', 'entrees'] as const).map((o) => (
                <button
                  key={o}
                  type="button"
                  onClick={() => setOnglet(o)}
                  className={`rounded-[9px] px-4 py-2 text-sm font-semibold transition ${
                    onglet === o ? 'bg-marque text-sur-marque' : 'text-doux hover:bg-surface-douce'
                  }`}
                >
                  {o === 'comptage' ? 'Comptage' : `Entrées reçues (${data.entrees.length})`}
                </button>
              ))}
            </div>
          </div>
        }
      />

      {verrouille && (
        <div className="mb-4 flex items-center gap-3 rounded-jeton bg-ok-tint px-4 py-3 text-ok-txt">
          <IconLock size={20} />
          <span className="font-semibold">
            Inventaire validé{data.valide_le ? ` à ${new Date(data.valide_le).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : ''} — tout est en lecture seule.
          </span>
        </div>
      )}
      {!verrouille && data.debloque && (
        <div className="mb-4 flex items-center gap-3 rounded-jeton bg-attente-tint px-4 py-3 text-attente-txt">
          <IconLockOpen size={20} />
          <span className="font-semibold">
            Débloqué par un manager — la clôture est possible sans comptage complet.
            {data.debloque_motif ? ` Motif : ${data.debloque_motif}` : ''}
          </span>
        </div>
      )}

      {onglet === 'comptage' ? (
        <div className="grid gap-4 lg:grid-cols-[220px_1fr_300px]">
          {/* Colonne des catégories, comme l'écran de commande */}
          <nav className="carte h-fit p-2">
            {data.categories.map((c) => (
              <button
                key={c.categorie}
                type="button"
                onClick={() => setCategorie(c.categorie)}
                className={`flex w-full items-center justify-between rounded-btn px-3 py-3 text-left font-semibold transition ${
                  categorieActive === c.categorie ? 'bg-marque text-sur-marque' : 'text-fort hover:bg-surface-douce'
                }`}
              >
                <span>{libelleCategorieInventaire(c.categorie)}</span>
                {c.restants > 0 && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                      categorieActive === c.categorie ? 'bg-white/25' : 'bg-alerte/15 text-alerte'
                    }`}
                  >
                    {c.restants}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="space-y-3">
            {lignes.map((l) =>
              l.a_compter ? (
                <CarteProduit key={l.produit_id} ligne={l} verrouille={verrouille} onEnregistre={rafraichir} onErreur={afficherToast} />
              ) : (
                <LigneConsommation key={l.produit_id} ligne={l} />
              ),
            )}
          </div>

          {/* Panneau droit : manquant, compteurs, validation */}
          <aside className="carte h-fit p-4">
            <div className="text-sm font-semibold uppercase tracking-wider text-doux">Manquant non expliqué</div>
            <div className={`mt-1 text-4xl font-bold tabular-nums ${data.bilan.montant > 0 ? 'text-alerte' : 'text-ok'}`}>
              {fcfa(data.bilan.montant)}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-doux">
              Information pour le manager : ce montant n’est <b>jamais</b> déduit de la caisse.
            </p>

            <div className="mt-5 space-y-2 text-sm">
              <Compteur libelle="Justes" valeur={data.bilan.justes} couleur="text-ok" />
              <Compteur libelle="Manquants" valeur={data.bilan.manquants} couleur="text-alerte" />
              <Compteur libelle="Surplus" valeur={data.bilan.surplus} couleur="text-info" />
              <Compteur libelle="À compter" valeur={data.bilan.a_compter} couleur="text-doux" />
            </div>

            {!verrouille && (
              <>
                <button
                  type="button"
                  disabled={data.bilan.a_compter > 0 || valider.isPending}
                  onClick={() => valider.mutate()}
                  className="btn-accent mt-5 w-full py-4 text-lg disabled:opacity-50"
                >
                  Valider l’inventaire
                </button>
                {data.bilan.a_compter > 0 && (
                  <p className="mt-2 text-center text-xs text-doux">
                    Encore {data.bilan.a_compter} produit{data.bilan.a_compter > 1 ? 's' : ''} à compter.
                  </p>
                )}
                {!data.debloque && (
                  <button type="button" className="btn-blanc mt-2 w-full" onClick={() => setDebloquer(true)}>
                    Débloquer (manager)
                  </button>
                )}
              </>
            )}
          </aside>
        </div>
      ) : (
        <OngletEntrees vue={data} verrouille={verrouille} onChange={rafraichir} onErreur={afficherToast} />
      )}

      {tirage && <ModaleEtatStock onFermer={() => setTirage(false)} onMessage={afficherToast} />}

      {debloquer && (
        <ModaleDeblocage
          restants={data.bilan.a_compter}
          onFermer={() => setDebloquer(false)}
          onDebloque={() => {
            setDebloquer(false);
            rafraichir();
          }}
          onErreur={afficherToast}
        />
      )}
    </div>
  );
}

function Compteur({ libelle, valeur, couleur }: { libelle: string; valeur: number; couleur: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-doux">{libelle}</span>
      <span className={`font-bold tabular-nums ${couleur}`}>{valeur}</span>
    </div>
  );
}

/** Ligne de consommation : se lit seulement, ne se compte JAMAIS. */
function LigneConsommation({ ligne }: { ligne: LigneInventaire }) {
  return (
    <div className="flex items-center justify-between rounded-jeton border border-bordure bg-surface-douce px-4 py-3">
      <span className="min-w-0">
        <span className="block truncate font-semibold text-fort">{ligne.nom}</span>
        <span className="block text-xs text-doux">{ligne.calcul}</span>
      </span>
      <span className="flex-none text-lg font-bold tabular-nums text-doux">
        {ligne.role === 'ENTREE' ? `+${qte(ligne.entrees)}` : qte(ligne.sorties)}
      </span>
    </div>
  );
}

function CarteProduit({
  ligne,
  verrouille,
  onEnregistre,
  onErreur,
}: {
  ligne: LigneInventaire;
  verrouille: boolean;
  onEnregistre: () => void;
  onErreur: (m: string) => void;
}) {
  const [compte, setCompte] = useState(ligne.stock_compte === null ? '' : String(ligne.stock_compte));
  const [explique, setExplique] = useState(ligne.quantite_expliquee ? String(ligne.quantite_expliquee) : '');
  const [texte, setTexte] = useState(ligne.explication ?? '');

  const enregistrer = useMutation({
    mutationFn: (corps: Record<string, unknown>) =>
      api(`/api/inventaire/lignes/${ligne.produit_id}`, { method: 'PUT', corps }),
    onSuccess: onEnregistre,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  const envoyer = () =>
    enregistrer.mutate({
      stock_compte: compte.trim() === '' ? null : Number(compte),
      quantite_expliquee: explique.trim() === '' ? 0 : Number(explique),
      explication: texte.trim() || undefined,
    });

  const ecart = ligne.ecart;
  // Même règle que le serveur (`expliqueeInvalide`) : l'écran prévient, le
  // serveur refuse. La règle n'est jamais appliquée « côté UI seulement ».
  const tropExplique =
    ecart !== null && Math.abs(ecart) > 0.01 && explique.trim() !== ''
    && Number(explique) > Math.abs(ecart) + 0.001;
  const couleurEcart =
    ecart === null ? 'text-doux' : ecart === 0 ? 'text-ok' : ecart < 0 ? 'text-alerte' : 'text-info';
  const bordure =
    ecart === null ? 'border-bordure' : ecart === 0 ? 'border-ok/45' : ecart < 0 ? 'border-alerte/45' : 'border-info/45';

  return (
    <div className={`carte border ${bordure} p-4`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold text-fort">
          {ligne.nom} <span className="text-xs font-medium text-doux">({ligne.unite})</span>
        </h3>
        <span className="text-xs text-doux">{ligne.calcul}</span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Champ libelle="Initial" valeur={qte(ligne.stock_initial)} />
        <Champ libelle="Entrées" valeur={qte(ligne.entrees)} />
        <Champ libelle="Sorties" valeur={qte(ligne.sorties)} />
        <Champ libelle="Théorique" valeur={qte(ligne.theorique)} fort />
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-doux">Compté</div>
          <input
            type="number"
            inputMode="decimal"
            step="any"
            disabled={verrouille}
            value={compte}
            onChange={(e) => setCompte(e.target.value)}
            onBlur={envoyer}
            onKeyDown={(e) => e.key === 'Enter' && envoyer()}
            className="w-full rounded-btn border border-bordure bg-surface px-3 py-2 text-lg font-bold tabular-nums outline-none focus:border-marque disabled:opacity-60"
            placeholder="—"
          />
        </div>
      </div>

      {ecart !== null && (
        <div className={`mt-3 text-sm font-bold ${couleurEcart}`}>
          {ecart === 0 ? 'Aucun écart' : ecart < 0 ? `Manque ${qte(Math.abs(ecart))}` : `Surplus ${qte(ecart)}`}
        </div>
      )}

      {/* TOUT écart ouvre la justification, manquant comme surplus (2026-08-24).
          Le surplus était muet : le caissier ne pouvait rien dire, alors qu'une
          retenue s'y applique côté SamerTrackly. « D'où sortent ces 3 pains ? »
          mérite une réponse — livraison non saisie, vente annulée, erreur de
          comptage — avant que le vérificateur tranche. */}
      {ecart !== null && Math.abs(ecart) > 0.01 && !verrouille && (
        <div className="mt-3 grid gap-2 rounded-jeton bg-surface-douce p-3 sm:grid-cols-[140px_1fr]">
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-doux">
              Quantité expliquée <span className="text-doux/70">(unités)</span>
            </div>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              max={Math.abs(ecart)}
              value={explique}
              onChange={(e) => setExplique(e.target.value)}
              onBlur={envoyer}
              className={`w-full rounded-btn border bg-surface px-3 py-2 tabular-nums outline-none ${
                tropExplique ? 'border-alerte focus:border-alerte' : 'border-bordure focus:border-marque'
              }`}
            />
            <div className="mt-1 text-[11px] text-doux">
              sur {qte(Math.abs(ecart))} {ecart < 0 ? 'manquante(s)' : 'en trop'}
            </div>
            {tropExplique && (
              <div className="mt-1 text-[11px] font-semibold text-alerte">
                Plus que l’écart constaté. Saisissez un nombre d’unités, pas un montant.
              </div>
            )}
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-doux">Explication</div>
            <input
              type="text"
              value={texte}
              onChange={(e) => setTexte(e.target.value)}
              onBlur={envoyer}
              placeholder={ecart < 0 ? 'Ex. casse, offert, chute au sol…' : 'Ex. livraison non saisie, vente annulée…'}
              className="w-full rounded-btn border border-bordure bg-surface px-3 py-2 outline-none focus:border-marque"
            />
          </div>
        </div>
      )}

      {/* Le montant est affiché APRÈS la saisie, et nommé « montant » : placé
          juste au-dessus du champ, il se faisait recopier dedans (constaté au
          7E le 2026-08-23 — « manquant 3, expliqué 24 000 »). */}
      {ligne.manque_chiffre > 0 && (
        <div className="mt-2 text-xs font-medium text-doux">
          Montant de l’écart non justifié : {fcfa(ligne.manque_chiffre)}
        </div>
      )}
    </div>
  );
}

function Champ({ libelle, valeur, fort }: { libelle: string; valeur: string; fort?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-doux">{libelle}</div>
      <div
        className={`rounded-btn px-3 py-2 text-lg tabular-nums ${
          fort ? 'bg-marque-tint font-bold text-marque-fonce' : 'bg-surface-douce font-semibold text-doux'
        }`}
      >
        {valeur}
      </div>
    </div>
  );
}

function OngletEntrees({
  vue,
  verrouille,
  onChange,
  onErreur,
}: {
  vue: VueInventaire;
  verrouille: boolean;
  onChange: () => void;
  onErreur: (m: string) => void;
}) {
  const [ajout, setAjout] = useState(false);

  const supprimer = useMutation({
    mutationFn: (id: string) => api(`/api/inventaire/entrees/${id}`, { method: 'DELETE' }),
    onSuccess: onChange,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  return (
    <div className="carte p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">Entrées reçues pendant le service</h2>
        {!verrouille && (
          <button type="button" className="btn-accent flex items-center gap-2" onClick={() => setAjout(true)}>
            <IconPlus size={18} />
            Enregistrer une réception
          </button>
        )}
      </div>

      {vue.entrees.length === 0 && <p className="py-10 text-center text-doux">Aucune réception enregistrée.</p>}

      <ul className="divide-y divide-bordure">
        {vue.entrees.map((e) => (
          <li key={e.id} className="flex items-center gap-3 py-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-fort">{e.produit_nom}</span>
              <span className="block text-xs text-doux">
                {new Date(e.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                {e.fournisseur ? ` · ${e.fournisseur}` : ''}
              </span>
            </span>
            <span className="flex-none text-lg font-bold tabular-nums text-fort">+{qte(e.quantite)}</span>
            {!verrouille && (
              <button
                type="button"
                onClick={() => supprimer.mutate(e.id)}
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-doux transition hover:bg-alerte/10 hover:text-alerte"
              >
                <IconTrash size={18} />
              </button>
            )}
          </li>
        ))}
      </ul>

      {ajout && (
        <ModaleEntree
          lignes={vue.lignes}
          onFermer={() => setAjout(false)}
          onEnregistre={() => {
            setAjout(false);
            onChange();
          }}
          onErreur={onErreur}
        />
      )}
    </div>
  );
}

function ModaleEntree({
  lignes,
  onFermer,
  onEnregistre,
  onErreur,
}: {
  lignes: LigneInventaire[];
  onFermer: () => void;
  onEnregistre: () => void;
  onErreur: (m: string) => void;
}) {
  const [produit, setProduit] = useState(lignes[0]?.produit_id ?? '');
  const [quantite, setQuantite] = useState('');
  const [fournisseur, setFournisseur] = useState('');

  const enregistrer = useMutation({
    mutationFn: () =>
      api('/api/inventaire/entrees', {
        method: 'POST',
        corps: { produit_id: produit, quantite: Number(quantite), fournisseur: fournisseur.trim() || undefined },
      }),
    onSuccess: onEnregistre,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  return (
    <Modale
      titre="Réception de marchandise"
      onFermer={onFermer}
      enfants={
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Produit</div>
            <select
              value={produit}
              onChange={(e) => setProduit(e.target.value)}
              className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 outline-none focus:border-marque"
            >
              {lignes
                // Les consommations ne se reçoivent pas : elles se déduisent.
                .filter((l) => !l.role.startsWith('CONSO'))
                .map((l) => (
                  <option key={l.produit_id} value={l.produit_id}>
                    {libelleCategorieInventaire(l.categorie)} — {l.nom} ({l.unite})
                  </option>
                ))}
            </select>
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Quantité reçue</div>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={quantite}
              onChange={(e) => setQuantite(e.target.value)}
              className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 text-2xl font-bold tabular-nums outline-none focus:border-marque"
              placeholder="0"
            />
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Fournisseur (optionnel)</div>
            <input
              type="text"
              value={fournisseur}
              onChange={(e) => setFournisseur(e.target.value)}
              className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 outline-none focus:border-marque"
            />
          </div>
          <button
            type="button"
            disabled={!produit || Number(quantite) <= 0 || enregistrer.isPending}
            className="btn-accent w-full py-4 text-lg disabled:opacity-50"
            onClick={() => enregistrer.mutate()}
          >
            Enregistrer la réception
          </button>
        </div>
      }
    />
  );
}

/**
 * Tirage du stock à l'instant T (§ 6.9) — « combien il me reste de pain, là,
 * maintenant ? ». Présenté comme une facture : le nom à gauche, le stock à
 * droite, reliés par des points de conduite, et le détail qui l'explique en
 * petit dessous. Le même papier sort de l'imprimante de la caisse.
 *
 * Lecture pure : ouvrir ce tirage ne valide rien et ne fige rien. Il reste donc
 * accessible même après validation de l'inventaire.
 */
function ModaleEtatStock({ onFermer, onMessage }: { onFermer: () => void; onMessage: (m: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['inventaire-etat-stock'],
    // Une photo ne se rafraîchit pas toute seule : l'heure affichée en haut
    // doit rester celle des chiffres du dessous. Mais le cache meurt avec la
    // modale, sinon la rouvrir dix minutes plus tard ressortirait la photo de
    // tout à l'heure — le contraire de « à l'instant T ».
    staleTime: Infinity,
    gcTime: 0,
    queryFn: () => api<EtatStockInstant>('/api/inventaire/etat-stock'),
  });

  const imprimer = useMutation({
    mutationFn: () => api('/api/inventaire/etat-stock/imprimer', { method: 'POST' }),
    onSuccess: () => onMessage('Tirage envoyé à l’imprimante'),
    onError: (e: unknown) => onMessage((e as Error).message),
  });

  return (
    <Modale
      titre="Stock à l’instant T"
      large
      onFermer={onFermer}
      enfants={
        isLoading || !data ? (
          <p className="py-10 text-center text-doux">Tirage du stock…</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-jeton bg-surface-douce px-4 py-3 text-sm text-doux">
              Tiré le{' '}
              <b className="text-fort">
                {new Date(data.genere_le).toLocaleString('fr-FR', {
                  day: '2-digit',
                  month: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </b>{' '}
              par <b className="text-fort">{data.genere_par}</b>.
            </div>

            {/* Un tirage n'est pas un inventaire : sans cette phrase, le chiffre
                théorique passerait pour un stock compté. */}
            {data.nb_theoriques > 0 && (
              <div className="flex items-start gap-3 rounded-jeton bg-attente-tint px-4 py-3 text-attente-txt">
                <IconAlertTriangle size={20} className="mt-0.5 flex-none" />
                <p className="text-sm">
                  <b>{data.nb_theoriques}</b> produit{data.nb_theoriques > 1 ? 's' : ''} non compté
                  {data.nb_theoriques > 1 ? 's' : ''} : leur stock est <b>théorique</b> (initial + entrées − ventes).
                  Les autres portent le chiffre réellement compté.
                </p>
              </div>
            )}

            {data.lignes.length === 0 ? (
              <p className="py-10 text-center text-doux">Aucun produit à suivre en stock.</p>
            ) : (
              <div className="space-y-4">
                {[...new Set(data.lignes.map((l) => l.categorie))].map((cat) => (
                  <section key={cat}>
                    <h3 className="mb-1 text-xs font-bold uppercase tracking-wider text-doux">
                      {libelleCategorieInventaire(cat)}
                    </h3>
                    <ul className="divide-y divide-bordure">
                      {data.lignes
                        .filter((l) => l.categorie === cat)
                        .map((l) => (
                          <LigneTirage key={l.produit_id} ligne={l} />
                        ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            <button
              type="button"
              disabled={imprimer.isPending || data.lignes.length === 0}
              className="btn-accent flex w-full items-center justify-center gap-2 py-4 text-lg disabled:opacity-50"
              onClick={() => imprimer.mutate()}
            >
              <IconPrinter size={20} />
              {imprimer.isPending ? 'Envoi…' : 'Imprimer le tirage'}
            </button>
          </div>
        )
      }
    />
  );
}

/** Une ligne du tirage : nom à gauche, stock à droite, points entre les deux. */
function LigneTirage({ ligne }: { ligne: EtatStockLigne }) {
  return (
    <li className="py-2">
      <div className="flex items-baseline gap-2">
        <span className="flex-none font-semibold text-fort">
          {ligne.nom} <span className="text-xs font-normal text-doux">({ligne.unite})</span>
        </span>
        <span className="min-w-[1.5rem] flex-1 self-center border-b border-dotted border-bordure" />
        <span className="flex-none text-xl font-bold tabular-nums text-fort">{qte(ligne.stock)}</span>
      </div>
      <div className="text-[11px] text-doux">
        Initial {qte(ligne.stock_initial)} · Entrées +{qte(ligne.entrees)} · Sorties −{qte(ligne.sorties)}
        {ligne.compte && <span className="ml-1 font-semibold text-ok">· compté</span>}
      </div>
    </li>
  );
}

/**
 * Issue de secours (§ 6.10). Sans elle, un caissier bloqué à 2 h du matin ne
 * peut plus fermer sa caisse. Toujours tracée au journal d'audit.
 *
 * Exportée : l'écran de clôture la propose aussi, là où le caissier se heurte
 * réellement au verrou — l'envoyer d'abord à l'inventaire pour y trouver le
 * bouton serait un détour inutile.
 */
export function ModaleDeblocage({
  restants,
  onFermer,
  onDebloque,
  onErreur,
}: {
  restants: number;
  onFermer: () => void;
  onDebloque: () => void;
  onErreur: (m: string) => void;
}) {
  const [pin, setPin] = useState('');
  const [motif, setMotif] = useState('');

  const debloquer = useMutation({
    mutationFn: () => api('/api/inventaire/debloquer', { method: 'POST', corps: { pin_manager: pin, motif } }),
    onSuccess: onDebloque,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  return (
    <Modale
      titre="Débloquer la clôture"
      onFermer={onFermer}
      enfants={
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-jeton bg-attente-tint px-4 py-3 text-attente-txt">
            <IconAlertTriangle size={20} className="mt-0.5 flex-none" />
            <p className="text-sm">
              Il reste <b>{restants}</b> produit{restants > 1 ? 's' : ''} à compter. Le déblocage permet de clôturer
              sans comptage complet — il est <b>enregistré au journal</b> avec le nom du manager et le motif.
            </p>
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold text-doux">PIN manager</div>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 text-2xl tracking-[0.4em] outline-none focus:border-marque"
            />
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold text-doux">Motif (obligatoire)</div>
            <input
              type="text"
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              placeholder="Ex. fin de service, comptage impossible ce soir"
              className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 outline-none focus:border-marque"
            />
          </div>
          <button
            type="button"
            disabled={pin.length < 4 || !motif.trim() || debloquer.isPending}
            className="btn-accent w-full py-4 text-lg disabled:opacity-50"
            onClick={() => debloquer.mutate()}
          >
            Débloquer
          </button>
        </div>
      }
    />
  );
}
