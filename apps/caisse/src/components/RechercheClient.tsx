import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { IconUserPlus } from '@tabler/icons-react';
import { api } from '../api';

export interface ClientTrouve {
  client_id: string | null;
  telephone: string;
  nom: string | null;
  solde: number;
}

const chiffres = (v: string) => v.replace(/\D/g, '');

/** Un numéro assez complet pour créer un client (même règle que le serveur). */
export const telephoneValide = (v: string) => /^[+0-9][0-9 ]{5,19}$/.test(v.trim()) && chiffres(v).length >= 8;

/**
 * Suggestions sous le champ téléphone : dès 3 chiffres, tous les numéros qui
 * les CONTIENNENT s'affichent (« 0769 » trouve 0769…, 05 07 69…). Le numéro
 * tapé sert lui-même de « nouveau client » quand personne ne correspond.
 */
export function SuggestionsClients({
  saisie,
  onChoisir,
}: {
  saisie: string;
  onChoisir: (client: ClientTrouve) => void;
}) {
  // Un court délai : on n'interroge pas le serveur à chaque chiffre d'une
  // rafale, mais la liste suit la frappe sans bouton « Chercher ».
  const [q, setQ] = useState(saisie.trim());
  useEffect(() => {
    const minuteur = setTimeout(() => setQ(saisie.trim()), 150);
    return () => clearTimeout(minuteur);
  }, [saisie]);

  const actif = chiffres(q).length >= 3 || (/[a-zà-ÿ]/i.test(q) && q.length >= 2);
  const { data, isFetching } = useQuery({
    queryKey: ['clients', 'recherche', q],
    queryFn: () => api<{ clients: ClientTrouve[] }>(`/api/clients/recherche?q=${encodeURIComponent(q)}`),
    enabled: actif,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  if (!actif) return null;
  const clients = data?.clients ?? [];
  const exact = clients.some((c) => chiffres(c.telephone) === chiffres(saisie));
  const proposerNouveau = telephoneValide(saisie) && !exact;

  return (
    <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
      {clients.map((c) => (
        <button
          key={`${c.client_id ?? 'contact'}-${c.telephone}`}
          type="button"
          onClick={() => onChoisir(c)}
          className="flex min-h-12 w-full items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2 text-left transition hover:bg-marque-tint"
        >
          <span className="min-w-0">
            <span className="block font-bold tabular-nums text-fort"><Surligne texte={c.telephone} motif={chiffres(q)} /></span>
            {c.nom && <span className="block truncate text-xs text-doux">{c.nom}</span>}
          </span>
          <span className="flex-none text-xs font-semibold text-doux">
            {c.client_id ? `${c.solde} pts` : 'Livraison'}
          </span>
        </button>
      ))}
      {proposerNouveau && (
        <button
          type="button"
          onClick={() => onChoisir({ client_id: null, telephone: saisie.trim(), nom: null, solde: 0 })}
          className="flex min-h-12 w-full items-center gap-2 rounded-lg border border-dashed border-bordure-forte px-3 py-2 text-left font-semibold text-marque-fonce"
        >
          <IconUserPlus size={18} /> Nouveau client · {saisie.trim()}
        </button>
      )}
      {clients.length === 0 && !proposerNouveau && !isFetching && (
        <p className="px-1 py-2 text-sm text-doux">Aucun client avec ce numéro — continuez à taper.</p>
      )}
    </div>
  );
}

/** Met en gras les chiffres tapés à l'intérieur du numéro, espaces compris. */
function Surligne({ texte, motif }: { texte: string; motif: string }) {
  if (!motif) return <>{texte}</>;
  // Position du motif dans la suite de chiffres, reportée sur le texte affiché.
  const positions: number[] = [];
  for (let i = 0; i < texte.length; i++) if (/\d/.test(texte[i]!)) positions.push(i);
  const debut = chiffres(texte).indexOf(motif);
  if (debut < 0) return <>{texte}</>;
  const de = positions[debut]!;
  const a = positions[debut + motif.length - 1]! + 1;
  return (
    <>
      {texte.slice(0, de)}
      <mark className="rounded bg-marque-tint px-0.5 text-marque-fonce">{texte.slice(de, a)}</mark>
      {texte.slice(a)}
    </>
  );
}
