import { useState } from 'react';
import { listePeriodes, MESSAGES_REFUS, personnalisee, type Periode, type RefusPeriode } from '../periode';

/**
 * Les cinq périodes en chips, plus une sixième qui ouvre deux dates libres,
 * chacune avec son heure facultative (« de 08:24 à 16:18 »).
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
  const [heureDe, setHeureDe] = useState('');
  const [heureA, setHeureA] = useState('');
  const [refus, setRefus] = useState<RefusPeriode | null>(null);

  const perso = valeur.cle === 'perso';

  /** Chaque frappe retente : on n'attend pas un bouton pour dire ce qui cloche. */
  const tenter = (nouveauDu: string, nouveauAu: string, de = heureDe, a = heureA) => {
    setDu(nouveauDu);
    setAu(nouveauAu);
    setHeureDe(de);
    setHeureA(a);
    const r = personnalisee(nouveauDu, nouveauAu, new Date(), { de, a });
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
              setHeureDe('');
              setHeureA('');
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
          onClick={() => {
            // Les deux dates arrivent pré-remplies à aujourd'hui : la question
            // courante est « ce matin de 08:24 à 16:18 », il ne reste qu'à
            // taper les heures. Rien n'est envoyé tant qu'on n'a rien changé.
            if (!ouvert && !du && !au) {
              const auj = new Date().toISOString().slice(0, 10);
              setDu(auj);
              setAu(auj);
            }
            setOuvert((o) => !o);
          }}
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
            <input
              type="time"
              aria-label="Heure de début"
              className="champ chiffres !min-h-[40px] !w-auto !py-0 !text-[15px]"
              value={heureDe}
              onChange={(e) => tenter(du, au, e.target.value, heureA)}
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
            <input
              type="time"
              aria-label="Heure de fin"
              className="champ chiffres !min-h-[40px] !w-auto !py-0 !text-[15px]"
              value={heureA}
              onChange={(e) => tenter(du, au, heureDe, e.target.value)}
            />
          </label>
          <p className="w-full text-xs text-faible">
            Heures facultatives : sans heure, la journée entière. L’heure de fin est incluse — « à 16:18 » compte la vente de 16:18.
          </p>
          {refus && <p className="text-sm font-semibold text-alerte-txt">{MESSAGES_REFUS[refus]}</p>}
        </div>
      )}
    </div>
  );
}
