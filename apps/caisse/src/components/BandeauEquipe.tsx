/**
 * Bandeau d'équipe de l'accueil (DESIGN_V2 § 6.7).
 *
 * L'équipe est fixée à l'ouverture du service, mais les retards existent : ce
 * bandeau permet de pointer une arrivée en cours de service. **L'heure du clic
 * fait foi** — elle est datée par le serveur, jamais saisie.
 *
 * REPLIÉ PAR DÉFAUT : déplié, avec 15 personnes, la grille occuperait quatre
 * rangées et repousserait les six tuiles hors de l'écran. Replié, la barre reste
 * informative (avatars empilés + compteurs) et « Pointer une arrivée » est
 * accessible sans déplier. Déplié, les fiches tiennent sur UNE seule ligne de
 * quatre qu'on fait défiler : la hauteur du bandeau ne bouge jamais, que
 * l'équipe compte 4 personnes ou 40.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconChevronDown, IconChevronLeft, IconChevronRight, IconUserPlus } from '@tabler/icons-react';
import { api } from '../api';
import { Modale } from './Modale';
import { useAffichage } from '../stores/affichage';
import { useCaisse } from '../stores/session';

export interface MembrePointage {
  id: string;
  utilisateur_id: string;
  nom_complet: string;
  photo_url: string | null;
  poste_jour: string;
  pointe_le: string | null;
  attendu: boolean;
  fin_prevue: string | null;
  minutes_faites: number;
  heures_faites: boolean;
  reste: boolean | null;
  salaire_paye: boolean;
}

export interface VuePointage {
  service_id: string;
  duree_service_heures: number;
  presents: number;
  attendus: number;
  ont_fait_leurs_heures: number;
  membres: MembrePointage[];
}

interface EmployePropose {
  utilisateur_id: string;
  nom_complet: string;
  poste_defaut: string;
}

/** Palette d'avatars — stable par personne (même couleur d'un service à l'autre). */
const COULEURS = ['#e2445c', '#3b82f6', '#14b8a6', '#8b5cf6', '#d97706', '#0ea5e9', '#16a34a'];
function couleurDe(id: string): string {
  let somme = 0;
  for (const c of id) somme = (somme + c.charCodeAt(0)) % 997;
  return COULEURS[somme % COULEURS.length]!;
}

export function initiales(nom: string): string {
  return nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0]!.toUpperCase()).join('');
}

const hhmm = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';

