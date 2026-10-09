import { formatFCFA, LIBELLES_DISPONIBILITE, libellePartenaire, type Disponibilite } from '@pos/shared';
import { nb, type VueBord } from '../bord';
import { TuileChiffre } from './Chiffre';
import { Info } from './Etat';
import { BarresEcarts, BarresEmpilees, BarresHeures, BarresHorizontales, type Serie } from './Graphes';

/** Encart de section : un titre, un sous-titre facultatif, du contenu. */
export function Bloc({ titre, note, children, large }: { titre: string; note?: string; children: React.ReactNode; large?: boolean }) {
  return (
    <section className={`rounded-jeton border border-filet bg-carte p-4 shadow-e1 ${large ? 'xl:col-span-2' : ''}`}>
      <h2 className="text-[12px] font-bold uppercase tracking-wide text-faible">{titre}</h2>
      {note && <p className="mb-2 mt-0.5 text-xs text-faible">{note}</p>}
      <div className={note ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}

/**
 * Les maxima imposés aux graphes.
 *
 * Deux colonnes côte à côte doivent partager leur échelle : sinon chacune se
 * met à la sienne et l'œil conclut l'égalité entre deux chiffres qui n'ont
 * rien à voir. Sur une seule colonne, tout est absent et chaque graphe reprend
 * son échelle automatique.
 */
export interface Maxima {
  jour?: number;
  heures?: number;
  plats?: number;
  modes?: number;
  tables?: number;
  canaux?: number;
  retours?: number;
  depenses?: number;
  ecarts?: number;
  equipe?: number;
}

/** Les six chiffres d'appel — la couche lisible de loin. */
export function TuilesBord({
  vue,
  reference,
  ecartAbsolu,
  sansVariation,
}: {
  vue: VueBord;
  /** La vue d'en face : présente, chaque tuile se compare à ELLE et non plus à
   *  la période précédente. */
  reference?: VueBord;
  ecartAbsolu?: boolean;
  /** La colonne de référence d'une comparaison ne porte aucune flèche : sa
   *  variation contre son propre passé serait une TROISIÈME information dans
   *  le même coup d'œil, en collision avec l'écart entre les deux colonnes. */
  sansVariation?: boolean;
}) {
  const contre = (champ: (v: VueBord) => number, periodePrecedente?: number): number | undefined =>
    sansVariation ? undefined : reference ? champ(reference) : periodePrecedente;
  const absolu = sansVariation ? undefined : ecartAbsolu;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <TuileChiffre libelle="Chiffre d’affaires" valeur={vue.ca} precedent={contre((v) => v.ca, vue.caPrecedent)} ecartAbsolu={absolu} format={formatFCFA} ton="marque" />
      <TuileChiffre libelle="Commandes payées" valeur={vue.commandes} precedent={contre((v) => v.commandes, vue.commandesPrecedent)} ecartAbsolu={absolu} format={(n) => n.toLocaleString('fr-FR')} />
      <TuileChiffre libelle="Panier moyen" valeur={vue.panier} precedent={contre((v) => v.panier)} ecartAbsolu={absolu} format={formatFCFA} />
      <TuileChiffre libelle="Dépenses de caisse" valeur={vue.depenses} precedent={contre((v) => v.depenses)} ecartAbsolu={absolu} format={formatFCFA} ton="alerte" detail="sorties du tiroir" />
      <TuileChiffre libelle="Retours" valeur={vue.retoursMontant} precedent={contre((v) => v.retoursMontant)} ecartAbsolu={absolu} format={formatFCFA} ton="alerte" detail={`${vue.retoursNb} article(s) refait(s)`} />
      <TuileChiffre libelle="Écart réconcilié" valeur={vue.ecartCumule} precedent={contre((v) => v.ecartCumule)} ecartAbsolu={absolu} format={formatFCFA} ton="alerte" detail="cumulé sur la période" />
    </div>
  );
}

/**
 * Tout le tableau de bord SAUF les tuiles et le classement des restaurants :
 * les deux graphes, le détail, l'équipe. Une `VueBord` en entrée, rien
 * d'autre — c'est ce qui permet de rendre la même page deux fois, côte à côte.
 */
export function BlocsBord({
  vue,
  series,
  maxima,
  repartition,
}: {
  vue: VueBord;
  series: Serie[];
  maxima?: Maxima;
  /** Le classement des 7 restaurants, intercalé entre les graphes et le
   *  détail. Il n'appartient à aucune vue : il reste chez l'appelant, qui le
   *  passe déjà rendu. Absent en comparaison, où les deux colonnes sont
   *  filtrées sur un restaurant. */
  repartition?: React.ReactNode;
}) {
  return (
    <>
      {!vue.enrole && (
        <Info>
          <b>Ce site ne synchronise pas encore.</b> Tout est à zéro parce que le cloud ne reçoit rien — pas parce
          que la période a été blanche.
        </Info>
      )}

      {/* ---------- Couche 2 : les deux graphes qui parlent ---------- */}
      <Bloc titre="Chiffre d’affaires, jour par jour" note={series.length > 1 ? 'Une couleur par restaurant ; survolez une journée pour le détail.' : undefined}>
        <BarresEmpilees points={vue.pointsJour} series={series} max={maxima?.jour} />
      </Bloc>

      <Bloc titre="Heures de pic" note="Quand renforcer l’équipe — l’heure de pointe est en aplat plein.">
        <BarresHeures heures={vue.heures} max={maxima?.heures} />
      </Bloc>

      {/* ---------- Couche 3 : comparer les restaurants ---------- */}
      {repartition}

      {/* ---------- Couche 4 : ce que seul le POS possède ---------- */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Bloc titre="Top des plats" note="Libellé figé au moment de la vente — aucun catalogue n’est nécessaire.">
          <BarresHorizontales lignes={vue.plats} max={maxima?.plats} vide="Aucun plat vendu sur cette période." />
        </Bloc>

        <Bloc titre="Modes de paiement" note="Chaque opérateur porte sa couleur, celle de la caisse.">
          <BarresHorizontales lignes={vue.modes} max={maxima?.modes} vide="Aucun encaissement sur cette période." />
        </Bloc>

        <Bloc titre="Tables les plus utilisées">
          <BarresHorizontales lignes={vue.tables} max={maxima?.tables} vide="Aucune commande sur table." />
        </Bloc>

        <Bloc titre="Canaux de vente" note="Sur place, à emporter, et le détail par partenaire de livraison.">
          <BarresHorizontales lignes={vue.canaux} max={maxima?.canaux} vide="Aucune commande sur cette période." />
        </Bloc>

        <Bloc titre="Retours" note="Plats lancés en cuisine puis annulés — hors vente et hors tiroir. C’est le chiffre qui dit si un restaurant refait souvent ses plats.">
          <BarresHorizontales
            lignes={vue.retours}
            max={maxima?.retours}
            couleur="var(--attente)"
            vide="Aucun retour — rien n’a été refait."
          />
        </Bloc>

        <Bloc titre="Écarts réconciliés par caissier" note="Après correction des modes de paiement ; le détail espèces reste dans chaque ticket Z.">
          <BarresEcarts lignes={vue.ecarts} max={maxima?.ecarts} />
        </Bloc>

        <Bloc titre="Dépenses par catégorie" note="Sorties de caisse uniquement — ni loyer, ni facture payée hors caisse. Jamais soustraites du chiffre d’affaires.">
          <BarresHorizontales
            lignes={vue.depensesCategories}
            max={maxima?.depenses}
            couleur="var(--alerte)"
            vide="Aucune dépense enregistrée."
          />
        </Bloc>

        <Bloc titre="Remises et annulations">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <p className="chiffres text-2xl font-bold">{formatFCFA(vue.remises.reduce((s, r) => s + nb(r.montant), 0))}</p>
              <p className="text-xs text-doux">{vue.remises.length} remise(s) accordée(s)</p>
              <div className="mt-1.5 space-y-0.5">
                {vue.remises.slice(0, 4).map((r) => (
                  <div key={`${r.restaurant_id}-${r.numero_ticket}`} className="flex justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-doux">
                      <span className="chiffres font-semibold">#{r.numero_ticket}</span> {r.motif ?? 'sans motif'}
                    </span>
                    <span className="chiffres flex-none">{formatFCFA(nb(r.montant))}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="chiffres text-2xl font-bold">{vue.annulations.length}</p>
              <p className="text-xs text-doux">
                commande(s) annulée(s) ·{' '}
                {formatFCFA(vue.annulations.reduce((s, a) => s + nb(a.total), 0))}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {vue.annulations.slice(0, 8).map((a) => (
                  <span key={`${a.restaurant_id}-${a.numero_ticket}`} className="chiffres rounded-sm bg-carte-douce px-1.5 py-0.5 text-[11px] font-semibold">
                    #{a.numero_ticket}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </Bloc>

        {/* Livraisons partenaires par caissier. Le chiffre qui compte n'est
            pas le CA — il est déjà dans « Canaux de vente » — mais l'écart
            entre les courses et les contacts recueillis : chaque unité
            manquante est une livraison qu'on ne saura rattacher à personne
            si le client se plaint ou si le partenaire conteste. */}
        <Bloc
          titre="Livraisons partenaires par caissier"
          note="Contact = téléphone du client, demandé au lancement en cuisine. Ce qui manque ici ne se rattrape plus."
          large
        >
          {vue.livraisons.length === 0 ? (
            <p className="py-4 text-center text-faible">Aucune livraison partenaire sur cette période.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-filet text-[11px] uppercase tracking-wide text-faible">
                    <th className="py-1.5 pr-3 font-semibold">Caissier</th>
                    {vue.restaurantId === null && <th className="py-1.5 pr-3 font-semibold">Restaurant</th>}
                    <th className="py-1.5 pr-3 font-semibold">Partenaire</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Commandes</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">Contacts</th>
                    <th className="py-1.5 pr-3 text-right font-semibold">N° partenaire</th>
                    <th className="py-1.5 text-right font-semibold">CA</th>
                  </tr>
                </thead>
                <tbody>
                  {vue.livraisons.map((l) => {
                    const manquants = nb(l.nb) - nb(l.contacts);
                    return (
                      <tr key={`${l.restaurant_id}:${l.caissier}:${l.partenaire}`} className="border-b border-filet last:border-0">
                        <td className="py-1.5 pr-3 font-semibold">{l.caissier}</td>
                        {vue.restaurantId === null && <td className="py-1.5 pr-3 text-doux">{vue.noms.get(l.restaurant_id) ?? ''}</td>}
                        <td className="py-1.5 pr-3">{libellePartenaire(l.partenaire)}</td>
                        <td className="chiffres py-1.5 pr-3 text-right">{nb(l.nb)}</td>
                        <td className={`chiffres py-1.5 pr-3 text-right font-semibold ${manquants > 0 ? 'text-attente-txt' : 'text-ok-txt'}`}>
                          {nb(l.contacts)}
                          {manquants > 0 && <span className="ml-1 text-[11px] font-normal">(−{manquants})</span>}
                        </td>
                        <td className="chiffres py-1.5 pr-3 text-right text-doux">{nb(l.refs)}</td>
                        <td className="chiffres py-1.5 text-right">{formatFCFA(nb(l.ca))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-doux">
                <b className="chiffres">{vue.totalLivraisons.contacts}</b> contact(s) recueilli(s) sur{' '}
                <b className="chiffres">{vue.totalLivraisons.nb}</b> course(s) —{' '}
                <b className="chiffres text-attente-txt">{vue.totalLivraisons.nb - vue.totalLivraisons.contacts}</b> sans
                moyen de rappeler le client.
              </p>
            </div>
          )}
        </Bloc>

        <Bloc titre="Inventaire" note="Information manager — sans effet sur la vente ni sur l’écart de caisse.">
          {vue.inventaire.length === 0 ? (
            <p className="py-4 text-center text-faible">Aucun inventaire validé sur cette période.</p>
          ) : (
            <div className="space-y-1.5">
              {vue.inventaire.map((i) => (
                <div key={i.restaurant_id} className="flex items-baseline justify-between gap-3 border-b border-filet py-1.5 text-sm last:border-0">
                  <span className="truncate font-semibold">{vue.noms.get(i.restaurant_id) ?? 'Site'}</span>
                  <span className="flex-none">
                    <span className={`chiffres font-semibold ${nb(i.montant_manquant) > 0 ? 'text-attente-txt' : 'text-ok-txt'}`}>
                      {formatFCFA(nb(i.montant_manquant))}
                    </span>
                    <span className="ml-2 text-xs text-faible">
                      {nb(i.nb_inventaires)} comptage(s)
                      {nb(i.nb_debloques) > 0 ? ` · ${nb(i.nb_debloques)} débloqué(s)` : ''}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Bloc>
      </div>

      {/* ---------- Couche 5 : l'équipe ---------- */}
      <Bloc titre="Équipe" note="Arrivée = l’heure du clic sur « Pointer ». Fin = heure de paie pour qui est payé à la journée, heure de clôture sinon.">
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <p className="chiffres text-2xl font-bold">{vue.personnes}</p>
            <p className="text-xs text-doux">personne(s) en poste sur la période</p>
          </div>
          <div>
            <p className="chiffres text-2xl font-bold">{Math.round(vue.heuresTravaillees)} h</p>
            <p className="text-xs text-doux">travaillées au total</p>
          </div>
          <div>
            <p className="chiffres text-2xl font-bold">{formatFCFA(vue.salaires)}</p>
            <p className="text-xs text-doux">de salaires payés en caisse</p>
          </div>
        </div>

        <BarresHorizontales
          lignes={vue.equipe}
          max={maxima?.equipe}
          format={(n) => `${n} h`}
          vide="Personne n’a pointé sur cette période."
        />

        {vue.absents.length > 0 && (
          <div className="mt-3 border-t border-filet pt-3">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-faible">
              Absents aujourd’hui
              <span className="ml-2 font-normal normal-case tracking-normal">
                état du jour, pas un historique
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {vue.absents.map((a) => (
                <span key={a.id} className="rounded-sm bg-info-tint px-2 py-1 text-xs font-semibold text-info-txt">
                  {a.nom_complet} — {LIBELLES_DISPONIBILITE[a.disponibilite as Disponibilite] ?? a.disponibilite}
                  {vue.restaurantId === null && vue.noms.get(a.restaurant_id) ? ` · ${vue.noms.get(a.restaurant_id)}` : ''}
                </span>
              ))}
            </div>
          </div>
        )}
      </Bloc>
    </>
  );
}
