import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconLogout, IconMoon, IconSun } from '@tabler/icons-react';
import { appelSiege, ErreurSiege, type Siege } from './api';
import { modeInitial, poserMode, type Mode } from './affichage';
import type { FiltreResto } from './restaurants';
import { supabase } from './supabase';
import { Clotures } from './screens/Clotures';
import { Connexion } from './screens/Connexion';
import { Equipe } from './screens/Equipe';
import { Inventaire } from './screens/Inventaire';
import { RecettesInventaire } from './screens/RecettesInventaire';
import { Categories } from './screens/Categories';
import { Menu } from './screens/Menu';
import { Parametres } from './screens/Parametres';
import { Sequences } from './screens/Sequences';
import { TableauBord } from './screens/TableauBord';

type Ecran = 'tableau-bord' | 'clotures' | 'inventaire' | 'recettes-inventaire' | 'sequences' | 'menu' | 'categories' | 'equipe' | 'parametres';

const SECTIONS: { cle: Ecran; libelle: string }[] = [
  { cle: 'tableau-bord', libelle: 'Tableau de bord' },
  { cle: 'clotures', libelle: 'Clôtures' },
  { cle: 'inventaire', libelle: 'Inventaire' },
  { cle: 'recettes-inventaire', libelle: 'Recettes d’inventaire' },
  { cle: 'sequences', libelle: 'Séquences' },
  { cle: 'menu', libelle: 'Menu' },
  { cle: 'categories', libelle: 'Catégories' },
  { cle: 'equipe', libelle: 'Équipe' },
  { cle: 'parametres', libelle: 'Paramètres' },
];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [siege, setSiege] = useState<Siege | null>(null);
  const [chargement, setChargement] = useState(true);
  const [refus, setRefus] = useState<string | null>(null);
  const [ecran, setEcran] = useState<Ecran>('tableau-bord');
  const [mode, setMode] = useState<Mode>(modeInitial);
  const [barreRetractee, setBarreRetractee] = useState(false);
  /**
   * Filtre restaurant, tenu ICI et non dans chaque écran : il est commun à tous
   * les onglets et doit SURVIVRE au changement d'onglet — on suit un restaurant
   * du tableau de bord à ses clôtures sans le resélectionner à chaque fois.
   */
  const [filtreResto, setFiltreResto] = useState<FiltreResto>('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChargement(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  /**
   * Un compte Supabase valide ne suffit pas : il faut être inscrit dans
   * `siege_utilisateurs`. On le demande à la fonction dès la session ouverte,
   * pour afficher le refus tout de suite plutôt qu'à chaque écran.
   */
  useEffect(() => {
    if (!session) {
      setSiege(null);
      setRefus(null);
      return;
    }
    appelSiege<Siege>('moi', { connexion: true })
      .then((s) => {
        setSiege(s);
        setRefus(null);
      })
      .catch((e: unknown) => {
        setSiege(null);
        setRefus(e instanceof ErreurSiege ? e.message : 'Vérification impossible');
      });
  }, [session]);

  const basculerMode = () => {
    const suivant: Mode = mode === 'sombre' ? 'clair' : 'sombre';
    setMode(suivant);
    poserMode(suivant);
  };

  if (chargement) {
    return <div className="flex h-full items-center justify-center bg-vitrine-fond text-vitrine-txt-doux">Ouverture de la console…</div>;
  }

  if (!session) return <Connexion mode={mode} onBasculerMode={basculerMode} />;

  // Connecté chez Supabase, mais pas autorisé au siège : on le dit en clair, et
  // on ne laisse que la sortie — les écrans répondraient 403 de toute façon.
  if (refus) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-vitrine-fond px-6 text-center">
        <p className="max-w-md text-lg font-semibold text-vitrine-txt">{refus}</p>
        <p className="max-w-md text-vitrine-txt-doux">
          Un compte de connexion ne suffit pas : il doit être inscrit dans <code>siege_utilisateurs</code>,
          avec le niveau ADMIN ou LECTURE.
        </p>
        <button type="button" className="btn-blanc" onClick={() => void supabase.auth.signOut()}>
          Se déconnecter
        </button>
      </div>
    );
  }

  if (!siege) {
    return <div className="flex h-full items-center justify-center bg-vitrine-fond text-vitrine-txt-doux">Vérification du compte…</div>;
  }

  return (
    <div className="flex h-full flex-col">
      {/* ---------- Barre ardoise (DESIGN_V2 § 6.12) ---------- */}
      <header className="flex h-[62px] flex-none items-center justify-between border-b border-ard-700 bg-ard-900 px-4 text-ard-txt">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setBarreRetractee((retractee) => !retractee)}
            title={barreRetractee ? 'Déployer la barre de navigation' : 'Rétracter la barre de navigation'}
            aria-label={barreRetractee ? 'Déployer la barre de navigation' : 'Rétracter la barre de navigation'}
            className="flex h-10 w-10 flex-none items-center justify-center rounded-btn text-ard-txt-doux transition hover:bg-ard-750 hover:text-ard-txt"
          >
            {barreRetractee ? <IconLayoutSidebarLeftExpand size={19} /> : <IconLayoutSidebarLeftCollapse size={19} />}
          </button>
          <div className="min-w-0">
            <div className="truncate text-[17px] font-semibold tracking-tight">Console du siège</div>
            <div className="truncate text-[12.5px] font-medium text-ard-txt-doux">
              {siege.nomComplet} · {siege.niveau === 'ADMIN' ? 'Administrateur' : 'Lecture seule'}
            </div>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <button
            type="button"
            onClick={basculerMode}
            title={mode === 'sombre' ? 'Passer en clair' : 'Passer en sombre'}
            className="flex h-10 w-10 items-center justify-center rounded-btn text-ard-txt-doux transition hover:bg-ard-750 hover:text-ard-txt"
          >
            {mode === 'sombre' ? <IconSun size={19} /> : <IconMoon size={19} />}
          </button>
          <button
            type="button"
            onClick={() => void supabase.auth.signOut()}
            className="flex items-center gap-2 rounded-btn px-3 py-2 font-semibold text-ard-txt-doux transition hover:bg-ard-750 hover:text-ard-txt"
          >
            <IconLogout size={19} />
            Se déconnecter
          </button>
        </div>
      </header>

      <div className={`grid min-h-0 flex-1 ${barreRetractee ? 'grid-cols-[64px_1fr]' : 'grid-cols-[214px_1fr]'}`}>
        {/* Colonne des écrans, en ardoise — même ossature que la caisse. */}
        <nav className={`flex flex-col overflow-y-auto border-r border-ard-700 bg-ard-800 p-2.5 ${barreRetractee ? 'items-center' : ''}`}>
          {SECTIONS.map((s) => {
            const actif = s.cle === ecran;
            return (
              <button
                key={s.cle}
                type="button"
                onClick={() => setEcran(s.cle)}
                title={barreRetractee ? s.libelle : undefined}
                className={`relative flex items-center rounded-btn py-3 text-left text-[14.5px] font-semibold leading-tight transition ${
                  barreRetractee ? 'w-10 justify-center px-0' : 'w-full pl-3.5 pr-3'
                } ${
                  actif ? 'bg-ard-700 text-ard-txt' : 'text-ard-txt-doux hover:bg-ard-750 hover:text-ard-txt'
                }`}
              >
                {actif && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-marque" />}
                {!barreRetractee && <span className="truncate">{s.libelle}</span>}
              </button>
            );
          })}
        </nav>

        {/* Zone de travail — plan CLAIR */}
        <main className="min-w-0 overflow-y-auto bg-plan p-6">
          {ecran === 'tableau-bord' && <TableauBord filtre={filtreResto} onFiltre={setFiltreResto} />}
          {ecran === 'clotures' && <Clotures filtre={filtreResto} onFiltre={setFiltreResto} />}
          {ecran === 'inventaire' && <Inventaire siege={siege} filtre={filtreResto} onFiltre={setFiltreResto} />}
          {ecran === 'recettes-inventaire' && <RecettesInventaire siege={siege} filtre={filtreResto} />}
          {ecran === 'sequences' && <Sequences filtre={filtreResto} onFiltre={setFiltreResto} />}
          {ecran === 'menu' && <Menu filtre={filtreResto} onFiltre={setFiltreResto} />}
          {ecran === 'categories' && <Categories filtre={filtreResto} onFiltre={setFiltreResto} />}
          {ecran === 'equipe' && <Equipe filtre={filtreResto} onFiltre={setFiltreResto} />}
          {ecran === 'parametres' && <Parametres filtre={filtreResto} onFiltre={setFiltreResto} />}
        </main>
      </div>
    </div>
  );
}
