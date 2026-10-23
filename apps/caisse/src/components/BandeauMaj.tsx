import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ErreurApi } from '../api';
import { useMaj } from '../stores/maj';
import { useCaisse, type Ecran } from '../stores/session';
import { ModalePinManager } from './ModalePinManager';

/** Réponse de `GET /api/maj/etat` (serveur, modules/maj/moteur.ts `VueMaj`). */
interface VueMaj {
  actif: boolean;
  mode: 'NORMAL' | 'VALIDATION' | 'ARRET';
  etat: string;
  installee: { numero: number; version: string };
  prete: { numero: number; version: string } | null;
  decision: null | {
    action: 'RIEN' | 'ATTENDRE' | 'AVERTIR' | 'INSTALLER';
    raison: string;
    echeance: string | null;
    report_possible: boolean;
    rappel: boolean;
  };
}

/**
 * Écrans où recharger la page ne coûte rien : aucune saisie en cours. Sur
 * Commande, Paiement, Clôture… on attend que le caissier en sorte — une
 * addition à moitié encaissée ne doit pas disparaître sous ses doigts.
 */
const ECRANS_AU_REPOS: Ecran[] = ['accueil', 'tables', 'mes-ventes', 'supervision'];

/** « 06h00 » (heure du poste, Abidjan = UTC). */
function heureCourte(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Mise à jour à distance côté caisse (plan § 3, lot L5) :
 * - à H-10 min, bandeau « Mise à jour à 06h00 (2-3 min) » avec « Pas
 *   maintenant » (PIN gérant, UNE seule fois, report de 30 min) ;
 * - à la fin du report, rappel sans bouton : la mise à jour se fera ;
 * - pendant l'installation, écran « Mise à jour en cours » ;
 * - nouvelle version validée → rechargement automatique dès que la caisse
 *   est au repos (nouveau code de la caisse servi par le serveur).
 */
export function BandeauMaj() {
  const { session, ecran, afficherToast } = useCaisse();
  const { enCours, aRecharger, debut, terminee } = useMaj();
  const queryClient = useQueryClient();
  const [pin, setPin] = useState(false);

  const { data: vue } = useQuery({
    queryKey: ['maj-etat'],
    queryFn: () => api<VueMaj>('/api/maj/etat'),
    // Toutes les minutes en temps normal ; toutes les 5 s pendant la coupure,
    // pour voir revenir le serveur même si `maj_terminee` a été manqué
    // (WebSocket coupé pendant le redémarrage).
    refetchInterval: enCours ? 5_000 : 60_000,
    retry: false,
  });

  useEffect(() => {
    if (!vue) return;
    if (vue.mode !== 'NORMAL' && !enCours) debut();
    if (vue.mode === 'NORMAL' && enCours) terminee();
  }, [vue, enCours, debut, terminee]);

  // Rechargement au repos après une mise à jour.
  useEffect(() => {
    if (!aRecharger) return;
    const essayer = () => {
      const etat = useCaisse.getState();
      if (!etat.session || ECRANS_AU_REPOS.includes(etat.ecran)) window.location.reload();
    };
    essayer();
    const t = setInterval(essayer, 3_000);
    return () => clearInterval(t);
  }, [aRecharger]);

  const reporter = useMutation({
    mutationFn: (pinManager: string) => api<VueMaj>('/api/maj/reporter', { method: 'POST', corps: { pin_manager: pinManager } }),
    onSuccess: (nouvelle) => {
      setPin(false);
      queryClient.setQueryData(['maj-etat'], nouvelle);
      afficherToast(`Mise à jour reportée à ${heureCourte(nouvelle.decision?.echeance ?? null)}`);
    },
    onError: (e) => afficherToast(e instanceof ErreurApi ? e.message : 'Report impossible'),
  });

  if (enCours) {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6 text-center">
        <div className="carte max-w-lg p-8">
          <div className="text-3xl font-black text-marque-sur-plan">Mise à jour en cours</div>
          <p className="mt-3 text-xl">2 à 3 minutes — ne pas éteindre le poste.</p>
          <p className="mt-2 text-doux">Les commandes et le service en cours sont conservés. La caisse revient toute seule.</p>
        </div>
      </div>
    );
  }

  const d = vue?.decision;
  if (!vue || !d || !(d.action === 'AVERTIR' || d.action === 'INSTALLER')) return null;
  const heure = heureCourte(d.echeance);

  return (
    <>
      <div className="fixed left-1/2 top-3 z-[56] w-full max-w-xl -translate-x-1/2 px-3">
        <div className="carte border-2 border-alerte bg-alerte-tint p-3 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="text-lg font-bold text-alerte-txt">
                {d.action === 'INSTALLER' ? 'Mise à jour imminente (2-3 min)' : `Mise à jour à ${heure} (2-3 min)`}
              </div>
              <div className="text-sm text-fort">
                {d.rappel || !d.report_possible
                  ? 'Elle a déjà été reportée : elle ne peut plus l’être. Terminez l’encaissement en cours.'
                  : 'La caisse sera indisponible 2 à 3 minutes. Le service en cours est conservé.'}
              </div>
            </div>
            {d.report_possible && !d.rappel && session && (
              <button type="button" className="btn-blanc min-h-[48px] flex-none px-4" onClick={() => setPin(true)}>
                Pas maintenant
              </button>
            )}
          </div>
        </div>
      </div>
      {pin && (
        <ModalePinManager
          titre="Reporter la mise à jour de 30 minutes"
          explication="Une seule fois : à la fin du report, la mise à jour se fera."
          libellePin="PIN gérant"
          demanderMotif={false}
          enCours={reporter.isPending}
          onFermer={() => setPin(false)}
          onConfirmer={({ pin: p }) => reporter.mutate(p)}
        />
      )}
    </>
  );
}
