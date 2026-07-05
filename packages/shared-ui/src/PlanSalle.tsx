import { useState } from 'react';
import type { TableVue } from '@pos/shared';

import { LIBELLES_ETAT_TABLE } from '@pos/shared';

interface Props {
  tables: TableVue[];
  onTable: (table: TableVue) => void;
  /** Masquer les tables virtuelles partenaires (app serveur). */
  masquerPartenaires?: boolean;
  /**
   * Point 3 : sur la tablette serveur, id du serveur connecté. Les tables des
   * autres serveurs affichent leur prénom et ne s'ouvrent pas (onBloque).
   */
  moiServeurId?: string;
  onBloque?: (table: TableVue) => void;
}

function prenom(nom: string | null): string {
  return nom ? (nom.split(/\s+/)[0] ?? nom) : 'un autre serveur';
}

/**
 * Plan de salle par zones — composant commun caisse/tablette/client.
 * Couleur = état DÉRIVÉ (point 4) ; badges Appel/Facture/Prête ; propriété de
 * table (point 3) sur la tablette serveur.
 */
export function PlanSalle({ tables, onTable, masquerPartenaires, moiServeurId, onBloque }: Props) {
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
          .map((t) => {
            const aAutrui = !!moiServeurId && !!t.ouverte_par && t.ouverte_par !== moiServeurId;
            return (
              <button
                key={t.id}
                type="button"
                className={`btn relative min-h-[88px] flex-col gap-1 ${aAutrui ? 'border border-bordure bg-surface text-doux opacity-70' : couleurEtat(t.etat)}`}
                onClick={() => (aAutrui ? onBloque?.(t) : onTable(t))}
              >
                <span className="absolute right-1 top-1 flex gap-0.5">
                  {t.badges.map((b) => (
                    <span key={b} title={b} className="text-sm leading-none">
                      {b === 'APPEL' ? '🔔' : b === 'FACTURE' ? '🧾' : '✅'}
                    </span>
                  ))}
                </span>
                <span className="text-xl font-black">{t.numero}</span>
                <span className="text-[11px] leading-tight">
                  {aAutrui ? `Table de ${prenom(t.ouverte_par_nom)}` : LIBELLES_ETAT_TABLE[t.etat]}
                </span>
              </button>
            );
          })}
      </div>

      <div className="mt-6 flex flex-wrap gap-3 text-xs text-doux">
        <span><span className="mr-1 inline-block h-3 w-3 rounded border border-bordure bg-surface align-middle" /> Libre</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-[#7c3aed] align-middle" /> Client à valider</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-marque align-middle" /> En préparation</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-ok align-middle" /> Prête</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-info align-middle" /> En cours de repas</span>
        <span><span className="mr-1 inline-block h-3 w-3 rounded bg-[#1e40af] align-middle" /> Facture</span>
      </div>
    </div>
  );
}

/** Couleur de l'état principal dérivé (point 4). */
function couleurEtat(etat: TableVue['etat']): string {
  switch (etat) {
    case 'COMMANDE_CLIENT_A_VALIDER':
      return 'bg-[#7c3aed] text-white';
    case 'EN_PREPARATION':
      return 'bg-marque text-white';
    case 'PRETE':
      return 'animate-pulse bg-ok text-white';
    case 'SERVIE':
      return 'bg-info text-white';
    case 'ADDITION_DEMANDEE':
      return 'bg-[#1e40af] text-white';
    default:
      return 'border border-bordure bg-surface hover:bg-marque-tint';
  }
}
