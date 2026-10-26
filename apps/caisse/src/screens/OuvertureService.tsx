import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OccupationCaisse, ServiceOuvertVue } from '@pos/shared';
import { formatFCFA, LIBELLES_POSTES, POSTES_JOUR } from '@pos/shared';
import { api } from '../api';
import { Numpad } from '../components/Numpad';
import { ecranInitial, useCaisse } from '../stores/session';

interface MembrePropose {
  utilisateur_id: string;
  nom_complet: string;
  poste_defaut: string;
  /** Marqué « Reste » au dernier shift clôturé (§ 6.8) : pré-coché à l'ouverture. */
  reste_precedent: boolean;
}

interface EquipePointeuse {
  active: boolean;
  membres: (MembrePropose & { pointe_le: string | null })[];
}

/** Ouverture de service : fond de caisse, puis équipe du jour (allègement). */
export function OuvertureService() {
  const { session, poserServiceOuvert, poserSession, afficherToast, aller } = useCaisse();
  // Proprio, superviseur ET gérant ont un tableau de bord où revenir : ouvrir un
  // service reste facultatif pour eux (ils ne sont pas venus pour encaisser).
  const estSuperviseur = ecranInitial(session) === 'supervision';
  const [etape, setEtape] = useState<'fond' | 'equipe'>('fond');
  const [montant, setMontant] = useState('');
  const [enCours, setEnCours] = useState(false);
  // Map utilisateur_id → poste du jour (présent = présent dans la map).
  const [equipe, setEquipe] = useState<Record<string, string>>({});

  const {
    data: proposes,
    isSuccess: propositionsChargees,
    isError: erreurPropositions,
    isFetchedAfterMount: propositionsActualisees,
    refetch: rechargerPropositions,
  } = useQuery({
    queryKey: ['equipe-proposee'],
    queryFn: () => api<MembrePropose[]>('/api/services/equipe-proposee'),
    enabled: etape === 'equipe',
  });

  // Un seul shift ouvert à la fois : on interroge la caisse avant d'afficher le
  // clavier, pour expliquer qui est en poste au lieu d'un refus après saisie.
  // Rafraîchi toutes les 15 s : dès que la collègue clôture, l'écran se libère.
  const { data: occupation } = useQuery({
    queryKey: ['occupation-caisse'],
    queryFn: () => api<OccupationCaisse>('/api/services/occupation'),
    refetchInterval: 15000,
  });

  /**
   * Pré-cochage de la relève : qui était marqué « Reste » arrive déjà coché,
   * avec le poste qu'il tenait — c'était jusqu'ici à ressaisir à la main alors
   * que l'information existait déjà en base.
   *
   * Pré-COCHÉ et non imposé : la caissière peut décocher quelqu'un qui, en
   * fait, n'est pas là. L'heure d'arrivée d'un membre coché est datée de
   * l'ouverture et sert à la paie — mieux vaut un geste possible qu'une heure
   * créditée à tort.
   *
   * Une seule fois : le garde empêche qu'un refetch de TanStack Query ne
   * recoche quelqu'un que la caissière vient justement de décocher.
   */
  /**
   * Pointeuse en service (2026-10-26) : c'est elle qui dit qui est là, avec
   * l'heure réelle de chacun. La caissière ne coche plus personne, elle ne
   * règle que le poste du jour. Rafraîchi : l'équipe arrive pendant qu'on compte.
   */
  const { data: pointeuse, isError: erreurPointeuse } = useQuery({
    queryKey: ['equipe-pointeuse'],
    queryFn: () => api<EquipePointeuse>('/api/services/equipe-pointeuse'),
    enabled: etape === 'equipe',
    refetchInterval: 15000,
  });
  const modePointeuse = pointeuse?.active === true;
  useEffect(() => {
    if (!modePointeuse) return;
    setEquipe((e) => {
      const copie = { ...e };
      for (const m of pointeuse.membres) copie[m.utilisateur_id] ??= m.poste_defaut;
      return copie;
    });
  }, [modePointeuse, pointeuse]);

  const preRempli = useRef(false);
  useEffect(() => {
    if (preRempli.current || !propositionsChargees || !propositionsActualisees || !proposes) return;
    preRempli.current = true;
    const restants = proposes.filter((m) => m.reste_precedent);
    if (restants.length === 0) return;
    setEquipe((e) => {
      const copie = { ...e };
      for (const m of restants) copie[m.utilisateur_id] ??= m.poste_defaut;
      return copie;
    });
  }, [proposes, propositionsChargees, propositionsActualisees]);

  const basculer = (m: MembrePropose) => {
    setEquipe((e) => {
      const copie = { ...e };
      if (copie[m.utilisateur_id]) delete copie[m.utilisateur_id];
      else copie[m.utilisateur_id] = m.poste_defaut;
      return copie;
    });
  };

  // Avec la pointeuse, la liste à cocher n'est plus nécessaire pour ouvrir.
  const pret = modePointeuse || ((!!pointeuse || erreurPointeuse) && propositionsChargees && propositionsActualisees);

  const ouvrir = async () => {
    if (!pret) return;
    setEnCours(true);
    try {
      const service = await api<ServiceOuvertVue>('/api/services/ouvrir', {
        method: 'POST',
        corps: {
          fond_de_caisse: Number(montant || '0'),
          // Mode pointeuse : seul le poste compte, le serveur refait la liste.
          equipe: Object.entries(equipe).map(([utilisateur_id, poste_jour]) => ({ utilisateur_id, poste_jour })),
        },
      });
      poserServiceOuvert(service);
    } catch (e) {
      afficherToast((e as Error).message);
    } finally {
      setEnCours(false);
    }
  };

  const seDeconnecter = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* ignore */ }
    poserSession(null);
  };

  // Caisse tenue par quelqu'un d'autre : rien d'autre à faire que patienter ou
  // se déconnecter. Le blocage est aussi appliqué côté serveur (409).
  if (occupation?.occupee) {
    const depuis = occupation.ouvert_le
      ? new Date(occupation.ouvert_le).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      : null;
    return (
      <div className="flex min-h-full flex-col items-center justify-center p-6">
        <div className="carte w-full max-w-sm space-y-4 p-6 text-center shadow-e2">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-alerte/10 text-3xl">⏳</div>
          <h1 className="text-2xl font-bold text-alerte">Un autre shift est en cours</h1>
          <p className="text-doux">
            <span className="font-semibold text-fort">{occupation.caissier}</span> tient la caisse
            {depuis ? ` depuis ${depuis}` : ''}. Vous pourrez ouvrir votre service dès qu’il aura
            fait « J’ai fini ».
          </p>
          <p className="text-sm text-doux">
            Pour une relève, l’employé en poste passe par « J’ai fini » puis « Transférer au
            caissier suivant ».
          </p>
          {estSuperviseur ? (
            <button type="button" className="btn-blanc w-full" onClick={() => aller('supervision')}>← Retour à la supervision</button>
          ) : (
            <button type="button" className="btn-blanc w-full" onClick={seDeconnecter}>Se déconnecter</button>
          )}
        </div>
      </div>
    );
  }

  if (etape === 'fond') {
    return (
      <div className="flex min-h-full flex-col items-center justify-center p-6">
        <div className="carte w-full max-w-sm space-y-4 p-6 shadow-e2">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-marque-fonce">Ouverture de service</h1>
            <p className="mt-1 text-sm text-doux">{session?.utilisateur.nom_complet}</p>
          </div>
          <div className="rounded-[13px] bg-surface-douce p-4 text-center">
            <div className="text-xs font-semibold uppercase tracking-widest text-doux">Fond de caisse</div>
            <div className="mt-1 text-4xl font-black tabular-nums text-fort">
              {montant ? formatFCFA(Number(montant)) : <span className="text-lg font-normal text-doux">à compter…</span>}
            </div>
          </div>
          <Numpad
            valeur={montant}
            onChange={setMontant}
            onValider={() => setEtape('equipe')}
            libelleValider="Continuer"
            validerDesactive={montant === ''}
          />
          {estSuperviseur ? (
            <button type="button" className="btn-blanc w-full" onClick={() => aller('supervision')}>← Retour à la supervision</button>
          ) : (
            <button type="button" className="btn-blanc w-full" onClick={seDeconnecter}>Se déconnecter</button>
          )}
        </div>
      </div>
    );
  }

  if (modePointeuse) {
    const heure = (iso: string | null) =>
      iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
    return (
      <div className="flex min-h-full flex-col bg-fond p-6">
        <div className="mb-5 text-center">
          <h1 className="text-2xl font-bold text-marque-fonce">Équipe du jour</h1>
          <p className="mt-1 text-sm text-doux">
            Donnée par la pointeuse — ajustez seulement le poste. Les retardataires s’ajouteront en pointant.
          </p>
        </div>
        <div className="mx-auto grid w-full max-w-2xl gap-2">
          {pointeuse.membres.length === 0 && (
            <p className="rounded-[13px] bg-surface-douce p-4 text-center text-doux">
              Personne n’a encore pointé son entrée.
            </p>
          )}
          {pointeuse.membres.map((m) => (
            <div key={m.utilisateur_id} className="flex items-center gap-3 rounded-[13px] border-2 border-marque bg-marque-tint px-4 py-3 shadow-e1">
              <span className="flex-1">
                <span className="block font-semibold">{m.nom_complet}</span>
                <span className="block text-xs text-doux">
                  {m.pointe_le ? `Pointé à ${heure(m.pointe_le)}` : 'Reste du shift précédent'}
                </span>
              </span>
              <select
                className="champ w-44"
                value={equipe[m.utilisateur_id] ?? m.poste_defaut}
                onChange={(ev) => setEquipe((e) => ({ ...e, [m.utilisateur_id]: ev.target.value }))}
              >
                {!POSTES_JOUR.includes(m.poste_defaut as never) && <option value={m.poste_defaut}>{m.poste_defaut}</option>}
                {POSTES_JOUR.map((p) => <option key={p} value={p}>{LIBELLES_POSTES[p]}</option>)}
              </select>
            </div>
          ))}
        </div>
        <div className="mx-auto mt-6 flex w-full max-w-2xl gap-3">
          <button type="button" className="btn-blanc" onClick={() => setEtape('fond')}>Retour</button>
          <button type="button" className="btn-accent flex-1" onClick={ouvrir} disabled={enCours}>
            {enCours ? 'Ouverture…' : `Ouvrir le service (${pointeuse.membres.length} présent(s))`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-fond p-6">
      <div className="mb-5 text-center">
        <h1 className="text-2xl font-bold text-marque-fonce">Équipe du jour</h1>
        <p className="mt-1 text-sm text-doux">Cochez les personnes présentes et ajustez leur poste</p>
      </div>
      <div className="mx-auto grid w-full max-w-2xl gap-2">
        {erreurPropositions && (
          <button type="button" className="btn-blanc" onClick={() => void rechargerPropositions()}>
            Impossible de charger l’équipe. Réessayer
          </button>
        )}
        {!erreurPropositions && !propositionsActualisees && <p className="text-center text-doux">Chargement de l’équipe…</p>}
        {(propositionsChargees && propositionsActualisees ? proposes ?? [] : []).map((m) => {
          const present = m.utilisateur_id in equipe;
          return (
            <div key={m.utilisateur_id} className={`flex items-center gap-3 rounded-[13px] border-2 px-4 py-3 transition ${present ? 'border-marque bg-marque-tint shadow-e1' : 'border-bordure bg-surface'}`}>
              <button type="button" className="flex flex-1 items-center gap-3 text-left" onClick={() => basculer(m)}>
                <span className={`flex h-6 w-6 flex-none items-center justify-center rounded-md border-2 text-xs font-bold ${present ? 'border-marque bg-marque text-sur-marque' : 'border-bordure-forte'}`}>{present ? '✓' : ''}</span>
                <span className="font-semibold">{m.nom_complet}</span>
              </button>
              {present && (
                <select
                  className="champ w-44"
                  value={equipe[m.utilisateur_id]}
                  onChange={(ev) => setEquipe((e) => ({ ...e, [m.utilisateur_id]: ev.target.value }))}
                >
                  {POSTES_JOUR.map((p) => <option key={p} value={p}>{LIBELLES_POSTES[p]}</option>)}
                </select>
              )}
            </div>
          );
        })}
      </div>
      <div className="mx-auto mt-6 flex w-full max-w-2xl gap-3">
        <button type="button" className="btn-blanc" onClick={() => setEtape('fond')}>Retour</button>
        <button type="button" className="btn-accent flex-1" onClick={ouvrir} disabled={enCours || !pret}>
          {enCours ? 'Ouverture…' : `Ouvrir le service (${Object.keys(equipe).length} présent(s))`}
        </button>
      </div>
    </div>
  );
}
