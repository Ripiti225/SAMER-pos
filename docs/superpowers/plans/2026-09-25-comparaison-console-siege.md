# Comparaison A / B + période personnalisée — console du siège

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner au tableau de bord de la console du siège un sélecteur de dates libres et une comparaison A / B à deux modes (deux restaurants sur une période, ou un restaurant sur deux périodes), sans toucher au cloud.

**Architecture:** La dérivation des données sort de `TableauBord.tsx` vers deux modules purs (`bord.ts`, `comparaison.ts`), testables sans React. Les blocs de présentation deviennent des composants qui reçoivent une `VueBord` et ne savent rien de la comparaison : la colonne unique et les colonnes A / B sont strictement le même code. Aucune nouvelle RPC — le mode « 2 restaurants » dérive deux vues de la même charge utile, le mode « 2 périodes » rejoue l'action `tableau_bord` sur les bornes précédentes.

**Tech Stack:** React 18 + TypeScript strict, Vite, TanStack Query, Tailwind, Vitest (ajouté à `apps/siege` par ce plan).

## Global Constraints

- **Spéc de référence** : `docs/superpowers/specs/2026-09-25-comparaison-console-siege-design.md`. En cas de doute, elle fait foi.
- **Français partout** : interface, libellés, messages d'erreur, commentaires, messages de commit. Jamais de code technique à l'écran (« Ce PIN est bloqué 30 secondes », pas « 429 »).
- **Montants en FCFA entiers.** Jamais de float, jamais de centimes. `formatFCFA` vient de `@pos/shared`.
- **TypeScript strict** avec `noUncheckedIndexedAccess` (voir `tsconfig.base.json`) : tout accès indexé rend `T | undefined`, il faut le traiter.
- **Interdiction absolue de modifier** `supabase/functions/siege/index.ts`, les fonctions SQL `siege_*`, ou quoi que ce soit hors de `apps/siege/`. Ce plan ne touche pas au cloud.
- **Abidjan est à UTC+0** toute l'année : un jour civil est un jour UTC. Aucun décalage à gérer, c'est déjà l'hypothèse de `periode.ts` et des RPC.
- **`fin` est EXCLUE** côté cloud (`< p_fin`). Une période « jusqu'au 31 octobre inclus » s'envoie avec `fin` au 1er novembre à minuit UTC.
- **La couleur ne porte jamais l'information seule** : une flèche, un signe ou un libellé la redisent toujours (règle du validateur de palette, déjà appliquée dans `Chiffre.tsx` et `Graphes.tsx`).
- **Commits conventionnels en français** : `feat(siege): écran de comparaison A/B`. Terminer chaque message par la ligne `Co-Authored-By:` **que ton propre rappel système te donne** — elle doit nommer le modèle qui a réellement écrit le commit. Le `Claude Opus 5` écrit dans les blocs de commit des tâches est un exemple, pas une valeur à recopier si ton rappel en indique un autre.
- **Ne jamais committer** autre chose que les fichiers de la tâche en cours : le dépôt porte d'autres modifications en cours (`apps/siege/src/components/TicketZ.tsx`, `supabase/functions/`), qui ne sont pas à nous.

## Structure des fichiers

| Fichier | Responsabilité | Tâche |
|---|---|---|
| `apps/siege/package.json` | + `vitest` et le script `test` | 1 |
| `apps/siege/src/periode.ts` | **modifié** — + `personnalisee()`, les refus et le libellé de plage | 1 |
| `apps/siege/src/periode.test.ts` | **créé** — bornes, refus, libellés | 1 |
| `apps/siege/src/components/SelecteurPeriode.tsx` | **modifié** — la chip « Personnalisée » et ses deux champs | 2 |
| `apps/siege/src/bord.ts` | **créé** — `VueBord` et `vueBord()`, pure, toute la dérivation | 3 |
| `apps/siege/src/bord.test.ts` | **créé** — filtrage, cumuls, blocs absents | 3 |
|`apps/siege/src/components/Graphes.tsx` | **modifié** — `max?` sur trois composants | 4 |
|`apps/siege/src/components/Chiffre.tsx` | **modifié** — l'écart absolu à côté du pourcentage | 4 |
|`apps/siege/src/components/BlocsBord.tsx` | **créé** — les blocs de présentation, un `VueBord` en entrée | 5 |
|`apps/siege/src/screens/TableauBord.tsx` | **modifié** — orchestration seule | 5, 7 |
| `apps/siege/src/comparaison.ts` | **créé** — `ecarts()` et `synthese()`, pures | 6 |
| `apps/siege/src/comparaison.test.ts` | **créé** — polarité, zéro, non enrôlé | 6 |
| `apps/siege/src/components/BarreComparaison.tsx` | **créé** — le mode et les sélecteurs A / B | 7 |
| `apps/siege/src/components/Synthese.tsx` | **créé** — la bande de verdict | 7 |

---

### Task 1: Vitest dans `apps/siege` + la période personnalisée

**Files:**
- Modify: `apps/siege/package.json`
- Modify: `apps/siege/src/periode.ts`
- Test: `apps/siege/src/periode.test.ts` (créé)

**Interfaces:**
- Consumes: `Periode` (déjà exporté par `periode.ts`), `jour` (constante locale `86_400_000`).
- Produces:
  - `DUREE_MAX_JOURS: 366`
  - `type RefusPeriode = 'incomplete' | 'inversee' | 'trop_longue'`
  - `MESSAGES_REFUS: Record<RefusPeriode, string>`
  - `type ResultatPeriode = { ok: true; periode: Periode } | { ok: false; refus: RefusPeriode }`
  - `personnalisee(du: string, au: string, maintenant?: Date): ResultatPeriode`

- [ ] **Step 1: Ajouter Vitest au paquet**

Dans `apps/siege/package.json`, remplacer `"test": "exit 0"` par `"test": "vitest run"`, et ajouter `"vitest": "^3.2.4"` dans `devDependencies` (même version que `apps/server`, seul autre paquet qui teste).

```bash
cd /Users/macbookpro/pos-samer && pnpm install
```

Aucun `vitest.config.ts` n'est nécessaire : les modules testés ici sont purs, l'environnement `node` par défaut suffit. Les tests importent explicitement (`import { describe, it, expect } from 'vitest'`), donc pas de `globals` ni de changement de `tsconfig.json`.

- [ ] **Step 2: Écrire le test qui échoue**

Créer `apps/siege/src/periode.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { DUREE_MAX_JOURS, personnalisee } from './periode';

/**
 * `fin` est EXCLUE côté cloud (`< p_fin`). Une plage « jusqu'au 31 octobre »
 * doit donc s'envoyer avec `fin` au 1er novembre : sinon le 31 octobre entier
 * disparaît du rapport, et personne ne s'en aperçoit avant la clôture du mois.
 */
describe('personnalisee — les bornes envoyées au cloud', () => {
  it('inclut le dernier jour saisi : fin = minuit du lendemain, en UTC', () => {
    const r = personnalisee('2025-10-01', '2025-10-31');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.debut).toBe('2025-10-01T00:00:00.000Z');
    expect(r.periode.fin).toBe('2025-11-01T00:00:00.000Z');
  });

  it('accepte une plage d’un seul jour', () => {
    const r = personnalisee('2025-10-07', '2025-10-07');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.debut).toBe('2025-10-07T00:00:00.000Z');
    expect(r.periode.fin).toBe('2025-10-08T00:00:00.000Z');
  });

  it('porte la clé « perso », qui n’est pas une chip relative', () => {
    const r = personnalisee('2025-10-01', '2025-10-31');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.cle).toBe('perso');
  });
});

describe('personnalisee — les refus', () => {
  it('refuse une plage incomplète', () => {
    expect(personnalisee('', '2025-10-31')).toEqual({ ok: false, refus: 'incomplete' });
    expect(personnalisee('2025-10-01', '')).toEqual({ ok: false, refus: 'incomplete' });
  });

  it('refuse un début postérieur à la fin', () => {
    expect(personnalisee('2025-10-31', '2025-10-01')).toEqual({ ok: false, refus: 'inversee' });
  });

  it('accepte exactement 366 jours et refuse le 367e', () => {
    const debut = new Date(Date.UTC(2024, 0, 1));
    const finOk = new Date(debut.getTime() + (DUREE_MAX_JOURS - 1) * 86_400_000);
    const finTrop = new Date(debut.getTime() + DUREE_MAX_JOURS * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    expect(personnalisee(iso(debut), iso(finOk)).ok).toBe(true);
    expect(personnalisee(iso(debut), iso(finTrop))).toEqual({ ok: false, refus: 'trop_longue' });
  });
});

/**
 * Le libellé est ce que le siège lit dans le bandeau et dans l'en-tête d'une
 * colonne de comparaison. Il écrit les vraies dates, et n'encombre pas d'une
 * année quand c'est l'année en cours.
 */
describe('personnalisee — le libellé', () => {
  const enOctobre2025 = new Date('2025-10-15T10:00:00.000Z');

  it('même mois, année en cours : « 1 → 31 oct. »', () => {
    const r = personnalisee('2025-10-01', '2025-10-31', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 → 31 oct.');
  });

  it('mois différents, année en cours : « 1 oct. → 15 nov. »', () => {
    const r = personnalisee('2025-10-01', '2025-11-15', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 oct. → 15 nov.');
  });

  it('année passée : l’année est écrite', () => {
    const r = personnalisee('2024-10-01', '2024-10-31', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 → 31 oct. 2024');
  });

  it('deux années différentes : chaque borne porte la sienne', () => {
    const r = personnalisee('2024-12-20', '2025-01-10', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('20 déc. 2024 → 10 janv. 2025');
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier qu'il échoue**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege test`
Expected: ÉCHEC — `personnalisee` et `DUREE_MAX_JOURS` ne sont pas exportés par `./periode`.

- [ ] **Step 4: Écrire l'implémentation**

Ajouter à la fin de `apps/siege/src/periode.ts` :

