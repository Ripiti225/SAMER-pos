import { useState } from 'react';
import type { TableVue } from '@pos/shared';

interface Props {
  tables: TableVue[];
  onTable: (table: TableVue) => void;
  /** Masquer les tables virtuelles partenaires (app serveur). */
  masquerPartenaires?: boolean;
}

/**
 * Plan de salle par zones (sprint 2 §B1/§C) — composant commun caisse/tablette.
 * Couleurs : gris = LIBRE, orange (accent) = OCCUPEE, bleu = ADDITION_DEMANDEE.
 */
export function PlanSalle({ tables, onTable, masquerPartenaires }: Props) {
  const visibles = masquerPartenaires ? tables.filter((t) => !t.partenaire) : tables;
  const zones = [...new Map(visibles.map((t) => [t.zone_nom, true])).keys()];
  const [zoneActive, setZoneActive] = useState<string | null>(null);
  const zone = zoneActive && zones.includes(zoneActive) ? zoneActive : zones[0] ?? null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2">
        {zones.map((z) => (
          <button
            key={z}
            type="button"
            className={`btn ${z === zone ? 'bg-marque text-white' : 'border border-bordure bg-surface'}`}
            onClick={() => setZoneActive(z)}
          >
            {z}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {visibles
          .filter((t) => t.zone_nom === zone)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              className={`btn min-h-[88px] flex-col gap-1 ${couleurTable(t.statut)}`}
              onClick={() => onTable(t)}
            >
              <span className="text-xl font-black">{t.numero}</span>
              <span className="text-xs">{libelleStatut(t.statut)}</span>
            </button>
          ))}
      </div>

      <div className="mt-6 flex flex-wrap gap-4 text-xs text-doux">
        <span><span className="mr-1 inline-block h-3 w-3 rounded border border-bordure bg-surface align-middle" /> Libre</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-marque align-middle" /> Occupée</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-info align-middle" /> Addition demandée</span>
      </div>
    </div>
  );
}

function couleurTable(statut: TableVue['statut']): string {
  if (statut === 'ADDITION_DEMANDEE') return 'bg-info text-white';
  if (statut === 'OCCUPEE') return 'bg-marque text-white';
  return 'border border-bordure bg-surface hover:bg-marque-tint';
}

function libelleStatut(statut: TableVue['statut']): string {
  if (statut === 'ADDITION_DEMANDEE') return 'Addition demandée';
  if (statut === 'OCCUPEE') return 'Occupée';
  return 'Libre';
}