function enHeures(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

export function BandeauEquipe() {
  const { session, afficherToast } = useCaisse();
  const deplie = useAffichage((e) => e.bandeauEquipeDeplie);
  const poserDeplie = useAffichage((e) => e.poserBandeauEquipeDeplie);
  const [pointer, setPointer] = useState(false);
  const liste = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  const peutPointer = !!session?.permissions.includes('caisse.service.ouvrir');
  const { data } = useQuery({
    queryKey: ['pointage'],
    queryFn: () => api<VuePointage>('/api/pointage'),
    enabled: peutPointer && !!session?.service_ouvert,
    refetchInterval: 60_000, // les jauges avancent toutes seules
  });

  if (!data) return null;
  const membres = data.membres;
  const VISIBLES = 5;

  const faire = (dx: number) => liste.current?.scrollBy({ left: dx, behavior: 'smooth' });

  return (
    <section className="w-full max-w-5xl overflow-hidden rounded-2xl border border-vitrine-bordure bg-vitrine-surface shadow-e1">
      <div className={`flex items-center justify-between gap-3 px-4 py-3 ${deplie ? 'border-b border-vitrine-bordure' : ''}`}>
        {/* Toute la barre est la zone de pli : une flèche seule serait une cible
            trop fine sur écran tactile. */}
        <button
          type="button"
          onClick={() => poserDeplie(!deplie)}
          className="flex flex-1 items-center gap-3 rounded-btn px-1 py-1 text-left transition hover:bg-vitrine-surface-2"
        >
          <span className="flex flex-none items-center">
            {membres.slice(0, VISIBLES).map((m, i) => (
              <span
                key={m.utilisateur_id}
                title={m.nom_complet}
                className="flex h-8 w-8 flex-none items-center justify-center rounded-full border-2 border-vitrine-surface text-[11px] font-bold"
                style={{
                  marginLeft: i === 0 ? 0 : -10,
                  color: couleurDe(m.utilisateur_id),
                  background: `color-mix(in srgb, ${couleurDe(m.utilisateur_id)} 20%, var(--vitrine-surface))`,
                }}
              >
                {initiales(m.nom_complet)}
              </span>
            ))}
            {membres.length > VISIBLES && (
              <span
                className="flex h-8 w-8 flex-none items-center justify-center rounded-full border-2 border-vitrine-surface bg-vitrine-surface-2 text-[11px] font-bold text-vitrine-txt-doux"
                style={{ marginLeft: -10 }}
              >
                +{membres.length - VISIBLES}
              </span>
            )}
          </span>

          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px] font-semibold text-vitrine-txt">
            <span>{data.presents} présent{data.presents > 1 ? 's' : ''}</span>
            <span className="flex items-center gap-2 text-ok">
              <span className="h-2 w-2 rounded-full bg-ok" />
              {data.ont_fait_leurs_heures} ont fait leurs {data.duree_service_heures} h
            </span>
            {data.presents - data.ont_fait_leurs_heures > 0 && (
              <span className="flex items-center gap-2 text-alerte">
                <span className="h-2 w-2 rounded-full bg-alerte" />
                {data.presents - data.ont_fait_leurs_heures} pas encore
              </span>
            )}
            {data.attendus > 0 && (
              <span className="font-medium text-vitrine-txt-doux">
                {data.attendus} attendu{data.attendus > 1 ? 's' : ''}
              </span>
            )}
          </span>

          <IconChevronDown
            size={20}
            className={`ml-auto flex-none text-vitrine-txt-faible transition-transform duration-200 ${deplie ? 'rotate-180' : ''}`}
          />
        </button>

        {peutPointer && (
          <button
            type="button"
            onClick={() => setPointer(true)}
            className="flex flex-none items-center gap-2 rounded-btn border border-vitrine-bordure bg-vitrine-surface-2 px-3 py-2 text-[13.5px] font-semibold text-vitrine-txt transition hover:bg-vitrine-bordure/50"
          >
            <IconUserPlus size={17} />
            Pointer une arrivée
          </button>
        )}
      </div>

      {deplie && (
        <div className="flex items-center gap-2 p-3">
          <FlecheDefilement direction="gauche" onClick={() => faire(-320)} />
          <div
            ref={liste}
            className="grid min-w-0 flex-1 snap-x snap-mandatory grid-flow-col gap-2.5 overflow-x-auto p-0.5 [grid-auto-columns:calc((100%-3*10px)/4)] [scrollbar-width:none]"
          >
            {membres.map((m) => (
              <FicheAgent key={m.utilisateur_id} membre={m} duree={data.duree_service_heures} />
            ))}
          </div>
          <FlecheDefilement direction="droite" onClick={() => faire(320)} />
        </div>
      )}

      {pointer && (
        <ModalePointer
          duree={data.duree_service_heures}
          dejaPresents={membres.filter((m) => !m.attendu).map((m) => m.utilisateur_id)}
          onFermer={() => setPointer(false)}
          onPointe={() => {
            setPointer(false);
            // Pointer quelqu'un déplie : on doit voir le résultat de son geste.
            poserDeplie(true);
            void queryClient.invalidateQueries({ queryKey: ['pointage'] });
          }}
          onErreur={afficherToast}
        />
      )}
    </section>
  );
}

function FlecheDefilement({ direction, onClick }: { direction: 'gauche' | 'droite'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === 'gauche' ? 'Précédent' : 'Suivant'}
      className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-vitrine-bordure bg-vitrine-surface text-vitrine-txt-doux transition hover:bg-vitrine-surface-2"
    >
      {direction === 'gauche' ? <IconChevronLeft size={20} /> : <IconChevronRight size={20} />}
    </button>
  );
}

/**
 * Vert dès que la personne a fait ses heures, rouge tant qu'elle ne les a pas
 * faites. Par construction, chacun est rouge la majeure partie de son service :
 * la couleur devient informative en fin de service et dans le rapport du
 * manager — c'est voulu (§ 6.7).
 */