```ts
/**
 * Plage maximale d'une période saisie à la main.
 *
 * La console agrège ligne à ligne côté navigateur : au-delà d'un an, la
 * requête devient longue pour une lecture que personne ne fait. 366 et non
 * 365, pour qu'une année bissextile entière passe.
 */
export const DUREE_MAX_JOURS = 366;

/** Ce qui cloche dans une plage saisie. */
export type RefusPeriode = 'incomplete' | 'inversee' | 'trop_longue';

/** Le message montré sous les champs — français courant, jamais un code. */
export const MESSAGES_REFUS: Record<RefusPeriode, string> = {
  incomplete: 'Choisissez une date de début et une date de fin.',
  inversee: 'La date de début est après la date de fin.',
  trop_longue: 'Choisissez une plage d’un an au maximum.',
};

/**
 * Un refus n'est pas une exception : l'appelant est un champ de formulaire,
 * il affiche le message et attend la frappe suivante. Rien à rattraper.
 */
export type ResultatPeriode = { ok: true; periode: Periode } | { ok: false; refus: RefusPeriode };

/** « 31 oct. » ou « 31 oct. 2024 » — l'année seulement si ce n'est pas celle en cours. */
function jourMois(iso: string, avecAnnee: boolean): string {
  return new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    ...(avecAnnee ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

/**
 * Libellé d'une plage, écrit comme on le dirait : « 1 → 31 oct. » quand le
 * mois est le même, « 1 oct. → 15 nov. » sinon. L'année n'apparaît que si
 * elle n'est pas l'année en cours — sinon elle encombre chaque bandeau.
 */
function libellePlage(du: string, au: string, maintenant: Date): string {
  const d = new Date(`${du}T00:00:00.000Z`);
  const a = new Date(`${au}T00:00:00.000Z`);
  const anneeCourante = maintenant.getUTCFullYear();
  const memeAnnee = d.getUTCFullYear() === a.getUTCFullYear();
  const ecrireAnnee = !memeAnnee || d.getUTCFullYear() !== anneeCourante;

  if (memeAnnee && d.getUTCMonth() === a.getUTCMonth()) {
    return `${d.getUTCDate()} → ${jourMois(a.toISOString(), ecrireAnnee)}`;
  }
  return `${jourMois(d.toISOString(), !memeAnnee)} → ${jourMois(a.toISOString(), ecrireAnnee)}`;
}

/**
 * Une plage saisie à la main. `du` et `au` sont des 'YYYY-MM-DD' INCLUSIFS :
 * « du 1er au 31 octobre » contient le 31 octobre en entier. `fin` étant
 * EXCLUE côté cloud, on va jusqu'à minuit le lendemain.
 */
export function personnalisee(du: string, au: string, maintenant = new Date()): ResultatPeriode {
  if (!du || !au) return { ok: false, refus: 'incomplete' };
  if (du > au) return { ok: false, refus: 'inversee' };

  const debut = new Date(`${du}T00:00:00.000Z`);
  const derniereJournee = new Date(`${au}T00:00:00.000Z`);
  const jours = Math.round((derniereJournee.getTime() - debut.getTime()) / jour) + 1;
  if (jours > DUREE_MAX_JOURS) return { ok: false, refus: 'trop_longue' };

  return {
    ok: true,
    periode: {
      cle: 'perso',
      libelle: libellePlage(du, au, maintenant),
      debut: debut.toISOString(),
      fin: new Date(derniereJournee.getTime() + jour).toISOString(),
    },
  };
}
```

- [ ] **Step 5: Lancer les tests pour vérifier qu'ils passent**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege test`
Expected: PASS — 10 tests verts.

Si `libellePlage` rend « 1 → 31 oct. 2024 » là où le test attend « 1 → 31 oct. », vérifier que `maintenant` est bien passé jusqu'au bout : c'est le seul paramètre qui décide d'écrire l'année.

- [ ] **Step 6: Vérifier la compilation stricte**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege build`
Expected: aucune erreur TypeScript.

- [ ] **Step 7: Commit**

```bash
cd /Users/macbookpro/pos-samer
git add apps/siege/package.json apps/siege/src/periode.ts apps/siege/src/periode.test.ts pnpm-lock.yaml
git commit -m "$(cat <<'MSG'
feat(siege): période personnalisée dans periode.ts + Vitest

Les cinq chips ne remontaient pas au-delà de 30 jours : les chiffres
d'octobre étaient inaccessibles en février. `personnalisee()` rend une
période aux bornes libres, en traitant le piège de la borne de fin — elle
est EXCLUE côté cloud, une plage « jusqu'au 31 octobre » s'envoie donc au
1er novembre.

apps/siege n'avait pas de runner ; Vitest y entre, comme dans apps/server.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: La chip « Personnalisée » dans le sélecteur de période

Cette tâche livre à elle seule la demande explicite : lire octobre depuis la console. `SelecteurPeriode` étant partagé, l'onglet **Clôtures** en hérite sans une ligne de plus.

**Files:**
- Modify: `apps/siege/src/components/SelecteurPeriode.tsx`
- Vérifier (sans modifier) : `apps/siege/src/screens/TableauBord.tsx:221`, `apps/siege/src/screens/Clotures.tsx:48`

**Interfaces:**
- Consumes: `listePeriodes()`, `Periode`, `personnalisee()`, `MESSAGES_REFUS`, `RefusPeriode` (Task 1).
- Produces: aucun nouvel export. La signature du composant ne change pas — `{ valeur: Periode; onChoisir: (p: Periode) => void }` — donc les deux écrans appelants n'ont rien à modifier.

- [ ] **Step 1: Réécrire le composant**

Remplacer tout le contenu de `apps/siege/src/components/SelecteurPeriode.tsx` :

```tsx
import { useState } from 'react';
import { listePeriodes, MESSAGES_REFUS, personnalisee, type Periode, type RefusPeriode } from '../periode';

/**
 * Les cinq périodes en chips, plus une sixième qui ouvre deux dates libres.
 *
 * Un seul geste pour le courant, un calendrier seulement quand on le demande :
 * les cinq chips couvrent ce qu'on regarde tous les jours, mais elles ne
 * remontent pas au-delà de 30 jours. Sans la sixième, les chiffres d'octobre
 * sont inaccessibles en février.
 *
 * Le composant garde la signature qu'il avait : les écrans appelants ne
 * changent pas, et Clôtures hérite de la plage libre sans une ligne de plus.
 */
export function SelecteurPeriode({ valeur, onChoisir }: { valeur: Periode; onChoisir: (p: Periode) => void }) {
  const [ouvert, setOuvert] = useState(false);
  const [du, setDu] = useState('');
  const [au, setAu] = useState('');
  const [refus, setRefus] = useState<RefusPeriode | null>(null);

  const perso = valeur.cle === 'perso';

  /** Chaque frappe retente : on n'attend pas un bouton pour dire ce qui cloche. */
  const tenter = (nouveauDu: string, nouveauAu: string) => {
    setDu(nouveauDu);
    setAu(nouveauAu);
    const r = personnalisee(nouveauDu, nouveauAu);
    if (r.ok) {
      setRefus(null);
      onChoisir(r.periode);
    } else {
      // « incomplète » n'est pas une faute : c'est l'état normal entre les
      // deux frappes. On ne le montre pas en rouge.
      setRefus(r.refus === 'incomplete' ? null : r.refus);
    }
  };

  const classeChip = (actif: boolean) =>
    `min-h-[40px] rounded-btn border px-4 text-sm font-semibold transition ${
      actif
        ? 'border-marque bg-marque text-sur-marque'
        : 'border-filet bg-carte text-doux hover:border-marque hover:text-txt'
    }`;

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {listePeriodes().map((p) => (
          <button
            key={p.cle}
            type="button"
            onClick={() => {
              // Une chip relative reprend la main : le panneau personnalisé
              // repart à blanc. Sans ça, le rouvrir ressusciterait le message
              // d'erreur et les dates de la saisie précédente, alors que
              // l'utilisateur n'a rien retapé.
              setOuvert(false);
              setDu('');
              setAu('');
              setRefus(null);
              onChoisir(p);
            }}
            className={classeChip(p.cle === valeur.cle)}
          >
            {p.libelle}
          </button>
        ))}

        <button
          type="button"
          onClick={() => setOuvert((o) => !o)}
          className={classeChip(perso)}
          aria-expanded={ouvert}
        >
          {perso ? valeur.libelle : 'Personnalisée'}
        </button>
      </div>

      {ouvert && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-jeton border border-filet bg-carte p-3">
          <label className="flex items-center gap-2 text-sm font-semibold text-doux">
            Du
            <input
              type="date"
              className="champ !min-h-[40px] !w-auto !py-0 !text-[15px]"
              value={du}
              onChange={(e) => tenter(e.target.value, au)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm font-semibold text-doux">
            au
            <input
              type="date"
              className="champ !min-h-[40px] !w-auto !py-0 !text-[15px]"
              value={au}
              onChange={(e) => tenter(du, e.target.value)}
            />
          </label>
          {refus && <p className="text-sm font-semibold text-alerte-txt">{MESSAGES_REFUS[refus]}</p>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Vérifier la compilation**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege build`
Expected: aucune erreur TypeScript.

- [ ] **Step 3: Vérifier à l'écran**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege dev`

Dans le navigateur, sur **Tableau de bord** :
1. Cliquer « Personnalisée » → les deux champs apparaissent.
2. Saisir `01/10/2025` puis `31/10/2025` → la chip affiche « 1 → 31 oct. 2025 » et les chiffres d'octobre 2025 s'affichent.
3. Saisir une fin antérieure au début → « La date de début est après la date de fin. » en rouge, les chiffres ne bougent pas.
4. Saisir une plage de plus d'un an → « Choisissez une plage d'un an au maximum. »
5. Recliquer « 7 derniers jours » → la chip redevient « Personnalisée », l'écran repasse sur 7 jours.

Puis sur **Clôtures** : refaire l'étape 2. Les clôtures d'octobre 2025 doivent s'afficher sans qu'une ligne de cet écran ait été touchée.

- [ ] **Step 4: Commit**

