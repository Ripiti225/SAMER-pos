import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconCash,
  IconClock,
  IconPackage,
  IconPhone,
  IconStar,
  IconTrendingUp,
} from '@tabler/icons-react';
import type { CritereNoteVue, NoteCaissierVue } from '@pos/shared';
import { api } from '../api';
import { Modale } from './Modale';

/**
 * Note du caissier (2026-10-15) : calculée par SamerTrackly — « Note des
 * caissiers », sur 20, 30 derniers jours, jamais le volume de ventes — et
 * descendue sur la caisse. Chacun voit la SIENNE, en haut de l'accueil ; un
 * appui ouvre le détail par critère, avec ce qu'il faut faire pour progresser.
 */

/** Libellé et icône des critères : les mêmes que dans SamerTrackly. */
const CRITERES: Record<string, { nom: string; Icone: typeof IconCash }> = {
  caisse: { nom: 'Justesse de la caisse', Icone: IconCash },
  contacts: { nom: 'Numéros des clients', Icone: IconPhone },
  inventaire: { nom: 'Inventaire et comptage', Icone: IconPackage },
  clients: { nom: 'Clients et plateformes', Icone: IconStar },
  presence: { nom: 'Présence', Icone: IconClock },
  bonus: { nom: 'Ventes additionnelles (bonus)', Icone: IconTrendingUp },
};

/** Même échelle que SamerTrackly : 17+ excellent, 14 très bien, 12 bien, 10 correct. */
function ton(note: number | null): { texte: string; fond: string } {
  if (note === null) return { texte: 'text-doux', fond: 'bg-surface-douce' };
  if (note >= 14) return { texte: 'text-ok-txt', fond: 'bg-ok-tint' };
  if (note >= 12) return { texte: 'text-info-txt', fond: 'bg-info-tint' };
  if (note >= 10) return { texte: 'text-attente-txt', fond: 'bg-attente-tint' };
  return { texte: 'text-alerte-txt', fond: 'bg-alerte-tint' };
}

const virgule = (n: number) => String(n).replace('.', ',');
const dateCourte = (iso: string | null) =>
  iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '—';

function Progression({ note, precedente }: { note: number | null; precedente: number | null }) {
  if (note === null || precedente === null) return null;
  const delta = Math.round((note - precedente) * 10) / 10;
  if (delta === 0) return <span className="text-xs font-semibold text-doux">=</span>;
  const Icone = delta > 0 ? IconArrowUpRight : IconArrowDownRight;
  return (
    <span className={`flex items-center text-xs font-bold ${delta > 0 ? 'text-ok-txt' : 'text-alerte-txt'}`}>
      <Icone size={14} stroke={2.5} />
      {delta > 0 ? '+' : ''}{virgule(delta)}
    </span>
  );
}

