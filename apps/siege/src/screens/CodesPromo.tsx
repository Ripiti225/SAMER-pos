import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBan, IconBrandWhatsapp, IconDownload, IconPlus } from '@tabler/icons-react';
import { formatFCFA } from '@pos/shared';
import { appelPromo, ErreurSiege, type CodePromo, type FichePromo, type LotPromo, type RelancePromo, type Siege } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { PlancheLot } from '../components/PlancheLot';
import {
  csvCodes,
  csvRelances,
  datesParDefaut,
  etatLot,
  expireDans,
  jourMois,
  jourMoisAn,
  LIBELLES_ETAT,
  lienWhatsApp,
  precisionEtat,
  resumeLots,
  telephoneLisible,
  texteFeuilles,
  type EtatLot,
} from '../promo';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';
import { telechargerCsv as telecharger } from '../telechargement';
import { BilanLot } from './BilanLot';

type Vue = 'lots' | 'relances' | 'fiches';

const message = (e: unknown, defaut: string) => (e instanceof ErreurSiege ? e.message : defaut);


function useFiches() {
  return useQuery({
    queryKey: ['promo_restaurants'],
    queryFn: () => appelPromo<{ restaurants: FichePromo[] }>('restaurants_promo'),
    staleTime: 60_000,
  });
}

/**
 * Onglet « Codes promo cartes » (brief PROMO, § 7) : les lots d'autocollants
 * −20 %, les clients à relancer et ce qui s'imprime pour chaque restaurant.
 *
 * Tout passe par la fonction `promo`. Les droits y sont appliqués : ici, on ne
 * fait que masquer ce qu'un compte LECTURE ne pourrait de toute façon pas faire.
 */