```bash
cd /Users/macbookpro/pos-samer
git add apps/siege/src/components/SelecteurPeriode.tsx
git commit -m "$(cat <<'MSG'
feat(siege): chip « Personnalisée » avec deux dates libres

Posée sur le SelecteurPeriode partagé, donc le tableau de bord ET les
clôtures y gagnent sans qu'une ligne de ces écrans change : la signature du
composant est la même.

Les refus s'écrivent en français courant sous les champs, et « incomplète »
ne s'affiche jamais — c'est l'état normal entre les deux frappes, pas une
faute.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---
### Task 3: `bord.ts` — toute la dérivation, pure et testable

`TableauBord.tsx` fait ~450 lignes où la dérivation et le rendu sont entrelacés dans une vingtaine de `useMemo`. Cette tâche les sort **sans changer un seul comportement** : aucun fichier de rendu n'est touché, l'écran n'est pas censé bouger. C'est la tâche qui rend la comparaison possible sans dupliquer 200 lignes.

**Files:**
- Create: `apps/siege/src/bord.ts`
- Test: `apps/siege/src/bord.test.ts`
- Ne PAS modifier `TableauBord.tsx` dans cette tâche (c'est la tâche 4).

**Interfaces:**
- Consumes: `Bord`, `RestoGroupe` (`./api`), `jourCourt` (`./periode`), `LIBELLES_MODES`, `LIBELLES_TYPES_COMMANDE`, `libellePartenaire` (`@pos/shared`).
- Produces:
  - `interface LigneBarre { cle: string; libelle: string; valeur: number; detail?: string; couleur?: string }`
  - `interface ContexteVue { restaurantId: string | null; nom: string; enrole: boolean; noms: Map<string, string> }`
  - `interface VueBord` (voir Step 2)
  - `function vueBord(data: Bord | undefined, ctx: ContexteVue): VueBord`
  - `const COULEUR_MODE: Record<string, string>` (déplacé depuis `TableauBord.tsx`)
  - `function nb(v: unknown): number` (déplacé depuis `TableauBord.tsx`)

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/siege/src/bord.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { vueBord, type ContexteVue } from './bord';
import type { Bord } from './api';

const ANGRE = '11111111-1111-1111-1111-111111111111';
const RIVIERA = '22222222-2222-2222-2222-222222222222';

const NOMS = new Map([
  [ANGRE, 'Angré'],
  [RIVIERA, 'Riviera'],
]);

/** Le contexte d'une vue « un restaurant », le cas le plus courant. */
function ctx(restaurantId: string | null, nom = 'Angré', enrole = true): ContexteVue {
  return { restaurantId, nom, enrole, noms: NOMS };
}

/**
 * Une charge utile minimale mais RÉALISTE : deux restaurants, pour que le
 * filtrage ait quelque chose à filtrer. Les blocs non renseignés partent
 * vides — c'est exactement ce que fait la fonction `siege` quand une
 * migration n'est pas passée.
 */
function charge(partiel: Partial<Bord> = {}): Bord {
  return {
    periode: { debut: '2025-10-01T00:00:00.000Z', fin: '2025-10-08T00:00:00.000Z', debut_precedent: '2025-09-24T00:00:00.000Z' },
    total: 0,
    total_precedent: 0,
    restaurants: [],
    tendance: [],
    heures: [],
    plats: [],
    modes: [],
    types: [],
    tables: [],
    retours: [],
    depenses: [],
    ecarts: [],
    equipe: [],
    remises: [],
    annulations: [],
    inventaire: [],
    livraisons: [],
    absents: [],
    aucun_site_enrole: false,
    salle_non_publiee: false,
    ...partiel,
  };
}

describe('vueBord — le filtrage par restaurant', () => {
  it('ne garde que les lignes du restaurant demandé', () => {
    const d = charge({
      plats: [
        { restaurant_id: ANGRE, nom: 'Chawarma', quantite: 10, total: 30_000 },
        { restaurant_id: RIVIERA, nom: 'Pizza', quantite: 4, total: 26_000 },
      ],
    });

    const a = vueBord(d, ctx(ANGRE));
    expect(a.plats.map((p) => p.libelle)).toEqual(['Chawarma']);

    const b = vueBord(d, ctx(RIVIERA, 'Riviera'));
    expect(b.plats.map((p) => p.libelle)).toEqual(['Pizza']);
  });

  it('restaurantId à null garde tout le groupe et cumule', () => {
    const d = charge({
      plats: [
        { restaurant_id: ANGRE, nom: 'Chawarma', quantite: 10, total: 30_000 },
        { restaurant_id: RIVIERA, nom: 'Chawarma', quantite: 4, total: 12_000 },
      ],
    });

    const v = vueBord(d, ctx(null, 'Tous les restaurants'));
    expect(v.plats).toHaveLength(1);
    expect(v.plats[0]?.valeur).toBe(42_000);
    expect(v.plats[0]?.detail).toBe('× 14');
  });
});

describe('vueBord — les chiffres d’appel', () => {
  it('cumule le CA, les commandes et calcule le panier moyen', () => {
    const v = vueBord(
      charge({
        restaurants: [
          { restaurant_id: ANGRE, samtrackly_id: 'ANG', nom: 'Angré', marque: 'SAMER', enrole: true, nb_commandes: 4, ca: 12_000, nb_annulees: 0, remises: 0, panier_moyen: 3_000, ca_precedent: 10_000, nb_commandes_precedent: 5 },
        ],
      }),
      ctx(ANGRE),
    );

    expect(v.ca).toBe(12_000);
    expect(v.caPrecedent).toBe(10_000);
    expect(v.commandes).toBe(4);
    expect(v.panier).toBe(3_000);
  });

  it('panier moyen à zéro commande rend 0, jamais NaN ni Infinity', () => {
    const v = vueBord(charge(), ctx(ANGRE));
    expect(v.panier).toBe(0);
    expect(Number.isFinite(v.panier)).toBe(true);
  });
});

describe('vueBord — la robustesse', () => {
  it('une charge utile absente rend une vue vide, sans lever', () => {
    const v = vueBord(undefined, ctx(ANGRE));
    expect(v.ca).toBe(0);
    expect(v.plats).toEqual([]);
    expect(v.vide).toBe(true);
  });

  it('un bloc absent (migration pas passée) rend une liste vide, pas une exception', () => {
    const d = charge();
    // @ts-expect-error — on simule la réponse d'une fonction `siege` plus ancienne.
    delete d.livraisons;
    expect(() => vueBord(d, ctx(ANGRE))).not.toThrow();
    expect(vueBord(d, ctx(ANGRE)).livraisons).toEqual([]);
  });

  it('un site non enrôlé le dit, au lieu de laisser croire à une journée blanche', () => {
    const v = vueBord(charge(), ctx(ANGRE, 'Angré', false));
    expect(v.enrole).toBe(false);
    expect(v.ca).toBe(0);
  });
});

describe('vueBord — les agrégats par clé', () => {
  it('cumule les heures et les trie', () => {
    const d = charge({
      heures: [
        { restaurant_id: ANGRE, heure: 12, nb: 3, ca: 9_000 },
        { restaurant_id: ANGRE, heure: 19, nb: 8, ca: 24_000 },
        { restaurant_id: ANGRE, heure: 12, nb: 1, ca: 3_000 },
      ],
    });
    const v = vueBord(d, ctx(ANGRE));
    expect(v.heures).toEqual([
      { heure: 12, ca: 12_000, nb: 4 },
      { heure: 19, ca: 24_000, nb: 8 },
    ]);
  });

  it('les jours sortent triés par date croissante', () => {
    const d = charge({
      tendance: [
        { restaurant_id: ANGRE, jour: '2025-10-03', ca: 5_000, nb_commandes: 2 },
        { restaurant_id: ANGRE, jour: '2025-10-01', ca: 7_000, nb_commandes: 3 },
      ],
    });
    const v = vueBord(d, ctx(ANGRE));
    expect(v.pointsJour.map((p) => p.cle)).toEqual(['2025-10-01', '2025-10-03']);
    expect(v.pointsJour[0]?.valeurs[ANGRE]).toBe(7_000);
  });

  it('cumule l’équipe en heures et les salaires', () => {
    const d = charge({
      equipe: [
        { restaurant_id: ANGRE, utilisateur_id: 'u1', nom: 'Awa', poste: 'Caissière', nb_services: 3, minutes: 480, salaire: 15_000 },
        { restaurant_id: ANGRE, utilisateur_id: 'u2', nom: 'Koffi', poste: null, nb_services: 2, minutes: 240, salaire: 8_000 },
      ],
    });
    const v = vueBord(d, ctx(ANGRE));
    expect(v.heuresTravaillees).toBe(12);
    expect(v.salaires).toBe(23_000);
    expect(v.equipe[0]?.libelle).toBe('Awa');
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege test`
Expected: ÉCHEC — le module `./bord` n'existe pas.

- [ ] **Step 3: Écrire `bord.ts`**

Créer `apps/siege/src/bord.ts`. Le contenu reprend, **sans les modifier**, les corps des `useMemo` actuels de `TableauBord.tsx`. Correspondance exacte :

| Champ de `VueBord` | Source dans `TableauBord.tsx` |
|---|---|
| `ca`, `caPrecedent`, `commandes`, `commandesPrecedent`, `panier` | `total`, `totalPrec`, `commandes`, `commandesPrec`, `panier` |
| `depenses` | `depenses` |
| `retoursMontant`, `retoursNb`, `retours` | `retours`, `retoursMontant`, `retoursNb` + le bloc « Retours » |
| `ecartCumule`, `ecarts` | `ecartCumule` + le bloc « Écarts réconciliés par caissier » |
| `pointsJour` | `pointsJour` |
| `heures` | `heures` |
| `plats` | `plats` |
| `modes` | `modes` |
| `tables` | `tables` |
| `canaux` | `canaux` |
| `depensesCategories` | l'appel `cumul(mien(data?.depenses), …)` du bloc « Dépenses par catégorie » |
| `equipe`, `heuresTravaillees`, `salaires` | `equipe`, `heuresTotal`, `salaires` |
| `remises`, `annulations`, `inventaire`, `livraisons`, `totalLivraisons`, `absents` | les `mien(...)` correspondants |

