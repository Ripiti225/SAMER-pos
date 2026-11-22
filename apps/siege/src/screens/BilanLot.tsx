import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconChevronLeft, IconDownload } from '@tabler/icons-react';
import { formatFCFA } from '@pos/shared';
import { appelPromo, ErreurSiege, type BilanLot as Bilan, type CommandeConflit, type LotPromo } from '../api';
import { Erreur, Info, Squelette } from '../components/Etat';
import {
  CANAUX_BILAN,
  csvBilan,
  delaiLisible,
  etatLot,
  proportion,
  jourHeure,
  jourMois,
  jourMoisAn,
  LIBELLES_ETAT,
  part,
  precisionEtat,
} from '../promo';
import { nomFichier, telechargerCsv } from '../telechargement';

const message = (e: unknown, defaut: string) => (e instanceof ErreurSiege ? e.message : defaut);

/**
 * Bilan d'un lot (PROMO-13, maquette validée le 21/11/2026) : du sac au
 * passage en caisse, l'argent, le jour par jour, les canaux et les codes
 * encaissés deux fois. Aucun numéro de client n'y figure.
 */
export function BilanLot({
  lot,
  admin,
  nomResto,
  onRetour,
}: {
  lot: LotPromo;
  admin: boolean;
  nomResto: string;
  onRetour: () => void;
}) {
  const maintenant = new Date();
  const { data, isPending, error } = useQuery({
    queryKey: ['promo_lot_bilan', lot.restaurant_id, lot.id],
    queryFn: () => appelPromo<{ bilan: Bilan }>('lot_bilan', { restaurant_id: lot.restaurant_id, lot_id: lot.id }),
    staleTime: 30_000,
  });
  const etat = etatLot(lot, maintenant);

  return (
    <div className="flex flex-col gap-5">
      <button type="button" onClick={onRetour} className="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-marque-sur-plan">
        <IconChevronLeft size={16} /> Tous les lots
      </button>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-[24px] font-bold">{lot.libelle}</h2>
          <div className="flex flex-wrap items-center gap-2.5 text-sm text-doux">
            <span>
              {nomResto} · −{lot.pourcentage} % · du {jourMois(lot.valide_du)} au {jourMoisAn(lot.valide_au)}
            </span>
            <span className="rounded-full bg-carte-douce px-2.5 py-0.5 text-[13px] font-semibold text-doux">
              {LIBELLES_ETAT[etat]} · {precisionEtat(lot, maintenant)}
            </span>
          </div>
        </div>
        {data && data.bilan.utilisations.length > 0 && (
          <button
            type="button"
            className="btn-blanc"
            onClick={() => telechargerCsv(`lot-${nomFichier(lot.libelle)}-bilan.csv`, csvBilan(data.bilan))}
          >
            <IconDownload size={16} /> Exporter le bilan (CSV)
          </button>
        )}
      </div>

      {error && <Erreur texte={message(error, 'Lecture du bilan impossible')} />}
      {isPending && <Squelette lignes={5} />}
      {data && <Contenu bilan={data.bilan} lot={lot} admin={admin} />}
    </div>
  );
}