export function CodesPromo({ siege, filtre, onFiltre }: { siege: Siege; filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const admin = siege.niveau === 'ADMIN';
  const [vue, setVue] = useState<Vue>('lots');
  const [creation, setCreation] = useState(false);

  const { data: restos } = useRestaurants();
  const choisi = restoChoisi(restos?.restaurants, filtre);
  // Le filtre porte l'id SamerTrackly ; les lots, l'UUID du POS. Un site non enrôlé n'en a pas.
  const restaurantId = choisi?.restaurant_id ?? null;
  const filtreSansSite = !!choisi && !restaurantId;

  const fiches = useFiches();
  const nomResto = useMemo(() => {
    const m = new Map((fiches.data?.restaurants ?? []).map((r) => [r.restaurant_id, r.nom]));
    return (id: string) => m.get(id) ?? 'Restaurant inconnu';
  }, [fiches.data]);

  const urgents = useQuery({
    queryKey: ['promo_relances', restaurantId, 3],
    queryFn: () => appelPromo<{ relances: RelancePromo[] }>('relances', { restaurant_id: restaurantId, jours: 3 }),
    enabled: admin && !filtreSansSite,
    staleTime: 60_000,
  });

  const onglets: { cle: Vue; libelle: string; badge?: number }[] = [
    { cle: 'lots', libelle: 'Lots' },
    ...(admin ? [{ cle: 'relances' as const, libelle: 'Numéros à relancer', badge: urgents.data?.relances.length }] : []),
    { cle: 'fiches', libelle: 'Fiches restaurants' },
  ];

  return (
    <section>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Codes promo cartes</h1>
        <div className="flex flex-wrap items-center gap-3">
          <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
          {admin && (
            <button type="button" className="btn-accent" onClick={() => setCreation(true)}>
              <IconPlus size={18} /> Créer un lot
            </button>
          )}
        </div>
      </div>

      <div role="tablist" aria-label="Vues" className="mb-5 inline-flex flex-wrap gap-1 rounded-jeton bg-carte-douce p-1">
        {onglets.map((o) => (
          <button
            key={o.cle}
            type="button"
            role="tab"
            aria-selected={vue === o.cle}
            onClick={() => setVue(o.cle)}
            className={`rounded-btn px-4 py-2 text-sm ${vue === o.cle ? 'bg-carte font-semibold text-txt shadow-e1' : 'text-doux'}`}
          >
            {o.libelle}
            {!!o.badge && <span className="ml-2 rounded-full bg-attente-tint px-2 py-0.5 text-xs font-semibold text-attente-txt">{o.badge}</span>}
          </button>
        ))}
      </div>

      {filtreSansSite && vue !== 'fiches' ? (
        <Info>
          <b>{choisi?.nom} ne synchronise pas encore.</b> Sa caisse n’est pas reliée au cloud : elle ne pourrait pas
          reconnaître un code. Pas de lot possible tant qu’elle n’est pas enrôlée.
        </Info>
      ) : vue === 'lots' ? (
        <VueLots admin={admin} restaurantId={restaurantId} nomResto={nomResto} />
      ) : vue === 'relances' ? (
        <VueRelances restaurantId={restaurantId} nomResto={nomResto} />
      ) : (
        <VueFiches admin={admin} />
      )}

      {creation && (
        <CreerLot
          fiches={fiches.data?.restaurants ?? []}
          parDefaut={restaurantId}
          onFermer={() => setCreation(false)}
          onCree={() => {
            setCreation(false);
            setVue('lots');
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

const COULEURS_ETAT: Record<EtatLot, string> = {
  EN_COURS: 'bg-ok-tint text-ok-txt',
  A_VENIR: 'bg-carte-douce text-doux',
  TERMINE: 'bg-carte-douce text-doux',
  ANNULE: 'bg-alerte-tint text-alerte-txt',
};

function VueLots({ admin, restaurantId, nomResto }: { admin: boolean; restaurantId: string | null; nomResto: (id: string) => string }) {
  const [aAnnuler, setAAnnuler] = useState<LotPromo | null>(null);
  const [aImprimer, setAImprimer] = useState<LotPromo | null>(null);
  const [ouvert, setOuvert] = useState<LotPromo | null>(null);
  const [erreurCsv, setErreurCsv] = useState<string | null>(null);
  const fiches = useFiches();
  const { data, isPending, error } = useQuery({
    queryKey: ['promo_lots', restaurantId],
    queryFn: () => appelPromo<{ lots: LotPromo[] }>('lots', { restaurant_id: restaurantId }),
    staleTime: 30_000,
  });
  const maintenant = new Date();
  const lots = data?.lots ?? [];
  const r = resumeLots(lots, maintenant);

  const csv = useMutation({
    mutationFn: (lot: LotPromo) =>
      appelPromo<{ codes: CodePromo[] }>('lot_codes', { restaurant_id: lot.restaurant_id, lot_id: lot.id }).then((rep) => ({ lot, rep })),
    onSuccess: ({ lot, rep }) => telecharger(`lot-${lot.libelle.replace(/[^\p{L}\d]+/gu, '-')}-codes.csv`, csvCodes(rep.codes)),
    onError: (e) => setErreurCsv(message(e, 'Export impossible')),
  });

  if (error) return <Erreur texte={message(error, 'Lecture des lots impossible')} />;
  if (isPending) return <Squelette lignes={4} />;
  if (ouvert) {
    return <BilanLot lot={ouvert} admin={admin} nomResto={nomResto(ouvert.restaurant_id)} onRetour={() => setOuvert(null)} />;
  }

  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tuile libelle="Codes en circulation" valeur={String(r.enCirculation)} detail={`${r.lotsVivants} lot${r.lotsVivants > 1 ? 's' : ''} en cours ou à venir`} />
        <Tuile
          libelle="Gardés sur un numéro"
          valeur={String(r.gardes)}
          detail={r.codesDistribues ? `${Math.round((r.gardes / r.codesDistribues) * 1000) / 10} % des codes` : '—'}
        />
        <Tuile libelle="Utilisés" valeur={String(r.utilises)} detail={`dont ${r.telephone} au téléphone, ${r.site} par le site`} />
        <Tuile libelle="Remise accordée" valeur={formatFCFA(r.remise)} detail={`pour ${formatFCFA(r.ca)} de CA`} />
      </div>

      {erreurCsv && <Erreur texte={erreurCsv} />}

      {lots.length === 0 ? (
        <Info>Aucun lot pour l’instant.{admin && ' « Créer un lot » tire les codes d’un restaurant ; la planche à imprimer se télécharge ensuite ici.'}</Info>
      ) : (
        <div className="overflow-x-auto rounded-jeton border border-filet bg-carte shadow-e1">
          <table className="w-full min-w-[980px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-filet text-[12px] uppercase tracking-wide text-doux">
                <th className="px-4 py-3 font-semibold">Lot</th>
                <th className="px-4 py-3 font-semibold">Période</th>
                <th className="px-4 py-3 text-right font-semibold">Codes</th>
                <th className="px-4 py-3 text-right font-semibold">Gardés</th>
                <th className="px-4 py-3 text-right font-semibold">Utilisés</th>
                <th className="px-4 py-3 text-right font-semibold">CA généré</th>
                <th className="px-4 py-3 text-right font-semibold">Remise</th>
                <th className="px-4 py-3 font-semibold">État</th>
                {admin && <th className="px-4 py-3"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {lots.map((l) => {
                const etat = etatLot(l, maintenant);
                const vide = l.utilises === 0;
                return (
                  <tr key={l.id} className="border-b border-filet last:border-0">
                    <td className="px-4 py-3.5">
                      <button
                        type="button"
                        className="text-left font-semibold text-marque-sur-plan underline-offset-2 hover:underline"
                        title="Voir le bilan du lot"
                        onClick={() => setOuvert(l)}
                      >
                        {l.libelle}
                      </button>
                      <div className="text-[13px] text-doux">{nomResto(l.restaurant_id)} · −{l.pourcentage} %</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3.5">
                      {jourMois(l.valide_du)} → {jourMoisAn(l.valide_au)}
                      <div className="text-[13px] text-doux">{precisionEtat(l, maintenant)}</div>
                    </td>
                    <td className="chiffres px-4 py-3.5 text-right">{l.quantite}</td>
                    <td className="chiffres px-4 py-3.5 text-right">
                      {l.actives}
                      <div className="text-[13px] text-doux">{Math.round((l.actives / l.quantite) * 100)} %</div>
                    </td>
                    <td className="chiffres px-4 py-3.5 text-right">
                      {l.utilises}
                      {!vide && (
                        <div className="text-[13px] text-doux">
                          caisse {l.utilises_sur_place} · tél. {l.utilises_telephone} · site {l.utilises_site}
                        </div>
                      )}
                    </td>
                    <td className={`chiffres px-4 py-3.5 text-right ${vide ? 'text-faible' : ''}`}>{vide ? '—' : formatFCFA(l.ca)}</td>
                    <td className={`chiffres px-4 py-3.5 text-right ${vide ? 'text-faible' : ''}`}>{vide ? '—' : formatFCFA(l.remise)}</td>
                    <td className="px-4 py-3.5">
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-[13px] font-semibold ${COULEURS_ETAT[etat]}`}>{LIBELLES_ETAT[etat]}</span>
                      {l.conflits > 0 && (
                        <div className="mt-1.5 text-[13px] font-semibold text-alerte-txt">
                          {l.conflits === 1 ? '1 code encaissé deux fois' : `${l.conflits} codes encaissés deux fois`}
                        </div>
                      )}
                    </td>
                    {admin && (
                      <td className="px-4 py-3.5">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            className="btn-blanc !min-h-[36px] !px-3 !text-[13px]"
                            disabled={etat === 'ANNULE'}
                            onClick={() => setAImprimer(l)}
                          >
                            Planche PDF
                          </button>
                          <button
                            type="button"
                            className="btn-blanc !min-h-[36px] !px-3 !text-[13px]"
                            disabled={csv.isPending}
                            onClick={() => { setErreurCsv(null); csv.mutate(l); }}
                          >
                            CSV
                          </button>
                          {etat !== 'ANNULE' && etat !== 'TERMINE' && (
                            <button
                              type="button"
                              className="btn-blanc !min-h-[36px] !px-2.5 text-alerte-txt"
                              aria-label={`Annuler le lot ${l.libelle}`}
                              title="Annuler le lot"
                              onClick={() => setAAnnuler(l)}
                            >
                              <IconBan size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 max-w-4xl text-[13px] text-doux">
        Un lot = des codes pour un seul restaurant, hors Chawarma. « Gardés » = codes que le client a rattachés à son numéro en
        scannant l’autocollant. Seule la caisse consomme un code ; annuler un lot rend ses codes non utilisés invalides partout.
      </p>

      {aAnnuler && <AnnulerLot lot={aAnnuler} nomResto={nomResto(aAnnuler.restaurant_id)} onFermer={() => setAAnnuler(null)} />}
      {aImprimer && (
        <PlancheLot
          lot={aImprimer}
          fiche={fiches.data?.restaurants.find((f) => f.restaurant_id === aImprimer.restaurant_id)}
          onFermer={() => setAImprimer(null)}
        />
      )}
    </>
  );
}

function Tuile({ libelle, valeur, detail }: { libelle: string; valeur: string; detail: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-jeton border border-filet bg-carte px-4 py-4 shadow-e1">
      <span className="text-[13px] text-doux">{libelle}</span>
      <span className="chiffres text-[26px] font-bold leading-none">{valeur}</span>
      <span className="text-[13px] text-doux">{detail}</span>
    </div>
  );
}

function Fenetre({ titre, onFermer, children }: { titre: string; onFermer: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16" onClick={onFermer}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={titre}
        className="w-full max-w-xl rounded-jeton border border-filet bg-carte p-6 shadow-e2"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-xl font-bold">{titre}</h2>
        {children}
      </div>
    </div>
  );
}

function AnnulerLot({ lot, nomResto, onFermer }: { lot: LotPromo; nomResto: string; onFermer: () => void }) {
  const qc = useQueryClient();
  const restants = lot.quantite - lot.utilises - lot.annules;
  const annuler = useMutation({
    mutationFn: () => appelPromo<{ codes_annules: number }>('lot_annuler', { restaurant_id: lot.restaurant_id, lot_id: lot.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['promo_lots'] });
      void qc.invalidateQueries({ queryKey: ['promo_relances'] });
      onFermer();
    },
  });
  return (
    <Fenetre titre={`Annuler « ${lot.libelle} » ?`} onFermer={onFermer}>
      <p className="mb-3 text-doux">
        Les {restants} codes pas encore utilisés de {nomResto} ne marcheront plus nulle part, y compris ceux que des clients
        ont gardés sur leur numéro. Les {lot.utilises} déjà utilisés restent comptés. Cette annulation est définitive.
      </p>
      {annuler.error && <Erreur texte={message(annuler.error, 'Annulation impossible')} />}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-blanc" onClick={onFermer}>Garder le lot</button>
        <button type="button" className="btn-alerte" disabled={annuler.isPending} onClick={() => annuler.mutate()}>
          {annuler.isPending ? 'Annulation…' : 'Annuler le lot'}
        </button>
      </div>
    </Fenetre>
  );
}

function CreerLot({
  fiches,
  parDefaut,
  onFermer,
  onCree,
}: {
  fiches: FichePromo[];
  parDefaut: string | null;
  onFermer: () => void;
  onCree: () => void;
}) {
  const qc = useQueryClient();
  const possibles = fiches.filter((f) => f.prefixe_promo);
  const dates = datesParDefaut(new Date());
  const [restaurantId, setRestaurantId] = useState(possibles.find((f) => f.restaurant_id === parDefaut)?.restaurant_id ?? possibles[0]?.restaurant_id ?? '');
  const resto = possibles.find((f) => f.restaurant_id === restaurantId);
  const [libelle, setLibelle] = useState('');
  const [quantite, setQuantite] = useState('200');
  const [pourcentage, setPourcentage] = useState('20');
  const [du, setDu] = useState(dates.du);
  const [au, setAu] = useState(dates.au);

  const n = Number(quantite) || 0;
  const p = Number(pourcentage) || 0;
  const titre = libelle.trim() || (resto ? `Autocollants ${resto.nom}` : '');

  const creer = useMutation({
    mutationFn: () =>
      appelPromo<{ lot_id: string }>('lot_creer', { restaurant_id: restaurantId, libelle: titre, quantite: n, pourcentage: p, du, au }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['promo_lots'] });
      void qc.invalidateQueries({ queryKey: ['promo_restaurants'] });
      onCree();
    },
  });

  return (
    <Fenetre titre="Créer un lot de codes" onFermer={onFermer}>
      <p className="mb-4 text-sm text-doux">
        Un code par autocollant. Les codes sont tirés tout de suite ; la planche à imprimer se télécharge ensuite depuis la liste.
      </p>
      {possibles.length === 0 ? (
        <Info>Aucun restaurant n’a encore de préfixe : renseignez-le d’abord dans « Fiches restaurants ».</Info>
      ) : (
        <div className="space-y-4">
          <label className="block text-sm font-semibold">
            Restaurant
            <select className="champ mt-1" value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)}>
              {possibles.map((f) => (
                <option key={f.restaurant_id} value={f.restaurant_id}>
                  {f.nom} — codes {f.prefixe_promo}-…
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-semibold">
            Libellé
            <input className="champ mt-1" value={libelle} placeholder={titre} maxLength={80} onChange={(e) => setLibelle(e.target.value)} />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold">
              Nombre de codes
              <input className="champ mt-1" inputMode="numeric" value={quantite} onChange={(e) => setQuantite(e.target.value.replace(/\D/g, ''))} />
              <span className="mt-1 block text-[13px] font-normal text-doux">{texteFeuilles(n)}</span>
            </label>
            <label className="block text-sm font-semibold">
              Remise (%)
              <input className="champ mt-1" inputMode="numeric" value={pourcentage} onChange={(e) => setPourcentage(e.target.value.replace(/\D/g, ''))} />
              <span className="mt-1 block text-[13px] font-normal text-doux">Jamais sur les catégories exclues (Chawarma)</span>
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold">
              Valable du
              <input className="champ mt-1" type="date" value={du} onChange={(e) => setDu(e.target.value)} />
            </label>
            <label className="block text-sm font-semibold">
              au (inclus)
              <input className="champ mt-1" type="date" value={au} onChange={(e) => setAu(e.target.value)} />
            </label>
          </div>
          <p className="!-mt-1 text-[13px] text-doux">Par défaut : du lendemain, pendant 28 jours. C’est la relance qui crée l’urgence, pas la date.</p>

          {resto && n > 0 && p > 0 && du && au && (
            <div className="rounded-btn bg-marque-tint px-4 py-3 text-sm leading-relaxed">
              <b>{n} codes {resto.prefixe_promo}-•••••</b> à −{p} % chez <b>{resto.nom}</b>, hors Chawarma, du{' '}
              <b>{jourMois(du)}</b> au <b>{jourMoisAn(au)}</b>. Usage unique, valables seulement dans ce restaurant. Cumulables avec le
              happy hour, en cascade.
            </div>
          )}

          {creer.error && <Erreur texte={message(creer.error, 'Création impossible')} />}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-blanc" onClick={onFermer}>Annuler</button>
            <button type="button" className="btn-accent" disabled={!resto || n < 1 || p < 1 || !du || !au || creer.isPending} onClick={() => creer.mutate()}>
              {creer.isPending ? 'Tirage des codes…' : `Créer les ${n} codes`}
            </button>
          </div>
        </div>
      )}
    </Fenetre>
  );
}

// ---------------------------------------------------------------------------
// Numéros à relancer (ADMIN : ce sont des numéros de téléphone)
// ---------------------------------------------------------------------------

function VueRelances({ restaurantId, nomResto }: { restaurantId: string | null; nomResto: (id: string) => string }) {
  const [tous, setTous] = useState(false);
  const { data, isPending, error } = useQuery({
    queryKey: ['promo_relances', restaurantId, tous ? null : 3],
    queryFn: () => appelPromo<{ relances: RelancePromo[] }>('relances', { restaurant_id: restaurantId, jours: tous ? null : 3 }),
    staleTime: 60_000,
  });
  const relances = data?.relances ?? [];
  const maintenant = new Date();

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {[
            { actif: !tous, libelle: 'Expire dans 3 jours', choisir: () => setTous(false) },
            { actif: tous, libelle: 'Gardé, jamais utilisé', choisir: () => setTous(true) },
          ].map((f) => (
            <button
              key={f.libelle}
              type="button"
              aria-pressed={f.actif}
              onClick={f.choisir}
              className={`min-h-[40px] rounded-full border px-4 text-sm ${f.actif ? 'border-txt bg-txt font-semibold text-carte' : 'border-filet-fort bg-carte'}`}
            >
              {f.libelle}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-blanc"
          disabled={relances.length === 0}
          onClick={() => telecharger(tous ? 'codes-gardes-jamais-utilises.csv' : 'codes-a-relancer.csv', csvRelances(relances, nomResto))}
        >
          <IconDownload size={18} /> Exporter en CSV
        </button>
      </div>

      <Info>
        Clients qui ont gardé leur remise en scannant l’autocollant <b>et accepté d’être recontactés</b>, sans l’avoir encore
        utilisée. La relance se fait à la main, sur WhatsApp : le bouton ouvre la conversation avec un message prêt, à relire
        avant l’envoi. Le code n’apparaît jamais en clair.
      </Info>

      {error ? (
        <Erreur texte={message(error, 'Lecture des numéros impossible')} />
      ) : isPending ? (
        <Squelette lignes={3} />
      ) : relances.length === 0 ? (
        <p className="text-doux">{tous ? 'Aucun code gardé en attente d’utilisation.' : 'Aucun code gardé n’expire dans les 3 jours.'}</p>
      ) : (
        <div className="overflow-x-auto rounded-jeton border border-filet bg-carte shadow-e1">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-filet text-[12px] uppercase tracking-wide text-doux">
                <th className="px-4 py-3 font-semibold">Numéro</th>
                <th className="px-4 py-3 font-semibold">Restaurant</th>
                <th className="px-4 py-3 font-semibold">Code</th>
                <th className="px-4 py-3 font-semibold">Gardé le</th>
                <th className="px-4 py-3 font-semibold">Expire</th>
                <th className="px-4 py-3"><span className="sr-only">Relancer</span></th>
              </tr>
            </thead>
            <tbody>
              {relances.map((r) => {
                const quand = expireDans(r.valide_au, maintenant);
                const urgent = quand === 'aujourd’hui' || quand === 'demain';
                return (
                  <tr key={`${r.lot_id}-${r.code_masque}-${r.telephone}`} className="border-b border-filet last:border-0">
                    <td className="chiffres px-4 py-3 font-semibold">{telephoneLisible(r.telephone)}</td>
                    <td className="px-4 py-3">{nomResto(r.restaurant_id)}</td>
                    <td className="px-4 py-3 font-mono">{r.code_masque}</td>
                    <td className="px-4 py-3 text-doux">{jourMois(r.active_le)}</td>
                    <td className={`px-4 py-3 font-semibold ${urgent ? 'text-alerte-txt' : 'text-attente-txt'}`}>{quand}</td>
                    <td className="px-4 py-3 text-right">
                      <a
                        className="btn-blanc !min-h-[36px] !px-3 !text-[13px] text-ok-txt"
                        href={lienWhatsApp(r, nomResto(r.restaurant_id))}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <IconBrandWhatsapp size={16} /> WhatsApp
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Fiches restaurants : ce qui s'imprime et ce qui ouvre la page d'activation
// ---------------------------------------------------------------------------

function VueFiches({ admin }: { admin: boolean }) {
  const { data, isPending, error } = useFiches();
  const [edition, setEdition] = useState<FichePromo | null>(null);
  if (error) return <Erreur texte={message(error, 'Lecture des restaurants impossible')} />;
  if (isPending) return <Squelette lignes={4} />;

  return (
    <>
      <p className="mb-4 max-w-4xl text-sm text-doux">
        Ce qui s’imprime sur les autocollants et ce qui ouvre la bonne page d’activation. Le préfixe ne change plus dès qu’un lot
        existe : les codes déjà imprimés le portent. Les catégories exclues des remises (Chawarma) se règlent dans l’onglet Catégories.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {(data?.restaurants ?? []).map((f) => (
          <div key={f.restaurant_id} className="flex items-start gap-3.5 rounded-jeton border border-filet bg-carte p-4 shadow-e1">
            <span className="inline-flex h-9 w-14 flex-none items-center justify-center rounded-sm bg-carte-douce font-mono text-sm font-bold">
              {f.prefixe_promo ?? '—'}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex items-center gap-2 font-semibold">
                <PastilleMarque marque={f.marque} /> <span className="truncate">{f.nom}</span>
              </div>
              <div className="text-[13px] text-doux">
                {f.telephone ? telephoneLisible(f.telephone) : 'téléphone manquant'} · {f.adresse ?? 'adresse manquante'}
              </div>
              <div className="text-[13px] text-doux">
                Page d’activation : {f.slug_site ? `site de commande · ${f.slug_site}` : 'activation seulement (pas de commande en ligne)'}
              </div>
            </div>
            {admin && (
              <button type="button" className="btn-blanc !min-h-[36px] !px-3 !text-[13px] flex-none" onClick={() => setEdition(f)}>
                Modifier
              </button>
            )}
          </div>
        ))}
      </div>
      {edition && <ModifierFiche fiche={edition} onFermer={() => setEdition(null)} />}
    </>
  );
}

function ModifierFiche({ fiche, onFermer }: { fiche: FichePromo; onFermer: () => void }) {
  const qc = useQueryClient();
  const [telephone, setTelephone] = useState(fiche.telephone ? telephoneLisible(fiche.telephone) : '');
  const [adresse, setAdresse] = useState(fiche.adresse ?? '');
  const [prefixe, setPrefixe] = useState(fiche.prefixe_promo ?? '');
  const [slug, setSlug] = useState(fiche.slug_site ?? '');
  const enregistrer = useMutation({
    mutationFn: () =>
      appelPromo('restaurant_promo_modifier', {
        restaurant_id: fiche.restaurant_id,
        telephone,
        adresse,
        prefixe_promo: prefixe,
        slug_site: slug,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['promo_restaurants'] });
      onFermer();
    },
  });

  return (
    <Fenetre titre={fiche.nom} onFermer={onFermer}>
      <div className="mt-3 space-y-4">
        <label className="block text-sm font-semibold">
          Téléphone imprimé
          <input className="champ mt-1" value={telephone} placeholder="07 77 30 33 33" onChange={(e) => setTelephone(e.target.value)} />
        </label>
        <label className="block text-sm font-semibold">
          Adresse imprimée
          <input className="champ mt-1" value={adresse} maxLength={160} onChange={(e) => setAdresse(e.target.value)} />
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold">
            Préfixe des codes
            <input
              className="champ mt-1 font-mono uppercase"
              value={prefixe}
              maxLength={3}
              disabled={fiche.a_des_lots}
              onChange={(e) => setPrefixe(e.target.value.toUpperCase())}
            />
            <span className="mt-1 block text-[13px] font-normal text-doux">
              {fiche.a_des_lots ? 'Figé : des codes imprimés le portent.' : '3 lettres, sans I ni L.'}
            </span>
          </label>
          <label className="block text-sm font-semibold">
            Identifiant sur le site
            <input className="champ mt-1" value={slug} placeholder="vide = pas de commande en ligne" onChange={(e) => setSlug(e.target.value)} />
          </label>
        </div>
        {enregistrer.error && <Erreur texte={message(enregistrer.error, 'Enregistrement impossible')} />}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-blanc" onClick={onFermer}>Annuler</button>
          <button type="button" className="btn-accent" disabled={enregistrer.isPending} onClick={() => enregistrer.mutate()}>
            {enregistrer.isPending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </Fenetre>
  );
}