```ts
import {
  LIBELLES_MODES,
  LIBELLES_TYPES_COMMANDE,
  libellePartenaire,
  type ModePaiement,
  type TypeCommande,
} from '@pos/shared';
import type { Bord } from './api';
import { jourCourt } from './periode';

/** Couleur d'opérateur, déjà définie par le thème — jamais réinventée ici. */
export const COULEUR_MODE: Record<string, string> = {
  ESPECES: 'var(--pay-especes)',
  WAVE: 'var(--pay-wave)',
  ORANGE_MONEY: 'var(--pay-orange)',
  MTN_MOMO: 'var(--pay-mtn)',
  MOOV_MONEY: 'var(--pay-moov)',
  CARTE: 'var(--pay-carte)',
  DJAMO: 'var(--pay-djamo)',
};

/** Un nombre qui vient du réseau n'est jamais sûr : NULL, texte, absent. */
export const nb = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Une ligne de `BarresHorizontales` ou `BarresEcarts`, déjà triée et coupée. */
export interface LigneBarre {
  cle: string;
  libelle: string;
  valeur: number;
  detail?: string;
  couleur?: string;
}

/**
 * Ce qu'il faut savoir pour dériver une vue, en plus de la charge utile.
 *
 * `noms` est passé plutôt que lu : `vueBord` reste PURE, ce qui est toute la
 * raison de son existence. Elle est testable sans React et sans réseau.
 */
export interface ContexteVue {
  /** Le restaurant regardé, ou `null` pour le groupe entier. */
  restaurantId: string | null;
  /** Son nom, pour les en-têtes et la synthèse. */
  nom: string;
  /** `false` = ce site ne synchronise pas : tout est à zéro POUR CETTE RAISON. */
  enrole: boolean;
  /** Nom de chaque restaurant, pour les détails de ligne en vue groupe. */
  noms: Map<string, string>;
}

/** Tout ce qu'une colonne du tableau de bord a besoin de savoir. Rien de plus. */
export interface VueBord {
  restaurantId: string | null;
  nom: string;
  enrole: boolean;
  /** Aucune vente sur la période — à distinguer d'un site non enrôlé. */
  vide: boolean;

  ca: number;
  caPrecedent: number;
  commandes: number;
  commandesPrecedent: number;
  panier: number;
  depenses: number;
  retoursMontant: number;
  retoursNb: number;
  ecartCumule: number;
  heuresTravaillees: number;
  salaires: number;

  pointsJour: { cle: string; libelle: string; valeurs: Record<string, number> }[];
  heures: { heure: number; ca: number; nb: number }[];

  plats: LigneBarre[];
  modes: LigneBarre[];
  tables: LigneBarre[];
  canaux: LigneBarre[];
  retours: LigneBarre[];
  depensesCategories: LigneBarre[];
  ecarts: LigneBarre[];
  equipe: LigneBarre[];

  remises: Bord['remises'];
  annulations: Bord['annulations'];
  inventaire: Bord['inventaire'];
  livraisons: Bord['livraisons'];
  totalLivraisons: { nb: number; contacts: number };
  absents: Bord['absents'];
}

/** Cumule des lignes par clé texte, puis trie et coupe. */
function cumul<T>(source: T[], cle: (l: T) => string, valeur: (l: T) => number, limite = 10): LigneBarre[] {
  const m = new Map<string, number>();
  for (const l of source) {
    const k = cle(l);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + valeur(l));
  }
  return [...m.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limite)
    .map(([k, v]) => ({ cle: k, libelle: k, valeur: v }));
}

export function vueBord(data: Bord | undefined, ctx: ContexteVue): VueBord {
  const { restaurantId, noms } = ctx;

  /** Filtre commun : toutes les lignes portent `restaurant_id`. */
  const mien = <T extends { restaurant_id: string }>(lignes: T[] | undefined): T[] =>
    (lignes ?? []).filter((l) => !restaurantId || l.restaurant_id === restaurantId);

  const lignesVentes = (data?.restaurants ?? []).filter(
    (r) => r.restaurant_id && (!restaurantId || r.restaurant_id === restaurantId),
  );

  const ca = lignesVentes.reduce((s, l) => s + nb(l.ca), 0);
  const caPrecedent = lignesVentes.reduce((s, l) => s + nb(l.ca_precedent), 0);
  const commandes = lignesVentes.reduce((s, l) => s + nb(l.nb_commandes), 0);
  const commandesPrecedent = lignesVentes.reduce((s, l) => s + nb(l.nb_commandes_precedent), 0);

  const retoursSource = mien(data?.retours);
  const livraisons = [...mien(data?.livraisons)].sort(
    (a, b) => nb(b.nb) - nb(b.contacts) - (nb(a.nb) - nb(a.contacts)) || nb(b.nb) - nb(a.nb),
  );

  // -- Les jours ----------------------------------------------------------
  const parJour = new Map<string, Record<string, number>>();
  for (const t of mien(data?.tendance)) {
    const j = String(t.jour);
    const seau = parJour.get(j) ?? {};
    seau[t.restaurant_id] = (seau[t.restaurant_id] ?? 0) + nb(t.ca);
    parJour.set(j, seau);
  }
  const pointsJour = [...parJour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([jour, valeurs]) => ({ cle: jour, libelle: jourCourt(jour), valeurs }));

  // -- Les heures ---------------------------------------------------------
  const parHeure = new Map<number, { heure: number; ca: number; nb: number }>();
  for (const h of mien(data?.heures)) {
    const k = nb(h.heure);
    const vu = parHeure.get(k) ?? { heure: k, ca: 0, nb: 0 };
    parHeure.set(k, { heure: k, ca: vu.ca + nb(h.ca), nb: vu.nb + nb(h.nb) });
  }
  const heures = [...parHeure.values()].sort((a, b) => a.heure - b.heure);

  // -- Les plats ----------------------------------------------------------
  const parPlat = new Map<string, { q: number; t: number }>();
  for (const p of mien(data?.plats)) {
    const vu = parPlat.get(p.nom) ?? { q: 0, t: 0 };
    parPlat.set(p.nom, { q: vu.q + nb(p.quantite), t: vu.t + nb(p.total) });
  }
  const plats = [...parPlat.entries()]
    .sort(([, a], [, b]) => b.q - a.q)
    .slice(0, 10)
    .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.t, detail: `× ${v.q}` }));

  // -- Les tables ---------------------------------------------------------
  const parTable = new Map<string, { nb: number; total: number }>();
  for (const t of mien(data?.tables)) {
    const nom = t.numero ? `${t.numero}${t.zone ? ` — ${t.zone}` : ''}` : 'Table inconnue';
    const vu = parTable.get(nom) ?? { nb: 0, total: 0 };
    parTable.set(nom, { nb: vu.nb + nb(t.nb), total: vu.total + nb(t.total) });
  }
  const tables = [...parTable.entries()]
    .sort(([, a], [, b]) => b.nb - a.nb)
    .slice(0, 10)
    .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.total, detail: `${v.nb} commande(s)` }));

  // -- Les canaux ---------------------------------------------------------
  const parCanal = new Map<string, { nb: number; total: number }>();
  for (const t of mien(data?.types)) {
    const nom = t.partenaire
      ? libellePartenaire(t.partenaire)
      : (LIBELLES_TYPES_COMMANDE[t.type as TypeCommande] ?? t.type);
    const vu = parCanal.get(nom) ?? { nb: 0, total: 0 };
    parCanal.set(nom, { nb: vu.nb + nb(t.nb), total: vu.total + nb(t.total) });
  }
  const canaux = [...parCanal.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([nom, v]) => ({ cle: nom, libelle: nom, valeur: v.total, detail: `${v.nb} commande(s)` }));

  // -- L'équipe -----------------------------------------------------------
  const equipeSource = mien(data?.equipe)
    .map((e) => ({ ...e, heures: nb(e.minutes) / 60 }))
    .sort((a, b) => b.heures - a.heures);

  return {
    restaurantId,
    nom: ctx.nom,
    enrole: ctx.enrole,
    vide: ca === 0 && commandes === 0,

    ca,
    caPrecedent,
    commandes,
    commandesPrecedent,
    panier: commandes > 0 ? Math.round(ca / commandes) : 0,
    depenses: mien(data?.depenses).reduce((s, d) => s + nb(d.montant), 0),
    retoursMontant: retoursSource.reduce((s, r) => s + nb(r.montant), 0),
    retoursNb: retoursSource.reduce((s, r) => s + nb(r.quantite), 0),
    ecartCumule: mien(data?.ecarts).reduce((s, e) => s + nb(e.ecart), 0),
    heuresTravaillees: equipeSource.reduce((s, e) => s + e.heures, 0),
    salaires: equipeSource.reduce((s, e) => s + nb(e.salaire), 0),

    pointsJour,
    heures,
    plats,
    tables,
    canaux,

    modes: cumul(mien(data?.modes), (m) => m.mode, (m) => nb(m.montant), 8).map((l) => ({
      ...l,
      libelle: LIBELLES_MODES[l.cle as ModePaiement] ?? l.cle,
      couleur: COULEUR_MODE[l.cle] ?? 'var(--pay-carte)',
    })),

    retours: [...retoursSource]
      .sort((a, b) => nb(b.quantite) - nb(a.quantite))
      .slice(0, 8)
      .map((r) => ({ cle: r.nom, libelle: r.nom, valeur: nb(r.montant), detail: `× ${nb(r.quantite)}` })),

    depensesCategories: cumul(mien(data?.depenses), (d) => d.categorie, (d) => nb(d.montant)),

    ecarts: mien(data?.ecarts)
      .sort((a, b) => Math.abs(nb(b.ecart)) - Math.abs(nb(a.ecart)))
      .slice(0, 10)
      .map((e) => ({
        cle: `${e.restaurant_id}:${e.caissier}`,
        libelle: e.caissier,
        valeur: nb(e.ecart),
        detail: `${nb(e.nb_services)} service(s)${restaurantId ? '' : ` · ${noms.get(e.restaurant_id) ?? ''}`}`,
      })),

    equipe: equipeSource.slice(0, 12).map((e) => ({
      cle: `${e.restaurant_id}:${e.utilisateur_id}`,
      libelle: e.nom,
      valeur: Math.round(e.heures * 10) / 10,
      detail: `${e.poste ?? 'poste non renseigné'} · ${nb(e.nb_services)} service(s)`,
    })),

    remises: mien(data?.remises),
    annulations: mien(data?.annulations),
    inventaire: mien(data?.inventaire),
    livraisons,
    totalLivraisons: livraisons.reduce(
      (t, l) => ({ nb: t.nb + nb(l.nb), contacts: t.contacts + nb(l.contacts) }),
      { nb: 0, contacts: 0 },
    ),
    absents: (data?.absents ?? []).filter((a) => !restaurantId || a.restaurant_id === restaurantId),
  };
}
```

**Note de simplification** : l'ancien `cumul` de `TableauBord.tsx` portait un paramètre `detail` et construisait une `Map` `secondaire` — ni l'un ni l'autre n'était utilisé dans l'objet rendu. Les deux disparaissent ici. Ce n'est pas un changement de comportement, c'est du code mort supprimé au passage.

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege test`
Expected: PASS — 20 tests verts (10 de la tâche 1, 10 ici).

- [ ] **Step 5: Vérifier la compilation stricte**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege build`
Expected: aucune erreur. `TableauBord.tsx` n'ayant pas été touché, il compile toujours avec ses propres `useMemo` — les deux versions coexistent jusqu'à la tâche 4.

- [ ] **Step 6: Commit**