function Contenu({ bilan, lot, admin }: { bilan: Bilan; lot: LotPromo; admin: boolean }) {
  const maxJour = Math.max(0, ...bilan.jours.map((j) => Math.max(j.gardes, j.utilises)));
  const maxCanal = Math.max(0, ...bilan.canaux.map((k) => k.utilises));
  return (
    <>
      <section aria-labelledby="bilan-tunnel" className="flex flex-col gap-3.5 rounded-jeton border border-filet bg-carte px-5 py-5 shadow-e1">
        <h3 id="bilan-tunnel" className="text-base font-bold">Du sac au passage en caisse</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Etape libelle="Autocollants imprimés" valeur={String(bilan.imprimes)} largeur="100%" couleur="bg-doux" detail="glissés dans les sacs Glovo / Yango" />
          <Etape
            libelle="Gardés sur un numéro"
            valeur={String(bilan.gardes)}
            precision={part(bilan.gardes, bilan.imprimes)}
            largeur={proportion(bilan.gardes, bilan.imprimes)}
            couleur="bg-marque"
            detail="le client a scanné et donné son numéro"
          />
          <Etape
            libelle="Utilisés"
            valeur={String(bilan.utilises)}
            precision={bilan.gardes ? `${part(bilan.utilises, bilan.gardes)} des gardés` : null}
            largeur={proportion(bilan.utilises, bilan.imprimes)}
            couleur="bg-ok"
            detail={`${part(bilan.utilises, bilan.imprimes) ?? '—'} des imprimés${bilan.reserves ? ` · ${bilan.reserves} réservé${bilan.reserves > 1 ? 's' : ''} en ce moment` : ''}`}
          />
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tuile libelle="CA généré" valeur={formatFCFA(bilan.ca)} detail={`${bilan.commandes} commande${bilan.commandes > 1 ? 's' : ''} avec code`} />
        <Tuile libelle="Remise accordée" valeur={formatFCFA(bilan.remise)} detail={bilan.ca ? `${part(bilan.remise, bilan.ca)} du CA de ces commandes` : '—'} />
        <Tuile libelle="Panier moyen avec code" valeur={bilan.panier_moyen === null ? '—' : formatFCFA(bilan.panier_moyen)} detail="remise déduite" />
        <Tuile libelle="Gardé → utilisé" valeur={delaiLisible(bilan.delai_median_heures)} detail="délai médian" />
      </div>

      <div className="flex flex-wrap gap-4">
        <section aria-labelledby="bilan-jours" className="flex min-w-0 flex-[999_1_560px] flex-col gap-3.5 rounded-jeton border border-filet bg-carte px-5 py-5 shadow-e1">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <h3 id="bilan-jours" className="text-base font-bold">Jour par jour</h3>
            <div className="flex gap-4 text-[13px]">
              <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm bg-marque" />Gardés</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm bg-ok" />Utilisés</span>
            </div>
          </div>
          {bilan.jours.length === 0 ? (
            <Info>Le lot n’a pas encore commencé.</Info>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex gap-2.5">
                {bilan.jours.map((j) => (
                  <div key={j.jour} className="flex min-w-10 flex-1 flex-col items-center gap-1.5">
                    <div className="flex h-40 w-full max-w-16 items-end justify-center gap-[3px] border-b border-filet-fort">
                      <div title={`${j.gardes} gardés`} className="w-[40%] rounded-t-sm bg-marque" style={{ height: proportion(j.gardes, maxJour) }} />
                      <div title={`${j.utilises} utilisés`} className="w-[40%] rounded-t-sm bg-ok" style={{ height: proportion(j.utilises, maxJour) }} />
                    </div>
                    <span className="chiffres text-center text-[12px] leading-tight text-doux">
                      {jourMois(j.jour)}
                      <br />
                      {j.gardes} · {j.utilises}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section aria-labelledby="bilan-canaux" className="flex flex-[1_1_300px] flex-col gap-3.5 rounded-jeton border border-filet bg-carte px-5 py-5 shadow-e1">
          <h3 id="bilan-canaux" className="text-base font-bold">Par canal</h3>
          {bilan.canaux.map((k) => (
            <div key={k.canal} className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-3 text-sm">
                <span className="font-semibold">{CANAUX_BILAN[k.canal]}</span>
                <span className="chiffres whitespace-nowrap">{k.utilises} · {formatFCFA(k.ca)}</span>
              </div>
              <div className="h-2.5 rounded-full bg-carte-douce">
                <div className="h-2.5 rounded-full bg-doux" style={{ width: proportion(k.utilises, maxCanal) }} />
              </div>
            </div>
          ))}
          <p className="text-[13px] leading-relaxed text-doux">« Site » = commande WhatsApp passée sur le site avec le code, encaissée en caisse.</p>
        </section>
      </div>

      {bilan.conflits.length > 0 && <Conflits conflits={bilan.conflits} lot={lot} admin={admin} />}
    </>
  );
}

function Conflits({ conflits, lot, admin }: { conflits: Bilan['conflits']; lot: LotPromo; admin: boolean }) {
  const client = useQueryClient();
  const traiter = useMutation({
    mutationFn: (conflitId: string) => appelPromo('conflit_traiter', { restaurant_id: lot.restaurant_id, conflit_id: conflitId }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['promo_lot_bilan', lot.restaurant_id, lot.id] });
      void client.invalidateQueries({ queryKey: ['promo_lots'] });
    },
  });
  const ouverts = conflits.filter((c) => !c.resolu).length;

  return (
    <section aria-labelledby="bilan-conflits" className={`overflow-hidden rounded-jeton border bg-carte shadow-e1 ${ouverts ? 'border-alerte' : 'border-filet'}`}>
      <div className={`flex flex-col gap-1 px-5 py-4 ${ouverts ? 'bg-alerte-tint' : 'bg-carte-douce'}`}>
        <h3 id="bilan-conflits" className={`text-base font-bold ${ouverts ? 'text-alerte-txt' : ''}`}>
          {ouverts === 0
            ? 'Codes encaissés deux fois : tout est traité'
            : ouverts === 1 ? '1 code encaissé deux fois' : `${ouverts} codes encaissés deux fois`}
        </h3>
        <p className="text-[13px] leading-relaxed">
          Deux caisses l’ont accepté pendant une coupure d’internet. Le premier encaissement compte ; vérifiez le second avec le
          restaurant, puis marquez-le traité.
        </p>
      </div>
      {traiter.error && <div className="px-5 pt-3"><Erreur texte={message(traiter.error, 'Enregistrement impossible')} /></div>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-filet text-[12px] uppercase tracking-wide text-doux">
              <th className="px-4 py-3 font-semibold">Code</th>
              <th className="px-4 py-3 font-semibold">1er encaissement (gardé)</th>
              <th className="px-4 py-3 font-semibold">2e encaissement</th>
              <th className="px-4 py-3 text-right font-semibold">Remise en trop</th>
              <th className="px-4 py-3"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {conflits.map((c) => (
              <tr key={c.id} className={`border-b border-filet last:border-0 ${c.resolu ? 'text-doux' : ''}`}>
                <td className="px-4 py-3.5 font-mono font-semibold">{c.code}</td>
                <td className="px-4 py-3.5"><Commande c={c.a} /></td>
                <td className="px-4 py-3.5"><Commande c={c.b} /></td>
                <td className={`chiffres px-4 py-3.5 text-right font-semibold ${c.resolu ? '' : 'text-alerte-txt'}`}>{formatFCFA(c.remise_en_trop)}</td>
                <td className="px-4 py-3.5 text-right">
                  {c.resolu ? (
                    <span className="rounded-full bg-ok-tint px-2.5 py-0.5 text-[13px] font-semibold text-ok-txt">Traité</span>
                  ) : admin ? (
                    <button
                      type="button"
                      className="btn-blanc !min-h-[36px] !px-3 !text-[13px]"
                      disabled={traiter.isPending}
                      onClick={() => traiter.mutate(c.id)}
                    >
                      Marquer traité
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Une commande d'un conflit ; encore absente du cloud tant que sa caisse n'a pas synchronisé. */
function Commande({ c }: { c: CommandeConflit }) {
  if (c.numero_ticket === null || !c.le) return <span className="text-doux">Pas encore remontée de la caisse</span>;
  return (
    <>
      Ticket n° {c.numero_ticket} · {jourHeure(c.le)}
      <div className="text-[13px] text-doux">
        {[c.canal ? CANAUX_BILAN[c.canal] : null, c.total === null ? null : formatFCFA(c.total), c.caissier].filter(Boolean).join(' · ')}
      </div>
    </>
  );
}

function Etape({
  libelle,
  valeur,
  precision = null,
  largeur,
  couleur,
  detail,
}: {
  libelle: string;
  valeur: string;
  precision?: string | null;
  largeur: string;
  couleur: string;
  detail: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] text-doux">{libelle}</span>
      <span className="chiffres text-[28px] font-bold leading-none">
        {valeur} {precision && <span className="text-base font-semibold text-doux">{precision}</span>}
      </span>
      <div className="h-3 rounded-full bg-carte-douce">
        <div className={`h-3 rounded-full ${couleur}`} style={{ width: largeur }} />
      </div>
      <span className="text-[13px] text-doux">{detail}</span>
    </div>
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
