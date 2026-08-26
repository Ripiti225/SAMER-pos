import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  IconBuildingStore,
  IconCash,
  IconChartBar,
  IconLogout,
  IconMoon,
  IconReceipt,
  IconSun,
  IconToolsKitchen2,
  IconUsers,
} from '@tabler/icons-react';
import { appeler, configureeCorrectement, seDeconnecter, sessionOuverte, type Moi } from './api';
import { Login } from './screens/Login';
import { TableauBord } from './screens/TableauBord';
import { Clotures } from './screens/Clotures';
import { Equipe } from './screens/Equipe';

type Section = 'tableau' | 'clotures' | 'equipe' | 'depenses' | 'catalogue';

const SECTIONS: { cle: Section; libelle: string; icone: typeof IconChartBar; pret: boolean }[] = [
  { cle: 'tableau', libelle: 'Tableau de bord', icone: IconChartBar, pret: true },
  { cle: 'clotures', libelle: 'Clôtures & écarts', icone: IconCash, pret: true },
  { cle: 'equipe', libelle: 'Équipe', icone: IconUsers, pret: true },
  { cle: 'depenses', libelle: 'Dépenses & inventaire', icone: IconReceipt, pret: false },
  { cle: 'catalogue', libelle: 'Catalogue', icone: IconToolsKitchen2, pret: false },
];

function BasculeMode(): JSX.Element {
  const [sombre, setSombre] = useState(document.documentElement.dataset.mode === 'sombre');
  const basculer = (): void => {
    const neuf = !sombre;
    setSombre(neuf);
    if (neuf) document.documentElement.dataset.mode = 'sombre';
    else delete document.documentElement.dataset.mode;
    localStorage.setItem('siege.mode', neuf ? 'sombre' : 'clair');
  };
  return (
    <button className="nav-siege" onClick={basculer} title="Changer le mode d'affichage">
      {sombre ? <IconSun size={20} /> : <IconMoon size={20} />}
      <span>{sombre ? 'Mode clair' : 'Mode sombre'}</span>
    </button>
  );
}

/** Écran affiché quand le fichier `.env` n'a pas été rempli — cas du premier lancement. */
function ConfigManquante(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-vitrine-fond p-8">
      <div className="carte max-w-lg space-y-3 p-8">
        <h1 className="text-xl font-bold text-fort">Console non configurée</h1>
        <p className="text-doux">
          L'adresse du cloud et la clé publique manquent. Copiez le fichier{' '}
          <code className="rounded bg-surface-douce px-1.5 py-0.5 text-sm">.env.exemple</code> en{' '}
          <code className="rounded bg-surface-douce px-1.5 py-0.5 text-sm">.env</code> dans{' '}
          <code className="rounded bg-surface-douce px-1.5 py-0.5 text-sm">apps/siege</code>, complétez la clé,
          puis relancez.
        </p>
      </div>
    </div>
  );
}

export function App(): JSX.Element {
  const [connecte, setConnecte] = useState(sessionOuverte());
  const [section, setSection] = useState<Section>('tableau');

  const moi = useQuery({
    queryKey: ['moi'],
    queryFn: () => appeler<Moi>('moi', { connexion: true }),
    enabled: connecte,
    retry: false,
    refetchInterval: false,
  });

  if (!configureeCorrectement) return <ConfigManquante />;
  if (!connecte) return <Login surConnexion={() => setConnecte(true)} />;

  // Le compte existe côté Supabase Auth mais n'est pas autorisé dans
  // `siege_utilisateurs` (ou la session est morte) : on renvoie à la connexion
  // avec le motif, plutôt que de laisser une console vide et muette.
  if (moi.isError) {
    return (
      <Login
        surConnexion={() => {
          setConnecte(true);
          void moi.refetch();
        }}
        motif={(moi.error as Error).message}
      />
    );
  }

  const deconnecter = (): void => {
    seDeconnecter();
    setConnecte(false);
  };

  return (
    <div className="flex h-full">
      {/* Colonne d'ossature — identique en clair et en sombre, c'est l'identité
          du design v2. */}
      <aside className="ossature flex w-[248px] flex-none flex-col gap-1 p-4">
        <div className="mb-5 flex items-center gap-3 px-2 pt-1">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-jeton"
            style={{ background: 'var(--marque)', color: 'var(--sur-marque)' }}
          >
            <IconBuildingStore size={22} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-bold text-ard-txt">Siège</div>
            <div className="truncate text-xs text-ard-txt-faible">Chez Samer / Al Kayan</div>
          </div>
        </div>

        {SECTIONS.map((s) => (
          <button
            key={s.cle}
            className="nav-siege"
            aria-current={section === s.cle ? 'page' : undefined}
            disabled={!s.pret}
            onClick={() => setSection(s.cle)}
            title={s.pret ? undefined : 'Bientôt disponible'}
          >
            <s.icone size={20} />
            <span className="flex-1">{s.libelle}</span>
            {!s.pret && <span className="text-[11px] font-medium uppercase">à venir</span>}
          </button>
        ))}

        <div className="flex-1" />

        <div className="mb-1 px-3 py-2">
          <div className="truncate text-sm font-semibold text-ard-txt">{moi.data?.nomComplet ?? '…'}</div>
          <div className="text-xs text-ard-txt-faible">
            {moi.data?.niveau === 'ADMIN' ? 'Administrateur' : 'Lecture seule'}
          </div>
        </div>
        <BasculeMode />
        <button className="nav-siege" onClick={deconnecter}>
          <IconLogout size={20} />
          <span>Se déconnecter</span>
        </button>
      </aside>

      {/* Plan de travail */}
      <main className="min-w-0 flex-1 overflow-y-auto bg-plan">
        {section === 'tableau' && <TableauBord />}
        {section === 'clotures' && <Clotures />}
        {section === 'equipe' && <Equipe />}
      </main>
    </div>
  );
}
