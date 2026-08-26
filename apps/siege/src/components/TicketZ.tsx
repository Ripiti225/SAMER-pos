import {
  formatFCFA,
  libellePartenaire,
  LIBELLES_MODES,
  LIBELLES_TYPES_COMMANDE,
  type ModePaiement,
  type RapportZ,
  type TypeCommande,
} from '@pos/shared';
import { dateHeure } from '../periode';
import { EquipeService } from './EquipeService';

/** Seuil d'alerte du POS (`parametres_locaux.seuil_alerte_ecart_caisse`). */
const SEUIL_ECART = 2000;

/**
 * Un rapport Z est FIGÉ à la clôture : celui d'il y a six mois a la forme
 * qu'avait le POS ce jour-là. Chaque champ se lit donc en optionnel.
 *
 * **Règle de cet écran : rien ne disparaît.** Tous les champs sont rendus, les
 * ZÉROS COMPRIS — un mode de paiement à 0 F est une information (personne n'a
 * payé par Wave ce jour-là), pas du bruit à filtrer. Les valeurs nulles passent
 * simplement en gris pâle : l'œil les saute, elles restent lisibles. Ce que la
 * console ne sait pas nommer tombe dans « Autres valeurs », et le ticket brut
 * reste dépliable en bas.
 */
export type RapportZLu = Partial<RapportZ> & Record<string, unknown>;

/** Champs rendus par les blocs ci-dessous. Le reste tombe dans « Autres valeurs ». */
const CONNUS = new Set([
  'service_id', 'caissier', 'ouvert_le', 'cloture_le',
  'fond_de_caisse', 'especes_comptees', 'especes_theorique', 'ecart',
  'nb_commandes_payees', 'nb_commandes_annulees', 'total_ventes', 'total_remises',
  'total_promos', 'total_fidelite', 'panier_moyen',
  'par_mode', 'par_type', 'partenaires', 'top_articles',
  'remises_detail', 'annulations_detail',
  'depenses', 'livraisons', 'offerts', 'modes_declares',
  'vente_totale', 'total_systeme', 'diff',
  'inventaire', 'equipe', 'retours',
]);