```bash
cd /Users/macbookpro/pos-samer
git add apps/siege/src/bord.ts apps/siege/src/bord.test.ts
git commit -m "$(cat <<'MSG'
refactor(siege): extraire la dérivation du tableau de bord dans bord.ts

vueBord() est pure : une charge utile et un contexte en entrée, des agrégats
en sortie. Elle ne connaît pas React, donc elle se teste — et elle ne connaît
pas la comparaison, ce qui fera de la colonne unique et des colonnes A / B
strictement le même code.

TableauBord.tsx n'est pas encore branché dessus : les deux versions
coexistent le temps d'une tâche.

Au passage : le paramètre `detail` de `cumul` et sa Map `secondaire` étaient
du code mort, ils ne sont pas repris.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---
### Task 4: L'échelle partagée et l'écart absolu

Trois composants de `Graphes.tsx` calculent leur maximum tout seuls. Deux graphes côte à côte avec chacun son échelle sont un **mensonge visuel** : 980 000 monterait aussi haut que 1 240 000 et l'œil conclurait l'égalité. Cette tâche leur ajoute le `max` imposé que `BarresHorizontales` possède déjà, et donne à `TuileChiffre` l'écart en valeur absolue.

**Files:**
- Modify: `apps/siege/src/components/Graphes.tsx`
- Modify: `apps/siege/src/components/Chiffre.tsx`

**Interfaces:**
- Produces:
  - `BarresEmpilees({ points, series, hauteur?, max? })`
  - `BarresHeures({ heures, max? })`
  - `BarresEcarts({ lignes, max? })`
  - `TuileChiffre({ libelle, valeur, detail?, precedent?, format, ton?, ecartAbsolu? })`

Aucun appelant existant ne casse : les trois props sont optionnelles et le comportement sans elles est identique.

- [ ] **Step 1: `max` sur `BarresEmpilees`**

Dans `Graphes.tsx`, à la signature de `BarresEmpilees`, ajouter `max: maxImpose` :

```tsx
export function BarresEmpilees({
  points,
  series,
  hauteur = 210,
  max: maxImpose,
}: {
  points: PointEmpile[];
  series: Serie[];
  hauteur?: number;
  /** Maximum imposé — obligatoire quand deux graphes sont comparés côte à
   *  côte, sinon chacun se met à sa propre échelle et l'œil conclut
   *  l'égalité entre deux totaux qui n'ont rien à voir. */
  max?: number;
}) {
```

puis remplacer la ligne `const max = Math.max(...totaux, 1);` par :

```tsx
  const max = maxImpose ?? Math.max(...totaux, 1);
```

- [ ] **Step 2: `max` sur `BarresHeures`**

```tsx
export function BarresHeures({
  heures,
  max: maxImpose,
}: {
  heures: { heure: number; ca: number; nb: number }[];
  /** Voir `BarresEmpilees` : imposé dès qu'on compare deux colonnes. */
  max?: number;
}) {
```

puis remplacer `const caMax = Math.max(...heures.map((h) => h.ca), 1);` par :

```tsx
  const caMax = maxImpose ?? Math.max(...heures.map((h) => h.ca), 1);
```

- [ ] **Step 3: `max` sur `BarresEcarts`**

```tsx
export function BarresEcarts({
  lignes,
  max: maxImpose,
}: {
  lignes: { cle: string; libelle: string; valeur: number; detail?: string }[];
  /** Voir `BarresEmpilees` : imposé dès qu'on compare deux colonnes. */
  max?: number;
}) {
```

puis remplacer `const max = Math.max(...lignes.map((l) => Math.abs(l.valeur)), 1);` par :

```tsx
  const max = maxImpose ?? Math.max(...lignes.map((l) => Math.abs(l.valeur)), 1);
```

- [ ] **Step 4: L'écart absolu dans `TuileChiffre`**

Dans `Chiffre.tsx`, ajouter la prop `ecartAbsolu` à la signature :

```tsx
  ton = 'neutre',
  ecartAbsolu = false,
}: {
  libelle: string;
  valeur: number;
  detail?: string;
  precedent?: number;
  format: (n: number) => string;
  /** `alerte` inverse la lecture : ici, monter est une mauvaise nouvelle. */
  ton?: 'neutre' | 'marque' | 'alerte';
  /** En comparaison, le pourcentage ne suffit pas : « −21 % » ne dit pas si
   *  on parle de 260 000 FCFA ou de 2 000. */
  ecartAbsolu?: boolean;
}) {
```

puis, juste après la ligne `const bon = ton === 'alerte' ? !monte : monte;`, ajouter :

```tsx
  const ecart = precedent !== undefined ? valeur - precedent : 0;
```

et, dans le bloc qui rend la variation, ajouter l'écart absolu à sa suite :

```tsx
        {variation !== null && variation !== 0 && (
          <span className={`chiffres font-semibold ${bon ? 'text-ok-txt' : 'text-alerte-txt'}`}>
            {monte ? '▲' : '▼'} {Math.abs(variation)} %
            {ecartAbsolu && (
              <span className="ml-1.5 font-normal">
                {ecart > 0 ? '+' : ''}
                {format(ecart)}
              </span>
            )}
          </span>
        )}
```

- [ ] **Step 5: Vérifier que rien n'a bougé**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege build`
Expected: aucune erreur TypeScript.

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege dev`
Expected: le tableau de bord est **strictement identique** à avant — aucun appelant ne passe encore `max` ni `ecartAbsolu`.

- [ ] **Step 6: Commit**

```bash
cd /Users/macbookpro/pos-samer
git add apps/siege/src/components/Graphes.tsx apps/siege/src/components/Chiffre.tsx
git commit -m "$(cat <<'MSG'
feat(siege): max imposé sur les graphes, écart absolu sur les tuiles

Trois props optionnelles, sans lesquelles la comparaison à venir serait
fausse : deux graphes côte à côte à leur propre échelle font monter 980 000
aussi haut que 1 240 000. BarresHorizontales avait déjà ce `max` ; les trois
autres l'obtiennent.

Aucun appelant ne les passe encore : l'écran est identique.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: `BlocsBord.tsx` et le branchement de `TableauBord.tsx`

Refactor à comportement identique : l'écran doit être **pixel pour pixel le même** à la fin de cette tâche. Elle remplace les `useMemo` de `TableauBord.tsx` par un appel à `vueBord()` et sort les blocs de rendu dans des composants qui acceptent un `max` — prêts pour les deux colonnes, mais encore utilisés sur une seule.

**Files:**
- Create: `apps/siege/src/components/BlocsBord.tsx`
- Modify: `apps/siege/src/screens/TableauBord.tsx`

**Interfaces:**
- Consumes: `VueBord`, `vueBord`, `nb` (`../bord`), `BarresEmpilees`, `BarresHeures`, `BarresHorizontales`, `BarresEcarts`, `Serie` (`./Graphes`), `TuileChiffre` (`./Chiffre`).
- Produces, dans `BlocsBord.tsx` :
  - `function Bloc({ titre, note?, children, large? })` — déplacé depuis `TableauBord.tsx`
  - `interface Maxima { jour?: number; heures?: number; plats?: number; modes?: number; tables?: number; canaux?: number; retours?: number; depenses?: number; ecarts?: number; equipe?: number }`
  - `function TuilesBord({ vue, reference?, ecartAbsolu?, sansVariation? }: { vue: VueBord; reference?: VueBord; ecartAbsolu?: boolean; sansVariation?: boolean })`
  - `function BlocsBord({ vue, series, maxima?, montrerRepartition? }: { vue: VueBord; series: Serie[]; maxima?: Maxima; montrerRepartition?: boolean })`

`reference` est la vue à laquelle se comparer : absente, les tuiles utilisent `caPrecedent` / `commandesPrecedent` comme aujourd'hui ; présente, elles prennent ses valeurs comme `precedent`. `sansVariation` supprime toute flèche — **la colonne A de la comparaison le passe** : sa variation contre son propre passé est une TROISIÈME information, qui entrerait en collision avec l'écart B↔A dans le même coup d'œil (spéc § 6.2). Concrètement, `TuilesBord` ne passe alors ni `precedent` ni `ecartAbsolu` à `TuileChiffre`.

- [ ] **Step 1: Créer `BlocsBord.tsx`**

Déplacer dans ce fichier, **sans les réécrire**, les JSX suivants de `TableauBord.tsx`, en remplaçant chaque variable locale par son champ de `vue` :

| JSX à déplacer | Devient |
|---|---|
| `function Bloc(...)` | exporté tel quel |
| la grille des 6 `TuileChiffre` | `TuilesBord` |
| bloc « Chiffre d'affaires, jour par jour » | dans `BlocsBord`, `max={maxima?.jour}` |
| bloc « Heures de pic » | idem, `max={maxima?.heures}` |
| blocs « Top des plats », « Modes de paiement », « Tables les plus utilisées », « Canaux de vente », « Retours », « Dépenses par catégorie » | idem, chacun son `max` |
| bloc « Écarts réconciliés par caissier » | idem, `max={maxima?.ecarts}` |
| bloc « Remises et annulations » | lit `vue.remises` et `vue.annulations` |
| bloc « Livraisons partenaires par caissier » | lit `vue.livraisons` et `vue.totalLivraisons` ; la colonne « Restaurant » s'affiche si `vue.restaurantId === null` |
| bloc « Inventaire » | lit `vue.inventaire` ; le nom du site vient de `vue.noms` — **ajouter `noms: Map<string, string>` à `VueBord`** et le remplir depuis `ctx.noms` dans `bord.ts` |
| bloc « Équipe » + « Absents aujourd'hui » | lit `vue.equipe`, `vue.heuresTravaillees`, `vue.salaires`, `vue.absents` |

`montrerRepartition` commande les deux blocs « CA par restaurant » et « Panier moyen par restaurant » : ils restent dans `TableauBord.tsx`, car ils classent les 7 restaurants et n'appartiennent à aucune vue. Ne pas les déplacer.

En tête du fichier, si `vue.enrole === false`, `BlocsBord` rend d'abord :

```tsx
      {!vue.enrole && (
        <Info>
          <b>Ce site ne synchronise pas encore.</b> Tout est à zéro parce que le cloud ne reçoit rien — pas parce
          que la période a été blanche.
        </Info>
      )}
```

- [ ] **Step 2: Brancher `TableauBord.tsx`**

Supprimer de `TableauBord.tsx` : `COULEUR_MODE`, `nb`, `Bloc`, `mien`, `lignes`, `total`, `totalPrec`, `commandes`, `commandesPrec`, `panier`, `depenses`, `retours`, `retoursMontant`, `retoursNb`, `ecartCumule`, `livraisons`, `totalLivraisons`, `pointsJour`, `heures`, `cumul`, `plats`, `modes`, `tables`, `canaux`, `equipe`, `heuresTotal`, `salaires`, `absents`.

Conserver : `periode`, la requête `useQuery`, `restos`, `choisi`, `series`, `nomResto`, et les deux blocs de répartition.

Ajouter :

```tsx
  const vue = useMemo(
    () =>
      vueBord(data, {
        restaurantId: choisi?.restaurant_id ?? null,
        nom: choisi?.nom ?? 'Tous les restaurants',
        enrole: choisi ? choisi.enrole : true,
        noms: nomResto,
      }),
    [data, choisi, nomResto],
  );
```

et, dans le rendu, remplacer tout le contenu de `<div className="space-y-4">` par :

```tsx
          <TuilesBord vue={vue} />
          {!choisi && (
            <div className="grid gap-4 xl:grid-cols-2">
              {/* les deux blocs de répartition, inchangés */}
            </div>
          )}
          <BlocsBord vue={vue} series={series} />
```

en plaçant la répartition entre les tuiles et les blocs, comme aujourd'hui.

- [ ] **Step 3: Vérifier que l'écran n'a pas bougé**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege build`
Expected: aucune erreur.

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege test`
Expected: PASS — 20 tests.

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege dev`

Comparer à l'écran, filtre sur « Tous » puis sur un restaurant, sur « Aujourd'hui » puis sur « 30 derniers jours » :
- les 6 tuiles portent les mêmes chiffres et les mêmes flèches ;
- les blocs sont dans le même ordre ;
- « CA par restaurant » et « Panier moyen par restaurant » n'apparaissent que sans filtre ;
- la colonne « Restaurant » du tableau des livraisons apparaît sans filtre et disparaît avec.

Tout écart ici est une régression du refactor, pas une amélioration.

- [ ] **Step 4: Commit**

```bash
cd /Users/macbookpro/pos-samer
git add apps/siege/src/components/BlocsBord.tsx apps/siege/src/screens/TableauBord.tsx apps/siege/src/bord.ts
git commit -m "$(cat <<'MSG'
refactor(siege): TableauBord ne fait plus que l'orchestration

Les blocs de rendu passent dans BlocsBord.tsx et prennent une VueBord en
entrée ; TableauBord garde les filtres, la requête et les deux blocs de
répartition, qui classent les 7 restaurants et n'appartiennent à aucune vue.

Aucun changement visible : c'est la même page, préparée pour être rendue
deux fois côte à côte.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---
### Task 6: `comparaison.ts` — les écarts et la synthèse

**Files:**
- Create: `apps/siege/src/comparaison.ts`
- Test: `apps/siege/src/comparaison.test.ts`

**Interfaces:**
- Consumes: `VueBord` (`./bord`), `formatFCFA` (`@pos/shared`).
- Produces:
  - `type Polarite = 'bon' | 'mauvais' | 'neutre'`
  - `interface Indicateur { cle: string; libelle: string; polarite: Polarite; valeur: (v: VueBord) => number; format: (n: number) => string }`
  - `const INDICATEURS: Indicateur[]`
  - `interface Ecart { cle; libelle; valeurA; valeurB; absolu; pourcentage: number | null; raison: string | null; polarite; favorable: boolean; format }`
  - `function ecarts(a: VueBord, b: VueBord): Ecart[]`
  - `function synthese(a: VueBord, b: VueBord): { phrase: string; lignes: Ecart[] }`

- [ ] **Step 1: Écrire le test qui échoue**

Créer `apps/siege/src/comparaison.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { ecarts, synthese } from './comparaison';
import type { VueBord } from './bord';

/** Une vue minimale : seuls les champs comparés comptent ici. */
function vue(partiel: Partial<VueBord> & { nom: string }): VueBord {
  return {
    restaurantId: null,
    enrole: true,
    vide: false,
    ca: 0,
    caPrecedent: 0,
    commandes: 0,
    commandesPrecedent: 0,
    panier: 0,
    depenses: 0,
    retoursMontant: 0,
    retoursNb: 0,
    ecartCumule: 0,
    heuresTravaillees: 0,
    salaires: 0,
    pointsJour: [],
    heures: [],
    plats: [],
    modes: [],
    tables: [],
    canaux: [],
    retours: [],
    depensesCategories: [],
    ecarts: [],
    equipe: [],
    remises: [],
    annulations: [],
    inventaire: [],
    livraisons: [],
    totalLivraisons: { nb: 0, contacts: 0 },
    absents: [],
    noms: new Map(),
    ...partiel,
  };
}

const ligne = (liste: ReturnType<typeof ecarts>, cle: string) => liste.find((e) => e.cle === cle);

describe('ecarts — le calcul', () => {
  it('rend l’écart absolu et le pourcentage contre A', () => {
    const a = vue({ nom: 'Angré', ca: 1_240_000 });
    const b = vue({ nom: 'Riviera', ca: 980_000 });

    const ca = ligne(ecarts(a, b), 'ca');
    expect(ca?.valeurA).toBe(1_240_000);
    expect(ca?.valeurB).toBe(980_000);
    expect(ca?.absolu).toBe(-260_000);
    expect(ca?.pourcentage).toBe(-21);
  });

  it('B à zéro donne −100 %, qui est légitime et s’affiche', () => {
    const ca = ligne(ecarts(vue({ nom: 'A', ca: 500_000 }), vue({ nom: 'B', ca: 0 })), 'ca');
    expect(ca?.pourcentage).toBe(-100);
  });
});

/**
 * (b − a) / a avec a = 0 est une division par zéro. Le cas arrive pour de
 * bon : un restaurant fermé un jour férié, un bloc sans donnée. Afficher
 * « Infinity % » ou « NaN » serait pire que ne rien afficher.
 */
describe('ecarts — A à zéro', () => {
  it('ne produit aucun pourcentage et donne une raison en français', () => {
    const ca = ligne(ecarts(vue({ nom: 'Angré', ca: 0 }), vue({ nom: 'Riviera', ca: 980_000 })), 'ca');
    expect(ca?.pourcentage).toBeNull();
    expect(ca?.raison).toContain('Angré');
    expect(ca?.absolu).toBe(980_000);
  });

  it('garde l’écart absolu, qui lui reste vrai', () => {
    const ca = ligne(ecarts(vue({ nom: 'A', ca: 0 }), vue({ nom: 'B', ca: 12_000 })), 'ca');
    expect(ca?.absolu).toBe(12_000);
  });
});

/**
 * Les sites non enrôlés restent sélectionnables — les retirer laisserait
 * croire que le groupe compte moins de restaurants qu'en vrai. Mais leurs
 * zéros ne sont pas des ventes nulles : c'est l'absence de synchro.
 */
describe('ecarts — un site non enrôlé', () => {
  it('ne produit aucun pourcentage, dans un sens comme dans l’autre', () => {
    const a = vue({ nom: 'Angré', ca: 1_000_000 });
    const b = vue({ nom: 'Yopougon', ca: 0, enrole: false });

    for (const e of ecarts(a, b)) expect(e.pourcentage).toBeNull();
    for (const e of ecarts(b, a)) expect(e.pourcentage).toBeNull();
  });

  it('nomme le site fautif dans la raison', () => {
    const e = ligne(ecarts(vue({ nom: 'Angré', ca: 1_000_000 }), vue({ nom: 'Yopougon', enrole: false })), 'ca');
    expect(e?.raison).toContain('Yopougon');
  });
});

describe('ecarts — la polarité', () => {
  it('le chiffre d’affaires qui monte est une bonne nouvelle', () => {
    const e = ligne(ecarts(vue({ nom: 'A', ca: 100 }), vue({ nom: 'B', ca: 200 })), 'ca');
    expect(e?.polarite).toBe('bon');
    expect(e?.favorable).toBe(true);
  });

  it('les dépenses qui montent sont une mauvaise nouvelle', () => {
    const e = ligne(ecarts(vue({ nom: 'A', depenses: 100 }), vue({ nom: 'B', depenses: 200 })), 'depenses');
    expect(e?.polarite).toBe('mauvais');
    expect(e?.favorable).toBe(false);
  });

  it('les dépenses qui baissent sont une bonne nouvelle', () => {
    const e = ligne(ecarts(vue({ nom: 'A', depenses: 200 }), vue({ nom: 'B', depenses: 100 })), 'depenses');
    expect(e?.favorable).toBe(true);
  });

  it('l’écart de caisse se compare en valeur absolue : −8 000 est pire que −2 500', () => {
    const e = ligne(ecarts(vue({ nom: 'A', ecartCumule: -2_500 }), vue({ nom: 'B', ecartCumule: -8_000 })), 'ecart');
    expect(e?.valeurA).toBe(2_500);
    expect(e?.valeurB).toBe(8_000);
    expect(e?.favorable).toBe(false);
  });

  it('les heures travaillées sont neutres : ni bonnes ni mauvaises', () => {
    const e = ligne(ecarts(vue({ nom: 'A', heuresTravaillees: 10 }), vue({ nom: 'B', heuresTravaillees: 20 })), 'heures');
    expect(e?.polarite).toBe('neutre');
    expect(e?.favorable).toBe(false);
  });
});

describe('synthese', () => {
  it('la phrase porte sur le chiffre d’affaires', () => {
    const s = synthese(vue({ nom: 'Angré', ca: 1_240_000 }), vue({ nom: 'Riviera', ca: 980_000 }));
    expect(s.phrase).toContain('Riviera');
    expect(s.phrase).toContain('Angré');
    expect(s.phrase).toContain('21');
  });

  it('retient au plus trois lignes, jamais le CA ni les indicateurs neutres', () => {
    const a = vue({ nom: 'A', ca: 100, commandes: 100, panier: 100, depenses: 100, retoursMontant: 100, ecartCumule: 100, heuresTravaillees: 100 });
    const b = vue({ nom: 'B', ca: 50, commandes: 90, panier: 50, depenses: 400, retoursMontant: 200, ecartCumule: 110, heuresTravaillees: 900 });

    const s = synthese(a, b);
    expect(s.lignes).toHaveLength(3);
    expect(s.lignes.map((l) => l.cle)).not.toContain('ca');
    expect(s.lignes.map((l) => l.cle)).not.toContain('heures');
  });

  it('trie par écart RELATIF, pas absolu', () => {
    // Les trois tris doivent DIFFÉRER : dépenses +300 %, commandes +90 %,
    // panier −50 % en relatif ; mais en ABSOLU le panier écrase tout avec
    // −500 000. Un test où les deux ordres coïncident ne prouve rien.
    const a = vue({ nom: 'A', ca: 1, commandes: 10, panier: 1_000_000, depenses: 100 });
    const b = vue({ nom: 'B', ca: 1, commandes: 19, panier: 500_000, depenses: 400 });

    expect(synthese(a, b).lignes.map((l) => l.cle)).toEqual(['depenses', 'commandes', 'panier']);
  });

  it('A à zéro : la phrase le dit au lieu d’un pourcentage', () => {
    const s = synthese(vue({ nom: 'Angré', ca: 0 }), vue({ nom: 'Riviera', ca: 980_000 }));
    expect(s.phrase).toContain('Angré');
    expect(s.phrase).not.toContain('%');
  });

  /**
   * Le piège : un site non enrôlé a TOUJOURS un CA à zéro. Tester la valeur
   * avant `enrole` fait donc dire à la synthèse « il n'a rien vendu » — un
   * constat commercial, là où la vérité est qu'on ne sait rien de ses ventes.
   */
  it('un site non enrôlé n’est jamais décrit comme n’ayant rien vendu', () => {
    const s = synthese(vue({ nom: 'Yopougon', ca: 0, enrole: false }), vue({ nom: 'Angré', ca: 1_000_000 }));
    expect(s.phrase).toContain('Yopougon');
    expect(s.phrase).toContain('synchronise');
    expect(s.phrase).not.toContain('rien vendu');
    expect(s.phrase).not.toContain('%');
  });

  it('égalité parfaite : la phrase le dit, aucune ligne', () => {
    const s = synthese(vue({ nom: 'A', ca: 500 }), vue({ nom: 'B', ca: 500 }));
    expect(s.phrase).toContain('autant');
    expect(s.lignes).toEqual([]);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege test`
Expected: ÉCHEC — le module `./comparaison` n'existe pas.

- [ ] **Step 3: Écrire `comparaison.ts`**

```ts
import { formatFCFA } from '@pos/shared';
import type { VueBord } from './bord';

/**
 * Le sens de la variation. Elle décide de la COULEUR et de rien d'autre :
 * la flèche et le signe redisent toujours l'information, pour qui ne
 * distingue pas le vert du rouge.
 */
export type Polarite = 'bon' | 'mauvais' | 'neutre';

export interface Indicateur {
  cle: string;
  libelle: string;
  polarite: Polarite;
  valeur: (v: VueBord) => number;
  format: (n: number) => string;
}

/**
 * Les indicateurs confrontés, dans l'ordre des tuiles de l'écran.
 *
 * L'écart de caisse se compare en VALEUR ABSOLUE : un manquant de 8 000 est
 * pire qu'un manquant de 2 500, alors que −8 000 < −2 500. Comparer les
 * signés dirait l'inverse.
 *
 * Les heures et les salaires sont `neutre` : travailler plus n'est ni bon ni
 * mauvais en soi, et les colorer ferait dire à l'écran ce qu'il ne sait pas.
 */
export const INDICATEURS: Indicateur[] = [
  { cle: 'ca', libelle: 'Chiffre d’affaires', polarite: 'bon', valeur: (v) => v.ca, format: formatFCFA },
  { cle: 'commandes', libelle: 'Commandes payées', polarite: 'bon', valeur: (v) => v.commandes, format: (n) => n.toLocaleString('fr-FR') },
  { cle: 'panier', libelle: 'Panier moyen', polarite: 'bon', valeur: (v) => v.panier, format: formatFCFA },
  { cle: 'depenses', libelle: 'Dépenses de caisse', polarite: 'mauvais', valeur: (v) => v.depenses, format: formatFCFA },
  { cle: 'retours', libelle: 'Retours', polarite: 'mauvais', valeur: (v) => v.retoursMontant, format: formatFCFA },
  { cle: 'ecart', libelle: 'Écart réconcilié', polarite: 'mauvais', valeur: (v) => Math.abs(v.ecartCumule), format: formatFCFA },
  { cle: 'heures', libelle: 'Heures travaillées', polarite: 'neutre', valeur: (v) => Math.round(v.heuresTravaillees), format: (n) => `${n} h` },
  { cle: 'salaires', libelle: 'Salaires payés en caisse', polarite: 'neutre', valeur: (v) => v.salaires, format: formatFCFA },
];

export interface Ecart {
  cle: string;
  libelle: string;
  valeurA: number;
  valeurB: number;
  /** B − A. Toujours vrai, même quand le pourcentage ne se calcule pas. */
  absolu: number;
  /** `null` quand A vaut zéro, ou qu'un des deux sites ne synchronise pas. */
  pourcentage: number | null;
  /** Pourquoi il n'y a pas de pourcentage, en français courant. */
  raison: string | null;
  polarite: Polarite;
  /** La variation joue-t-elle dans le bon sens ? Faux pour un neutre. */
  favorable: boolean;
  format: (n: number) => string;
}

export function ecarts(a: VueBord, b: VueBord): Ecart[] {
  // Un site non enrôlé n'a pas fait zéro de vente : il ne remonte rien. Le
  // comparer produirait un « −100 % » qu'on lirait comme un effondrement.
  const muet = !a.enrole ? a.nom : !b.enrole ? b.nom : null;

  return INDICATEURS.map((ind) => {
    const valeurA = ind.valeur(a);
    const valeurB = ind.valeur(b);
    const absolu = valeurB - valeurA;

    let pourcentage: number | null = null;
    let raison: string | null = null;

    if (muet) {
      raison = `${muet} ne synchronise pas encore : il n’y a rien à comparer.`;
    } else if (valeurA === 0) {
      raison =
        valeurB === 0
          ? 'Rien des deux côtés sur cette ligne.'
          : `${a.nom} est à zéro sur cette ligne : la variation ne se calcule pas.`;
    } else {
      pourcentage = Math.round((absolu / valeurA) * 100);
    }

    return {
      cle: ind.cle,
      libelle: ind.libelle,
      valeurA,
      valeurB,
      absolu,
      pourcentage,
      raison,
      polarite: ind.polarite,
      favorable: ind.polarite === 'bon' ? absolu > 0 : ind.polarite === 'mauvais' ? absolu < 0 : false,
      format: ind.format,
    };
  });
}

/**
 * Ce qu'on lit en premier : une phrase sur le chiffre d'affaires, puis les
 * trois plus gros écarts RELATIFS. Relatifs et non absolus : sur un groupe
 * de sept restaurants, l'absolu ne désignerait jamais que le plus gros.
 */
export function synthese(a: VueBord, b: VueBord): { phrase: string; lignes: Ecart[] } {
  const tous = ecarts(a, b);
  const principal = tous.find((e) => e.cle === 'ca');

  const lignes = tous
    .filter((e) => e.cle !== 'ca' && e.polarite !== 'neutre' && e.pourcentage !== null && e.pourcentage !== 0)
    .sort((x, y) => Math.abs(y.pourcentage ?? 0) - Math.abs(x.pourcentage ?? 0))
    .slice(0, 3);

  if (!principal) return { phrase: '', lignes };

  if (principal.raison) {
    // Un site qui ne synchronise pas n’a PAS « rien vendu » : on ne sait rien
    // de ses ventes. Réécrire sa raison en constat commercial produirait
    // exactement la conclusion fausse que la règle interdit — et comme un site
    // non enrôlé a toujours un CA à zéro, un test sur la valeur seule mord
    // systématiquement sur lui.
    const muet = !a.enrole || !b.enrole;
    const phrase =
      !muet && principal.valeurA === 0 && principal.valeurB > 0
        ? `${a.nom} n’a rien vendu sur cette période — ${b.nom} a fait ${formatFCFA(principal.valeurB)}.`
        : principal.raison;
    return { phrase, lignes };
  }

  if (principal.absolu === 0) {
    return { phrase: `${b.nom} fait exactement autant que ${a.nom}.`, lignes };
  }

  const sens = principal.absolu < 0 ? 'de moins' : 'de plus';
  const pct = principal.pourcentage ?? 0;
  return {
    phrase: `${b.nom} fait ${formatFCFA(Math.abs(principal.absolu))} ${sens} que ${a.nom} (${pct > 0 ? '+' : ''}${pct} %).`,
    lignes,
  };
}
```

- [ ] **Step 4: Lancer les tests pour vérifier qu'ils passent**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege test`
Expected: PASS — 37 tests verts.

- [ ] **Step 5: Vérifier la compilation**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege build`
Expected: aucune erreur.

- [ ] **Step 6: Commit**

```bash
cd /Users/macbookpro/pos-samer
git add apps/siege/src/comparaison.ts apps/siege/src/comparaison.test.ts
git commit -m "$(cat <<'MSG'
feat(siege): ecarts() et synthese(), les règles de la comparaison

Pures, donc testées : division par zéro, site non enrôlé, polarité inversée
des indicateurs d'alerte, écart de caisse comparé en valeur absolue, tri de
la synthèse par écart relatif.

Aucun écran ne les appelle encore.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: La comparaison à l'écran

**Files:**
- Create: `apps/siege/src/components/Synthese.tsx`
- Create: `apps/siege/src/components/BarreComparaison.tsx`
- Modify: `apps/siege/src/screens/TableauBord.tsx`

**Interfaces:**
- Consumes: `synthese`, `ecarts`, `Ecart` (`../comparaison`), `vueBord`, `VueBord` (`../bord`), `TuilesBord`, `BlocsBord`, `Maxima` (`./BlocsBord`), `RestoGroupe` (`../api`), `Periode` (`../periode`).
- Produces:
  - `type ModeComparaison = 'restaurants' | 'periodes'`
  - `function BarreComparaison({ mode, onMode, restaurants, a, b, onA, onB, periodeB })`
  - `function Synthese({ a, b })`

- [ ] **Step 1: `Synthese.tsx`**

```tsx
import { synthese } from '../comparaison';
import type { VueBord } from '../bord';

/**
 * La bande de verdict, en tête des deux colonnes. C'est ce qu'on lit en
 * premier, et sur un écran étroit c'est parfois tout ce qu'on lit : elle doit
 * se suffire à elle-même.
 */
export function Synthese({ a, b }: { a: VueBord; b: VueBord }) {
  const { phrase, lignes } = synthese(a, b);
  if (!phrase) return null;

  return (
    <section className="rounded-jeton border-l-4 border-marque bg-carte p-4 shadow-e1">
      <p className="text-[15px] font-semibold">{phrase}</p>
      {lignes.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
          {lignes.map((l) => (
            <li key={l.cle} className="text-sm text-doux">
              {l.libelle}{' '}
              <span className={`chiffres font-semibold ${l.favorable ? 'text-ok-txt' : 'text-alerte-txt'}`}>
                {(l.pourcentage ?? 0) > 0 ? '▲' : '▼'} {Math.abs(l.pourcentage ?? 0)} %
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

- [ ] **Step 2: `BarreComparaison.tsx`**

```tsx
import type { RestoGroupe } from '../api';

export type ModeComparaison = 'restaurants' | 'periodes';

/**
 * Le mode et les deux termes. Les modes sont STRICTS : en « 2 restaurants »
 * il n'y a qu'une période, en « 2 périodes » qu'un restaurant. Faire varier
 * les deux à la fois n'explique rien — si Angré/octobre bat Riviera/novembre,
 * on ne sait pas si c'est le restaurant ou le mois.
 */
export function BarreComparaison({
  mode,
  onMode,
  restaurants,
  a,
  b,
  onA,
  onB,
  libellePeriodeA,
  libellePeriodeB,
  nbJours,
}: {
  mode: ModeComparaison;
  onMode: (m: ModeComparaison) => void;
  restaurants: RestoGroupe[];
  /** `samtrackly_id` du terme A, '' pour « Tous les restaurants ». */
  a: string;
  b: string;
  onA: (v: string) => void;
  onB: (v: string) => void;
  libellePeriodeA: string;
  libellePeriodeB: string;
  /** Nombre de jours couverts par A — et donc par B. Écrit à l'écran : sans lui,
   *  « Ce mois-ci » un 25 septembre se lirait comme le mois d'août entier. */
  nbJours: number;
}) {
  const assezDeRestaurants = restaurants.length >= 2;

  const bouton = (m: ModeComparaison, libelle: string, actif: boolean, desactive = false) => (
    <button
      key={m}
      type="button"
      disabled={desactive}
      onClick={() => onMode(m)}
      className={`min-h-[40px] rounded-btn border px-4 text-sm font-semibold transition ${
        actif ? 'border-marque bg-marque text-sur-marque' : 'border-filet bg-carte text-doux hover:border-marque'
      } ${desactive ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {libelle}
    </button>
  );

  const choix = (valeur: string, onChoisir: (v: string) => void, exclure: string) => (
    <select className="champ !min-h-[40px] !w-auto !py-0 !text-[15px]" value={valeur} onChange={(e) => onChoisir(e.target.value)}>
      <option value="">Tous les restaurants</option>
      {restaurants
        .filter((r) => r.samtrackly_id !== exclure)
        .map((r) => (
          <option key={r.samtrackly_id} value={r.samtrackly_id}>
            {r.nom}
            {r.enrole ? '' : ' (non enrôlé)'}
          </option>
        ))}
    </select>
  );

  return (
    <section className="rounded-jeton border border-filet bg-carte-douce p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-bold uppercase tracking-wide text-faible">Comparer</span>
        {bouton('restaurants', '2 restaurants', mode === 'restaurants', !assezDeRestaurants)}
        {bouton('periodes', '2 périodes', mode === 'periodes')}
        {!assezDeRestaurants && (
          <span className="text-xs text-faible">Il faut au moins deux restaurants pour les comparer.</span>
        )}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm font-semibold text-doux">
          A
          {mode === 'restaurants' ? choix(a, onA, b) : <span className="chiffres">{libellePeriodeA}</span>}
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-doux">
          B
          {mode === 'restaurants' ? choix(b, onB, a) : <span className="chiffres">{libellePeriodeB}</span>}
        </label>
      </div>

      {mode === 'periodes' && (
        <p className="mt-2 text-xs text-faible">
          <b>{nbJours} jours contre les {nbJours} précédents.</b> B n’est pas choisie : c’est la même durée,
          juste avant A — sans quoi le pourcentage d’écart ne voudrait rien dire. Une période en cours (« Ce
          mois-ci » un 25 du mois) ne couvre donc PAS le mois précédent entier, et ne le prétend pas.
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 3: Brancher `TableauBord.tsx`**

Ajouter l'état :

```tsx
  const [comparaison, setComparaison] = useState(false);
  const [mode, setMode] = useState<ModeComparaison>('restaurants');
  const [termeA, setTermeA] = useState('');
  const [termeB, setTermeB] = useState('');
```

Le bouton, à côté du `FiltreRestaurant` :

```tsx
          {!comparaison && <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />}
          <button
            type="button"
            onClick={() => {
              if (!comparaison) {
                const tous = restos?.restaurants ?? [];
                const premier = filtre || tous[0]?.samtrackly_id || '';
                setTermeA(premier);
                setTermeB(tous.find((r) => r.samtrackly_id !== premier)?.samtrackly_id ?? '');
              }
              setComparaison((c) => !c);
            }}
            className="min-h-[40px] rounded-btn border border-filet bg-carte px-4 text-sm font-semibold text-doux transition hover:border-marque hover:text-txt"
          >
            {comparaison ? 'Comparer ✕' : 'Comparer'}
          </button>
```

La seconde requête, pour le mode « 2 périodes ». Elle n'a **pas** de `refetchInterval` : elle porte sur du passé figé.

```tsx
  const bornesB = data?.periode ? { debut: data.periode.debut_precedent, fin: data.periode.debut } : null;

  const { data: dataB } = useQuery({
    queryKey: ['tableau_bord', bornesB?.debut, bornesB?.fin],
    queryFn: () => appelSiege<Bord>('tableau_bord', { debut: bornesB!.debut, fin: bornesB!.fin }),
    enabled: comparaison && mode === 'periodes' && !!bornesB,
  });
```

Les deux vues, et le contexte de chacune :

```tsx
  const ctxDe = (samtracklyId: string) => {
    const r = restos?.restaurants.find((x) => x.samtrackly_id === samtracklyId);
    return {
      restaurantId: r?.restaurant_id ?? null,
      nom: r?.nom ?? 'Tous les restaurants',
      enrole: r ? r.enrole : true,
      noms: nomResto,
    };
  };

  const vueA = useMemo(
    () => vueBord(data, comparaison && mode === 'restaurants' ? ctxDe(termeA) : ctxDe(filtre)),
    [data, comparaison, mode, termeA, filtre, restos, nomResto],
  );

  const vueB = useMemo(() => {
    if (!comparaison) return null;
    return mode === 'restaurants' ? vueBord(data, ctxDe(termeB)) : vueBord(dataB, ctxDe(filtre));
  }, [comparaison, mode, data, dataB, termeB, filtre, restos, nomResto]);
```

Les maxima partagés — **c'est ce qui empêche le graphe de mentir** :

```tsx
  const maxima = useMemo<Maxima | undefined>(() => {
    if (!vueB) return undefined;
    const plus = (ns: number[]) => Math.max(...ns, 1);
    const totalJour = (v: VueBord) =>
      plus(v.pointsJour.map((p) => Object.values(p.valeurs).reduce((s, n) => s + n, 0)));
    const pic = (v: VueBord) => plus(v.heures.map((h) => h.ca));
    const haut = (l: { valeur: number }[]) => plus(l.map((x) => Math.abs(x.valeur)));

    return {
      jour: Math.max(totalJour(vueA), totalJour(vueB)),
      heures: Math.max(pic(vueA), pic(vueB)),
      plats: Math.max(haut(vueA.plats), haut(vueB.plats)),
      modes: Math.max(haut(vueA.modes), haut(vueB.modes)),
      tables: Math.max(haut(vueA.tables), haut(vueB.tables)),
      canaux: Math.max(haut(vueA.canaux), haut(vueB.canaux)),
      retours: Math.max(haut(vueA.retours), haut(vueB.retours)),
      depenses: Math.max(haut(vueA.depensesCategories), haut(vueB.depensesCategories)),
      ecarts: Math.max(haut(vueA.ecarts), haut(vueB.ecarts)),
      equipe: Math.max(haut(vueA.equipe), haut(vueB.equipe)),
    };
  }, [vueA, vueB]);
```

Le rendu, quand `vueB` existe :

```tsx
          {vueB ? (
            <>
              <BarreComparaison
                mode={mode}
                onMode={setMode}
                restaurants={restos?.restaurants ?? []}
                a={termeA}
                b={termeB}
                onA={setTermeA}
                onB={setTermeB}
                libellePeriodeA={periode.libelle}
                libellePeriodeB={libelleB}
                nbJours={nbJours}
              />
              <Synthese a={vueA} b={vueB} />
              <div className="grid gap-4 xl:grid-cols-2">
                <div className="space-y-4">
                  <EnteteColonne lettre="A" vue={vueA} periode={periode.libelle} />
                  <TuilesBord vue={vueA} sansVariation />
                  <BlocsBord vue={vueA} series={series} maxima={maxima} />
                </div>
                <div className="space-y-4">
                  <EnteteColonne lettre="B" vue={vueB} periode={libelleB} />
                  <TuilesBord vue={vueB} reference={vueA} ecartAbsolu />
                  <BlocsBord vue={vueB} series={series} maxima={maxima} />
                </div>
              </div>
            </>
          ) : (
            /* le rendu à une colonne de la tâche 5, inchangé */
          )}
```

`libelleB` se calcule depuis les bornes rendues par l'API :

```tsx
  const libelleB =
    mode === 'periodes' && bornesB
      ? `${jourCourt(bornesB.debut)} → ${jourCourt(new Date(new Date(bornesB.fin).getTime() - 86_400_000).toISOString())}`
      : periode.libelle;

  /** Le nombre de jours réellement couvert — écrit à l’écran, jamais deviné. */
  const nbJours = Math.round(
    (new Date(periode.fin).getTime() - new Date(periode.debut).getTime()) / 86_400_000,
  );
```

`EnteteColonne` est un petit composant local à `TableauBord.tsx` : la lettre, le nom du restaurant et le libellé de période. La mise en garde sur la période partielle, elle, vit dans `BarreComparaison` — elle porte sur les DEUX colonnes, l’écrire deux fois la ferait lire comme deux avertissements distincts.

```tsx
function EnteteColonne({ lettre, vue, periode }: { lettre: 'A' | 'B'; vue: VueBord; periode: string }) {
  return (
    <div className="border-b border-filet pb-2">
      <p className="text-[12px] font-bold uppercase tracking-wide text-faible">
        {lettre} · {vue.nom}
      </p>
      <p className="chiffres text-sm text-doux">{periode}</p>
    </div>
  );
}
```

- [ ] **Step 4: Vérifier**

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege build`
Expected: aucune erreur.

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege test`
Expected: PASS — 37 tests.

Run: `cd /Users/macbookpro/pos-samer && pnpm --filter @pos/siege dev`

Dans le navigateur, onglet Réseau ouvert :
1. « Comparer » → mode « 2 restaurants », deux colonnes. **Aucune requête supplémentaire** ne part.
2. Changer B pour un autre restaurant → toujours aucune requête.
3. Basculer sur « 2 périodes » → **une seule** requête part, sur les bornes précédentes.
4. Les barres de « Top des plats » de A et de B se lisent à la même échelle : le plus gros des deux côtés remplit la ligne, l'autre est proportionnel.
5. Choisir un site non enrôlé pour B → son encart s'affiche, aucune tuile de B ne porte de pourcentage.
6. Choisir une période où A n'a rien vendu → la synthèse écrit la phrase, aucune tuile ne porte « Infinity % ».
7. Les tuiles de la colonne **A ne portent aucune flèche** ; celles de B portent le pourcentage ET l’écart absolu.
8. Mode « 2 périodes » sur « Ce mois-ci » un jour autre que le 1er : la barre écrit « N jours contre les N précédents » et dit que ce n’est pas le mois précédent entier.
9. « Comparer ✕ » → retour à une colonne, le filtre restaurant réapparaît à la valeur qu'il avait.

- [ ] **Step 5: Commit**

```bash
cd /Users/macbookpro/pos-samer
git add apps/siege/src/components/Synthese.tsx apps/siege/src/components/BarreComparaison.tsx apps/siege/src/screens/TableauBord.tsx
git commit -m "$(cat <<'MSG'
feat(siege): comparaison A/B au tableau de bord

Deux modes stricts : deux restaurants sur une période, ou un restaurant sur
deux périodes. Le premier ne coûte AUCUNE requête — la réponse tableau_bord
porte déjà les sept restaurants ; le second en coûte une, sans refetch
puisqu'elle porte sur du passé figé.

Les deux colonnes partagent leurs échelles : sans cela 980 000 monterait
aussi haut que 1 240 000.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
)"
```

---

## Vérification finale

Avant de déclarer le travail terminé, lancer et **lire la sortie** :

```bash
cd /Users/macbookpro/pos-samer
pnpm --filter @pos/siege test     # 37 tests verts
pnpm --filter @pos/siege build    # aucune erreur TypeScript
```

Puis dérouler à l'écran les sept points du Step 4 de la tâche 7, plus les cinq points du Step 3 de la tâche 2 (période personnalisée, sur le tableau de bord ET sur les clôtures).

Ne pas déclarer « terminé » sans avoir vu ces sorties.