function FicheAgent({ membre, duree }: { membre: MembrePointage; duree: number }) {
  const couleur = couleurDe(membre.utilisateur_id);
  const pct = Math.min(100, (membre.minutes_faites / (duree * 60)) * 100);
  const fait = membre.heures_faites;

  return (
    <div
      className={`grid snap-start grid-cols-[auto_1fr] items-start gap-3 rounded-jeton border bg-vitrine-surface-2 p-3 ${
        membre.attendu ? 'border-vitrine-bordure' : fait ? 'border-ok/45' : 'border-alerte/45'
      }`}
    >
      <span
        className="flex h-10 w-10 flex-none items-center justify-center rounded-full text-[13px] font-bold"
        style={{ color: couleur, background: `color-mix(in srgb, ${couleur} 18%, var(--vitrine-surface))` }}
      >
        {initiales(membre.nom_complet)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13.5px] font-semibold leading-tight text-vitrine-txt">
          {membre.nom_complet}
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] font-medium text-vitrine-txt-doux">
          {membre.poste_jour}
        </span>

        {membre.attendu ? (
          <span className="mt-2 block text-[11.5px] font-medium text-vitrine-txt-doux">Pas encore pointé</span>
        ) : (
          <>
            <span className="mt-2 block text-[11.5px] font-medium text-vitrine-txt-doux">
              Arrivé <b className="font-bold text-vitrine-txt">{hhmm(membre.pointe_le)}</b> · fin{' '}
              <b className="font-bold text-vitrine-txt">{hhmm(membre.fin_prevue)}</b>
            </span>
            <span className="mt-2 block h-1 overflow-hidden rounded-full bg-vitrine-bordure">
              <i
                className={`block h-full rounded-full ${fait ? 'bg-ok' : 'bg-alerte'}`}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className={`mt-1.5 inline-block text-[11.5px] font-bold ${fait ? 'text-ok' : 'text-alerte'}`}>
              {fait ? `${enHeures(membre.minutes_faites)} faites` : `${enHeures(membre.minutes_faites)} / ${duree} h`}
            </span>
          </>
        )}

        {membre.salaire_paye && (
          <span className="ml-1.5 inline-block rounded-full bg-ok-tint px-2 py-0.5 text-[10.5px] font-bold text-ok-txt">
            Salaire payé
          </span>
        )}
        {membre.reste === false && (
          <span className="ml-1.5 inline-block rounded-full bg-vitrine-bordure px-2 py-0.5 text-[10.5px] font-bold text-vitrine-txt-doux">
            Parti
          </span>
        )}
        {membre.reste === true && (
          <span className="ml-1.5 inline-block rounded-full bg-ok-tint px-2 py-0.5 text-[10.5px] font-bold text-ok-txt">
            Reste
          </span>
        )}
      </span>
    </div>
  );
}

function ModalePointer({
  duree,
  dejaPresents,
  onFermer,
  onPointe,
  onErreur,
}: {
  duree: number;
  dejaPresents: string[];
  onFermer: () => void;
  onPointe: () => void;
  onErreur: (message: string) => void;
}) {
  const { data: proposes, isLoading } = useQuery({
    queryKey: ['equipe-proposee'],
    queryFn: () => api<EmployePropose[]>('/api/services/equipe-proposee'),
  });

  const pointage = useMutation({
    mutationFn: (e: EmployePropose) =>
      api('/api/pointage', {
        method: 'POST',
        corps: { utilisateur_id: e.utilisateur_id, poste_jour: e.poste_defaut },
      }),
    onSuccess: onPointe,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  const candidats = (proposes ?? []).filter((e) => !dejaPresents.includes(e.utilisateur_id));
  const maintenant = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  return (
    <Modale
      titre="Pointer une arrivée"
      onFermer={onFermer}
      enfants={
        <div>
          <p className="mb-4 text-sm leading-relaxed text-doux">
            L’heure enregistrée est <b>l’heure du clic</b> — il est {maintenant}. Elle sert de base au
            calcul des {duree} h et apparaît dans le rapport du manager.
          </p>
          {isLoading && <p className="text-doux">Chargement de l’équipe…</p>}
          {!isLoading && candidats.length === 0 && (
            <p className="text-doux">Toute l’équipe attendue est déjà pointée.</p>
          )}
          <div className="grid gap-2.5">
            {candidats.map((e) => (
              <button
                key={e.utilisateur_id}
                type="button"
                disabled={pointage.isPending}
                className="btn-blanc flex h-[60px] items-center justify-between px-4 disabled:opacity-60"
                onClick={() => pointage.mutate(e)}
              >
                <span className="flex items-center gap-3">
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold"
                    style={{
                      color: couleurDe(e.utilisateur_id),
                      background: `color-mix(in srgb, ${couleurDe(e.utilisateur_id)} 18%, var(--surface-carte))`,
                    }}
                  >
                    {initiales(e.nom_complet)}
                  </span>
                  <span className="text-left">
                    <span className="block text-sm font-semibold">{e.nom_complet}</span>
                    <span className="block text-[11.5px] text-faible">{e.poste_defaut}</span>
                  </span>
                </span>
                <span className="text-[13px] font-bold text-marque-sur-plan">Pointer {maintenant}</span>
              </button>
            ))}
          </div>
        </div>
      }
    />
  );
}