const nb = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Une ligne libellé → valeur. Une valeur nulle se met en retrait, jamais masquée. */
function Ligne({ libelle, valeur, zero, fort }: { libelle: string; valeur: string; zero?: boolean; fort?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1 ${fort ? 'font-bold' : ''}`}>
      <span className={zero ? 'text-faible' : fort ? '' : 'text-doux'}>{libelle}</span>
      <span className={`chiffres whitespace-nowrap ${zero ? 'text-faible' : ''}`}>{valeur}</span>
    </div>
  );
}

/** Ligne d'un montant : `zero` se déduit tout seul, on ne l'oublie donc jamais. */
function LigneF({ libelle, montant, fort }: { libelle: string; montant: number; fort?: boolean }) {
  return <Ligne libelle={libelle} valeur={formatFCFA(montant)} zero={montant === 0 && !fort} fort={fort} />;
}

function Bloc({ titre, children, large }: { titre: string; children: React.ReactNode; large?: boolean }) {
  return (
    <section className={`rounded-jeton border border-filet bg-carte p-4 ${large ? 'lg:col-span-2' : ''}`}>
      <h3 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">{titre}</h3>
      <div className="text-sm">{children}</div>
    </section>
  );
}

export function TicketZ({
  rapport,
  restaurant,
  serviceId,
  restaurantId,
}: {
  rapport: RapportZLu;
  restaurant: string;
  serviceId: string;
  restaurantId: string;
}) {
  const ecart = nb(rapport.ecart);
  const graveEcart = Math.abs(ecart) > SEUIL_ECART;

  const livraisons = (rapport.livraisons ?? {}) as Record<string, number>;
  const declares = (rapport.modes_declares ?? {}) as Record<string, number>;
  const parMode = (rapport.par_mode ?? {}) as Record<string, number>;
  const parType = (rapport.par_type ?? {}) as Record<string, { nb: number; total: number }>;
  const partenaires = (rapport.partenaires ?? {}) as Record<
    string,
    { nb: number; total: number; contacts?: number; refs?: number }
  >;
  const top = (rapport.top_articles ?? []) as { nom: string; quantite: number; total: number }[];
  const remises = (rapport.remises_detail ?? []) as
    { numero_ticket: number; montant: number; motif: string | null; par_nom: string | null }[];
  const annulations = (rapport.annulations_detail ?? []) as { numero_ticket: number; total: number }[];
  const retours = rapport.retours;
  const retoursDetail = retours?.detail ?? [];
  const retoursParProduit = retours?.par_produit ?? [];
  const inventaire = rapport.inventaire;
  const equipe = rapport.equipe;
  const offerts = rapport.offerts;

  const autres = Object.entries(rapport).filter(([k]) => !CONNUS.has(k));

  return (
    <div className="space-y-4">
      <header className="text-center">
        <h2 className="text-xl font-bold">Ticket Z — {restaurant}</h2>
        <p className="text-sm text-doux">
          {String(rapport.caissier ?? 'Caissier inconnu')} · ouvert {dateHeure(String(rapport.ouvert_le ?? ''))} →
          clôturé {dateHeure(String(rapport.cloture_le ?? ''))}
        </p>
      </header>

      {/* L'écart de caisse : le chiffre qu'on vient chercher, en très grand. Le
          seuil est celui du POS — c'est lui qui a déclenché (ou non) l'entrée
          d'audit ECART_CAISSE sur le site, la console n'en invente pas un autre. */}
      <div className={`rounded-jeton p-4 text-center ${graveEcart ? 'bg-alerte-tint text-alerte-txt' : 'bg-ok-tint text-ok-txt'}`}>
        <div className="text-sm font-semibold">Écart de caisse (espèces)</div>
        <div className="chiffres text-4xl font-black">
          {ecart > 0 ? '+' : ''}
          {formatFCFA(ecart)}
        </div>
        <div className="chiffres mt-1 text-xs opacity-80">
          Comptées {formatFCFA(nb(rapport.especes_comptees))} · Théoriques {formatFCFA(nb(rapport.especes_theorique))}
          {graveEcart ? ` · au-delà du seuil d’alerte de ${formatFCFA(SEUIL_ECART)}` : ''}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Mêmes lignes, même ordre que le ticket imprimé sur le site : un
            manager doit retrouver son papier, pas déchiffrer une autre mise en page. */}
        <Bloc titre="Réconciliation de fermeture">
          <LigneF libelle="Fond de caisse" montant={nb(rapport.fond_de_caisse)} />
          <LigneF libelle="Dépenses" montant={nb(rapport.depenses)} />
          {Object.entries(livraisons).map(([p, v]) => (
            <LigneF key={p} libelle={libellePartenaire(p)} montant={nb(v)} />
          ))}
          {Object.entries(declares).map(([m, v]) => (
            <LigneF key={m} libelle={`${LIBELLES_MODES[m as ModePaiement] ?? m} (déclaré)`} montant={nb(v)} />
          ))}
          <LigneF libelle={`Kdo offerts (${nb(offerts?.nb)})`} montant={nb(offerts?.total)} />
          <div className="my-1 border-t border-filet" />
          <LigneF libelle="Vente totale (réconciliée)" montant={nb(rapport.vente_totale)} fort />
          <LigneF libelle="Total système" montant={nb(rapport.total_systeme)} />
          <div className={`flex items-baseline justify-between gap-4 py-1 font-bold ${nb(rapport.diff) < 0 ? 'text-alerte-txt' : 'text-ok-txt'}`}>
            <span>Écart réconciliation</span>
            <span className="chiffres whitespace-nowrap">
              {nb(rapport.diff) > 0 ? '+' : ''}
              {formatFCFA(nb(rapport.diff))}
            </span>
          </div>
        </Bloc>

        <Bloc titre="Ventes du service">
          <Ligne libelle="Commandes payées" valeur={nb(rapport.nb_commandes_payees).toLocaleString('fr-FR')} zero={nb(rapport.nb_commandes_payees) === 0} />
          <LigneF libelle="Panier moyen" montant={nb(rapport.panier_moyen)} />
          <LigneF libelle="Total des ventes" montant={nb(rapport.total_ventes)} fort />
          <div className="my-1 border-t border-filet" />
          <LigneF libelle="Remises" montant={nb(rapport.total_remises)} />
          <LigneF libelle="Promotions automatiques" montant={nb(rapport.total_promos)} />
          <LigneF libelle="Fidélité" montant={nb(rapport.total_fidelite)} />
          <Ligne libelle="Commandes annulées" valeur={nb(rapport.nb_commandes_annulees).toLocaleString('fr-FR')} zero={nb(rapport.nb_commandes_annulees) === 0} />
        </Bloc>

        {/* TOUS les modes, zéros compris : « personne n'a payé par Wave » est une
            information, et une ligne manquante ferait douter de la lecture. */}
        <Bloc titre="Encaissements par mode">
          {Object.keys(parMode).length === 0 ? (
            <p className="text-faible">Le ticket ne porte pas ce détail.</p>
          ) : (
            Object.entries(parMode)
              .sort(([, a], [, b]) => nb(b) - nb(a))
              .map(([m, v]) => <LigneF key={m} libelle={LIBELLES_MODES[m as ModePaiement] ?? m} montant={nb(v)} />)
          )}
        </Bloc>

        <Bloc titre="Par type de commande">
          {Object.keys(parType).length === 0 ? (
            <p className="text-faible">Le ticket ne porte pas ce détail.</p>
          ) : (
            Object.entries(parType)
              .sort(([, a], [, b]) => nb(b?.total) - nb(a?.total))
              .map(([t, v]) => (
                <LigneF
                  key={t}
                  libelle={`${LIBELLES_TYPES_COMMANDE[t as TypeCommande] ?? t} (${nb(v?.nb)})`}
                  montant={nb(v?.total)}
                />
              ))
          )}
          {Object.keys(partenaires).length > 0 && (
            <>
              <div className="my-1 border-t border-filet" />
              {Object.entries(partenaires).map(([p, v]) => (
                <div key={p}>
                  <LigneF libelle={`${libellePartenaire(p)} (${nb(v?.nb)})`} montant={nb(v?.total)} />
                  {/* Contacts recueillis : l'écart avec le nombre de courses est
                      le nombre de livraisons qu'on ne saura rattacher à personne.
                      Absent des rapports Z figés avant le 2026-08-25 — d'où le
                      libellé « non suivi » plutôt qu'un 0 trompeur. */}
                  <div className="-mt-0.5 pl-3 text-[12px] text-faible">
                    {v?.contacts === undefined ? (
                      'contacts non suivis à cette date'
                    ) : (
                      <>
                        <span className={nb(v.contacts) < nb(v?.nb) ? 'text-attente-txt' : 'text-ok-txt'}>
                          {nb(v.contacts)}/{nb(v?.nb)} contact(s)
                        </span>
                        {' · '}
                        {nb(v?.refs)}/{nb(v?.nb)} n° partenaire
                      </>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </Bloc>

        {top.length > 0 && (
          <Bloc titre={`Top articles (${top.length})`} large>
            <div className="grid gap-x-8 sm:grid-cols-2">
              {top.map((a) => (
                <div key={a.nom} className="flex items-baseline justify-between gap-3 border-b border-filet py-1.5 last:border-0">
                  <span className="truncate">
                    <span className="chiffres font-semibold">{a.quantite}</span> × {a.nom}
                  </span>
                  <span className="chiffres whitespace-nowrap text-doux">{formatFCFA(a.total)}</span>
                </div>
              ))}
            </div>
          </Bloc>
        )}

        {/* Inventaire et Retours : INFORMATION MANAGER. Ni l'un ni l'autre ne
            touche la vente ou l'écart de caisse — la console le redit, comme le
            ticket du site, pour qu'on ne les prenne pas pour une retenue. */}
        {inventaire && (
          <Bloc titre="Inventaire">
            <div
              className={`mb-2 rounded-sm px-2 py-1 text-center text-sm font-bold ${
                nb(inventaire.montant_manquant) > 0 ? 'bg-attente-tint text-attente-txt' : 'bg-ok-tint text-ok-txt'
              }`}
            >
              {nb(inventaire.manquants) === 0 ? 'Conforme' : `${nb(inventaire.manquants)} manquant${nb(inventaire.manquants) > 1 ? 's' : ''}`}
            </div>
            <Ligne libelle="Validé" valeur={inventaire.valide ? 'oui' : 'non'} zero={!inventaire.valide} />
            <Ligne libelle="Débloqué par un manager" valeur={inventaire.debloque ? 'oui' : 'non'} zero={!inventaire.debloque} />
            <Ligne libelle="Manquants" valeur={String(nb(inventaire.manquants))} zero={nb(inventaire.manquants) === 0} />
            <Ligne libelle="Surplus" valeur={String(nb(inventaire.surplus))} zero={nb(inventaire.surplus) === 0} />
            <LigneF libelle="Montant manquant" montant={nb(inventaire.montant_manquant)} />
            <p className="mt-1.5 text-xs text-faible">
              {inventaire.debloque && !inventaire.valide ? 'Clôture passée sans comptage complet. ' : ''}
              Information manager — sans effet sur la vente ni sur l’écart de caisse.
            </p>
          </Bloc>
        )}

        {retours && (
          <Bloc titre="Retours">
            <div className="mb-1.5 flex items-baseline justify-between gap-4 font-semibold">
              <span className={nb(retours.nb) === 0 ? 'text-faible' : ''}>
                {nb(retours.nb)} article{nb(retours.nb) > 1 ? 's' : ''} refait{nb(retours.nb) > 1 ? 's' : ''}
              </span>
              <span className={`chiffres ${nb(retours.montant) === 0 ? 'text-faible' : ''}`}>{formatFCFA(nb(retours.montant))}</span>
            </div>
            {retoursParProduit.map((p) => (
              <div key={p.nom} className="flex justify-between gap-3 text-xs text-doux">
                <span className="truncate">
                  {p.quantite} × {p.nom}
                </span>
                <span className="chiffres whitespace-nowrap">{formatFCFA(p.montant)}</span>
              </div>
            ))}
            {retoursDetail.length > 0 && (
              <div className="mt-2 border-t border-filet pt-2">
                {retoursDetail.map((d, i) => (
                  <div key={`${d.numero_ticket}-${d.nom}-${i}`} className="flex justify-between gap-3 py-0.5 text-xs">
                    <span className="min-w-0 truncate text-doux">
                      <span className="chiffres font-semibold">#{d.numero_ticket}</span> {d.quantite} × {d.nom}
                      {d.motif && <span className="text-faible"> · {d.motif}</span>}
                      {d.par_nom && <span className="text-faible"> · {d.par_nom}</span>}
                    </span>
                    <span className="chiffres whitespace-nowrap text-doux">{formatFCFA(d.montant)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-1.5 text-xs text-faible">
              Plats lancés en cuisine puis annulés au PIN manager — hors vente et hors tiroir. C’est le chiffre qui
              dit si un restaurant refait souvent ses plats.
            </p>
          </Bloc>
        )}

        <Bloc titre={`Remises (${remises.length})`}>
          {remises.length === 0 ? (
            <p className="text-faible">Aucune remise sur ce service.</p>
          ) : (
            remises.map((r, i) => (
              <div key={`${r.numero_ticket}-${i}`} className="flex items-baseline justify-between gap-3 border-b border-filet py-1.5 last:border-0">
                <span className="min-w-0 truncate">
                  <span className="chiffres font-semibold">#{r.numero_ticket}</span>{' '}
                  <span className="text-doux">{r.motif ?? 'sans motif'}</span>
                  {r.par_nom && <span className="text-faible"> · {r.par_nom}</span>}
                </span>
                <span className="chiffres whitespace-nowrap">{formatFCFA(r.montant)}</span>
              </div>
            ))
          )}
        </Bloc>

        {/* Le montant est TOUJOURS écrit, 0 F compris : « annulée sans un franc
            dessus » et « annulée alors qu'il y avait de l'argent » ne doivent pas
            se ressembler. Au-delà de 0, il passe en alerte — c'est une vente qui
            a disparu, elle se regarde. */}
        <Bloc titre={`Commandes annulées (${annulations.length})`}>
          {annulations.length === 0 ? (
            <p className="text-faible">Aucune annulation sur ce service.</p>
          ) : (
            <div className="space-y-1">
              {annulations.map((a, i) => (
                <div key={`${a.numero_ticket}-${i}`} className="flex items-baseline justify-between gap-3 border-b border-filet py-1.5 last:border-0">
                  <span className="chiffres font-semibold">Ticket #{a.numero_ticket}</span>
                  <span className={`chiffres whitespace-nowrap font-semibold ${a.total > 0 ? 'rounded-sm bg-alerte-tint px-2 py-0.5 text-alerte-txt' : 'text-faible'}`}>
                    {formatFCFA(a.total)}
                  </span>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-3 pt-1 font-bold">
                <span>Total annulé</span>
                <span className={`chiffres ${annulations.reduce((t, a) => t + nb(a.total), 0) > 0 ? 'text-alerte-txt' : 'text-faible'}`}>
                  {formatFCFA(annulations.reduce((t, a) => t + nb(a.total), 0))}
                </span>
              </div>
            </div>
          )}
        </Bloc>

        {/* Les trois compteurs du ticket figé, PUIS la liste nominative lue
            dans `equipe_service`. On garde les compteurs : ils sont ce que le
            ticket du site portait, et un écart avec la liste se verrait. */}
        <Bloc titre="Équipe du service" large>
          {equipe && (
            <div className="mb-3 flex flex-wrap gap-4">
              <Ligne libelle="Présents" valeur={String(nb(equipe.presents))} zero={nb(equipe.presents) === 0} />
              <Ligne libelle="Restent" valeur={String(nb(equipe.restent))} zero={nb(equipe.restent) === 0} />
              <Ligne libelle="Partis" valeur={String(nb(equipe.partis))} zero={nb(equipe.partis) === 0} />
            </div>
          )}
          <EquipeService
            serviceId={serviceId}
            restaurantId={restaurantId}
            clotureLe={(rapport.cloture_le as string | undefined) ?? null}
          />
        </Bloc>

        {/* Filet de sécurité : un ticket plus récent que cette console garde ses
            champs visibles, en clair, au lieu de disparaître de l'écran. */}
        {autres.length > 0 && (
          <Bloc titre="Autres valeurs du ticket" large>
            {autres.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-filet py-1.5 last:border-0">
                <span className="text-doux">{k}</span>
                <span className="chiffres max-w-[60%] break-all text-right">
                  {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
                </span>
              </div>
            ))}
          </Bloc>
        )}
      </div>

      <p className="text-center text-xs text-faible">
        Service <span className="chiffres">{String(rapport.service_id ?? '—')}</span>
      </p>

      {/* Le ticket brut, replié : la mise en forme ne doit jamais empêcher de
          vérifier la source, ni d'en copier une valeur. */}
      <details className="rounded-jeton border border-filet bg-carte-douce p-3 text-sm">
        <summary className="cursor-pointer font-semibold text-doux">Voir le ticket brut (JSON)</summary>
        <pre className="chiffres mt-2 overflow-x-auto text-[12px] leading-relaxed text-txt">
          {JSON.stringify(rapport, null, 2)}
        </pre>
      </details>
    </div>
  );
}