/** La pastille cliquable : « ⭐ 15,5/20 ↗+1 ». Rien tant qu'aucune note n'est descendue. */
export function PastilleNote() {
  const [ouverte, setOuverte] = useState(false);
  const { data } = useQuery({
    queryKey: ['ma-note'],
    queryFn: () => api<{ note: NoteCaissierVue | null }>('/api/moi/note'),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
  const note = data?.note;
  if (!note) return null;
  const t = ton(note.note);

  return (
    <>
      <button
        type="button"
        onClick={() => setOuverte(true)}
        title="Ma note — détail"
        className={`flex min-h-[44px] items-center gap-1.5 rounded-full px-3 font-bold tabular-nums transition hover:brightness-95 ${t.fond} ${t.texte}`}
      >
        <IconStar size={16} />
        {note.note === null ? (
          <span className="text-xs font-semibold">Note : {note.nb_shifts}/{note.min_shifts} shifts</span>
        ) : (
          <>
            <span>{virgule(note.note)}<span className="text-xs font-semibold opacity-70">/20</span></span>
            <Progression note={note.note} precedente={note.note_precedente} />
          </>
        )}
      </button>
      {ouverte && <DetailNote note={note} titre="Ma note" onFermer={() => setOuverte(false)} />}
    </>
  );
}

/** Détail d'une note : la note, l'appréciation, une barre par critère et le conseil. */
export function DetailNote({ note, titre, onFermer }: { note: NoteCaissierVue; titre: string; onFermer: () => void }) {
  const t = ton(note.note);
  const lignes = [...note.criteres, ...(note.bonus ? [note.bonus] : [])];
  return (
    <Modale
      titre={titre}
      onFermer={onFermer}
      enfants={
        <div className="space-y-4">
          <div className={`flex items-center gap-4 rounded-jeton p-4 ${t.fond}`}>
            <div className={`text-5xl font-black leading-none tabular-nums ${t.texte}`}>
              {note.note === null ? '—' : virgule(note.note)}
              {note.note !== null && <span className="text-xl font-bold opacity-70">/20</span>}
            </div>
            <div className="min-w-0">
              <div className={`text-lg font-bold ${t.texte}`}>{note.appreciation ?? 'Pas encore noté'}</div>
              <div className="flex items-center gap-2 text-sm text-doux">
                Du {dateCourte(note.periode_debut)} au {dateCourte(note.periode_fin)}
                <Progression note={note.note} precedente={note.note_precedente} />
              </div>
            </div>
          </div>

          {note.note === null && (
            <p className="rounded-btn bg-surface-douce px-3 py-2 text-sm text-doux">
              {note.nb_shifts} shift{note.nb_shifts > 1 ? 's' : ''} sur 30 jours : la note apparaîtra à partir de {note.min_shifts}.
              Le détail ci-dessous est donné pour information.
            </p>
          )}

          <div className="space-y-3">
            {lignes.map((c) => <LigneCritere key={c.cle} critere={c} />)}
          </div>

          <p className="text-xs text-doux">
            Calculée par SamerTrackly sur les 30 derniers jours, jamais sur le volume de ventes. Mise à jour le{' '}
            {new Date(note.calcule_le).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.
          </p>
        </div>
      }
    />
  );
}

function LigneCritere({ critere }: { critere: CritereNoteVue }) {
  const def = CRITERES[critere.cle] ?? { nom: critere.cle, Icone: IconStar };
  const part = critere.max > 0 ? Math.min(1, critere.points / critere.max) : 0;
  const couleur = !critere.applicable ? 'bg-bordure-forte' : part >= 0.85 ? 'bg-ok' : part >= 0.5 ? 'bg-attente' : 'bg-alerte';
  return (
    <div>
      <div className="flex items-center gap-2">
        <def.Icone size={18} className="flex-none text-doux" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fort">{def.nom}</span>
        <span className="flex-none text-sm font-bold tabular-nums text-fort">
          {critere.applicable ? `${virgule(critere.points)}/${critere.max}` : 'non noté'}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-douce">
        <div className={`h-full rounded-full ${couleur}`} style={{ width: `${critere.applicable ? part * 100 : 100}%`, opacity: critere.applicable ? 1 : 0.35 }} />
      </div>
      {critere.resume && <div className="mt-1 text-xs text-doux">{critere.resume}</div>}
      {critere.applicable && critere.conseil && <div className="text-xs font-semibold text-fort">{critere.conseil}</div>}
    </div>
  );
}

/**
 * Supervision : la note de chaque caissier du site, en pastilles. Réservé aux
 * responsables (le serveur refuse la route aux autres). Rien tant qu'aucune
 * note n'est descendue.
 */
export function BandeNotesEquipe() {
  const [ouverte, setOuverte] = useState<NoteCaissierVue | null>(null);
  const { data } = useQuery({
    queryKey: ['notes-equipe'],
    queryFn: () => api<NoteCaissierVue[]>('/api/equipe/notes'),
    staleTime: 5 * 60_000,
  });
  if (!data || data.length === 0) return null;
  return (
    <div className="w-full rounded-[18px] border border-bordure bg-surface px-5 py-3">
      <div className="mb-2 flex items-center gap-2">
        <IconStar size={20} className="flex-none text-doux" />
        <span className="font-bold text-fort">Notes de l’équipe</span>
        <span className="text-xs text-doux">· 30 derniers jours, calculées par SamerTrackly</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {data.map((n) => {
          const t = ton(n.note);
          return (
            <button
              key={n.utilisateur_id}
              type="button"
              onClick={() => setOuverte(n)}
              className="flex min-h-[44px] items-center gap-2 rounded-full border border-bordure bg-surface-douce py-1 pl-3 pr-1 text-sm font-semibold text-fort transition hover:brightness-95"
            >
              <span className="max-w-[10rem] truncate">{n.nom ?? '—'}</span>
              <span className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-bold tabular-nums ${t.fond} ${t.texte}`}>
                {n.note === null ? `${n.nb_shifts}/${n.min_shifts}` : `${virgule(n.note)}/20`}
                <Progression note={n.note} precedente={n.note_precedente} />
              </span>
            </button>
          );
        })}
      </div>
      {ouverte && <DetailNote note={ouverte} titre={`Note de ${ouverte.nom ?? 'l’employé'}`} onFermer={() => setOuverte(null)} />}
    </div>
  );
}
