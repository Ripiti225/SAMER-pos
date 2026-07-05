import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { formatFCFA } from '@pos/shared';
import { api } from '../api';
import { useCaisse } from '../stores/session';

interface Bord {
  ca: number;
  tickets: number;
  panier_moyen: number;
  top_plats: { nom: string; quantite: number }[];
  ecarts_par_caissier: { nom: string; ecart: number; nb_services: number }[];
}

/** C3 — Tableau de bord propriétaire (lecture locale, période glissante). */
export function TableauBord() {
  const { session } = useCaisse();
  const [periode, setPeriode] = useState<'jour' | '7' | '30'>('jour');
  const estProprio = session?.utilisateur.role === 'PROPRIETAIRE';

  const { data } = useQuery({
    queryKey: ['tableau-bord', periode],
    queryFn: () => api<Bord>(`/api/rapports/tableau-bord?periode=${periode}`),
    enabled: estProprio,
  });

  if (!estProprio) return null;

  return (
    <div className="carte p-4 lg:col-span-3">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="font-bold">Tableau de bord</h2>
        <div className="ml-auto flex gap-1">
          {(['jour', '7', '30'] as const).map((p) => (
            <button key={p} type="button" className={`btn min-h-[36px] px-3 text-sm ${periode === p ? 'bg-marque text-white' : 'border border-bordure bg-surface'}`} onClick={() => setPeriode(p)}>
              {p === 'jour' ? 'Jour' : `${p} j`}
            </button>
          ))}
        </div>
      </div>
      {data && (
        <div className="grid grid-cols-3 gap-3">
          <Stat libelle="Chiffre d’affaires" valeur={formatFCFA(data.ca)} />
          <Stat libelle="Tickets" valeur={String(data.tickets)} />
          <Stat libelle="Panier moyen" valeur={formatFCFA(data.panier_moyen)} />
          <div className="col-span-3">
            <div className="mb-1 text-sm font-semibold text-doux">Top plats</div>
            {data.top_plats.slice(0, 5).map((p) => (
              <div key={p.nom} className="flex justify-between text-sm"><span>{p.nom}</span><span className="text-doux">×{p.quantite}</span></div>
            ))}
          </div>
          {data.ecarts_par_caissier.length > 0 && (
            <div className="col-span-3">
              <div className="mb-1 text-sm font-semibold text-doux">Écarts de caisse par caissier</div>
              {data.ecarts_par_caissier.map((e) => (
                <div key={e.nom} className="flex justify-between text-sm">
                  <span>{e.nom} ({e.nb_services})</span>
                  <span className={e.ecart === 0 ? 'text-ok' : 'text-alerte'}>{formatFCFA(e.ecart)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ libelle, valeur }: { libelle: string; valeur: string }) {
  return (
    <div className="rounded-xl border border-bordure p-3 text-center">
      <div className="text-xs text-doux">{libelle}</div>
      <div className="text-lg font-black text-marque-fonce">{valeur}</div>
    </div>
  );
}
