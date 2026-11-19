/**
 * Pointage par téléphone (2026-11-19) — page ouverte sur le téléphone de
 * l'employé, servie par le mini-PC : elle ne marche que sur le wifi du
 * restaurant. Parcours : (compte) → PIN → Arrivée/Départ → selfie → envoyé.
 *
 * Rien de sensible n'est gardé sur le téléphone : le PIN reste en mémoire le
 * temps du pointage, la clé du téléphone est un cookie httpOnly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ErreurApi } from '../api';
import { PavePin } from './PavePin';
import { reduireSelfie } from './selfie';

interface Compte {
  id: string;
  nom_complet: string;
  photo_url: string | null;
  doit_definir_pin?: boolean;
}

interface Etat {
  actif: boolean;
  restaurant: { nom: string; marque: string; couleur_hex: string } | null;
  compte: Compte | null;
}

interface Presence {
  service_ouvert: boolean;
  arrivee: string | null;
  depart: string | null;
  source: string | null;
  en_attente: boolean;
  action: 'ARRIVEE' | 'DEPART' | 'AUCUNE';
}

type Ecran =
  | { nom: 'chargement' }
  | { nom: 'injoignable' }
  | { nom: 'inactif' }
  | { nom: 'comptes' }
  | { nom: 'pin'; compte: Compte }
  | { nom: 'premier-pin'; compte: Compte }
  | { nom: 'pointer'; compte: Compte; pin: string; presence: Presence }
  | { nom: 'selfie'; compte: Compte; pin: string; sens: 'ENTREE' | 'SORTIE'; photo: string }
  | { nom: 'fait'; message: string };

/** Après un pointage réussi, retour à l'accueil (le PIN est oublié). */
const DELAI_RETOUR_MS = 6000;

const SOURCES: Record<string, string> = {
  POINTEUSE: 'à la pointeuse',
  TELEPHONE: 'au téléphone',
  CAISSE: 'à la caisse',
  OUVERTURE: 'à l’ouverture',
};

function heure(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' });
}

function message(e: unknown): string {
  return e instanceof ErreurApi ? e.message : 'Une erreur est survenue. Réessayez.';
}

export function AppPointage() {
  const [etat, setEtat] = useState<Etat | null>(null);
  const [ecran, setEcran] = useState<Ecran>({ nom: 'chargement' });
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState(false);

  const accueil = useCallback(async () => {
    setErreur(null);
    try {
      const e = await api<Etat>('/api/pointage-tel/etat');
      setEtat(e);
      if (e.restaurant?.marque) document.documentElement.dataset.marque = e.restaurant.marque;
      if (!e.actif) return setEcran({ nom: 'inactif' });
      if (e.compte) return setEcran({ nom: e.compte.doit_definir_pin ? 'premier-pin' : 'pin', compte: e.compte });
      setEcran({ nom: 'comptes' });
    } catch {
      setEcran({ nom: 'injoignable' });
    }
  }, []);

  useEffect(() => {
    void accueil();
  }, [accueil]);

  useEffect(() => {
    if (ecran.nom !== 'fait') return;
    const t = setTimeout(() => void accueil(), DELAI_RETOUR_MS);
    return () => clearTimeout(t);
  }, [ecran, accueil]);

  const executer = async (action: () => Promise<void>) => {
    setErreur(null);
    setOccupe(true);
    try {
      await action();
    } catch (e) {
      setErreur(message(e));
    } finally {
      setOccupe(false);
    }
  };

  const identifier = (compte: Compte, pin: string) =>
    executer(async () => {
      const r = await api<{ compte: Compte; presence: Presence }>('/api/pointage-tel/identifier', {
        method: 'POST',
        corps: { utilisateur_id: compte.id, pin },
      });
      setEcran({ nom: 'pointer', compte: r.compte, pin, presence: r.presence });
    });

  const envoyer = (e: Extract<Ecran, { nom: 'selfie' }>) =>
    executer(async () => {
      const r = await api<{ message: string }>('/api/pointage-tel/pointer', {
        method: 'POST',
        corps: { utilisateur_id: e.compte.id, pin: e.pin, sens: e.sens, photo: e.photo },
      });
      setEcran({ nom: 'fait', message: r.message });
    });

  return (
    <div className="min-h-full bg-vitrine-fond text-vitrine-txt flex flex-col">
      <header className="px-4 pt-6 pb-3 text-center">
        <div className="text-xs uppercase tracking-wider text-vitrine-txt-faible">Pointage</div>
        <div className="text-lg font-semibold">{etat?.restaurant?.nom ?? 'Chez Samer / Al Kayan'}</div>
      </header>

      <main className="flex-1 px-4 pb-8 w-full max-w-md mx-auto flex flex-col gap-4">
        {erreur && (
          <div role="alert" className="rounded-xl bg-alerte-tint text-alerte-txt px-4 py-3 text-base">
            {erreur}
          </div>
        )}

        {ecran.nom === 'chargement' && <p className="text-center text-vitrine-txt-doux mt-10">Chargement…</p>}

        {ecran.nom === 'injoignable' && (
          <Bloc titre="Connectez-vous au wifi du restaurant">
            <p>Le pointage ne marche que sur le wifi du restaurant. Vérifiez que le téléphone y est connecté, puis réessayez.</p>
            <Bouton onClick={() => void accueil()}>Réessayer</Bouton>
          </Bloc>
        )}

        {ecran.nom === 'inactif' && (
          <Bloc titre="Pointage par téléphone désactivé">
            <p>Ce restaurant ne pointe pas encore au téléphone. Pointez à la pointeuse ou à la caisse.</p>
          </Bloc>
        )}

        {ecran.nom === 'comptes' && (
          <ChoixCompte
            onChoisir={(c) => setEcran({ nom: c.doit_definir_pin ? 'premier-pin' : 'pin', compte: c })}
            onErreur={setErreur}
          />
        )}

        {ecran.nom === 'pin' && (
          <>
            <Identite compte={ecran.compte} />
            <PavePin
              libelle="Tapez votre PIN"
              occupe={occupe}
              onValider={(pin) => void identifier(ecran.compte, pin)}
            />
            {!etat?.compte && <Lien onClick={() => setEcran({ nom: 'comptes' })}>Ce n’est pas moi</Lien>}
          </>
        )}

        {ecran.nom === 'premier-pin' && (
          <PremierPin
            compte={ecran.compte}
            occupe={occupe}
            onValider={(code, pin) =>
              void executer(async () => {
                await api('/api/auth/poser-pin', {
                  method: 'POST',
                  corps: { utilisateur_id: ecran.compte.id, code_temporaire: code, pin, pin_confirmation: pin },
                });
                setEcran({ nom: 'pin', compte: { ...ecran.compte, doit_definir_pin: false } });
              })}
            onRetour={() => setEcran({ nom: 'comptes' })}
          />
        )}

        {ecran.nom === 'pointer' && (
          <EcranPointer
            ecran={ecran}
            onPhoto={(sens, photo) => setEcran({ nom: 'selfie', compte: ecran.compte, pin: ecran.pin, sens, photo })}
            onErreur={setErreur}
          />
        )}

        {ecran.nom === 'selfie' && (
          <Bloc titre={ecran.sens === 'ENTREE' ? 'Votre arrivée' : 'Votre départ'}>
            <img src={ecran.photo} alt="Votre selfie" className="w-full rounded-xl" />
            <Bouton onClick={() => void envoyer(ecran)} desactive={occupe}>
              {occupe ? 'Envoi…' : 'Envoyer le pointage'}
            </Bouton>
            <Lien onClick={() => setEcran({ nom: 'pin', compte: ecran.compte })}>Annuler</Lien>
          </Bloc>
        )}

        {ecran.nom === 'fait' && (
          <Bloc titre="C’est noté ✓">
            <p className="text-xl">{ecran.message}</p>
          </Bloc>
        )}
      </main>
    </div>
  );
}

function EcranPointer({
  ecran,
  onPhoto,
  onErreur,
}: {
  ecran: Extract<Ecran, { nom: 'pointer' }>;
  onPhoto: (sens: 'ENTREE' | 'SORTIE', photo: string) => void;
  onErreur: (m: string) => void;
}) {
  const champ = useRef<HTMLInputElement>(null);
  const { presence } = ecran;
  const sens = presence.action === 'DEPART' ? 'SORTIE' : 'ENTREE';

  const surFichier = async (f: File | undefined) => {
    if (!f) return;
    try {
      onPhoto(sens, await reduireSelfie(f));
    } catch {
      onErreur('Le selfie n’a pas pu être lu. Reprenez la photo.');
    }
  };

  return (
    <>
      <Identite compte={ecran.compte} />
      <div className="rounded-xl bg-vitrine-surface border border-vitrine-bordure px-4 py-3 text-base space-y-1">
        <div>
          Arrivée : {presence.arrivee
            ? <strong>{heure(presence.arrivee)} {presence.source ? SOURCES[presence.source] ?? '' : ''}</strong>
            : <span className="text-vitrine-txt-faible">pas encore pointée</span>}
        </div>
        <div>
          Départ : {presence.depart
            ? <strong>{heure(presence.depart)}</strong>
            : <span className="text-vitrine-txt-faible">pas encore pointé</span>}
        </div>
        {presence.en_attente && !presence.service_ouvert && (
          <div className="text-sm text-vitrine-txt-doux">Le shift n’est pas encore ouvert : votre arrivée y sera reprise.</div>
        )}
      </div>

      {presence.action === 'AUCUNE' ? (
        <p className="text-center text-vitrine-txt-doux">
          {presence.depart ? 'Votre journée est terminée. À demain !' : 'Le départ se pointera une fois le shift ouvert à la caisse.'}
        </p>
      ) : (
        <>
          {/* capture="user" : la caméra de face s'ouvre directement (selfie). */}
          <input
            ref={champ}
            type="file"
            accept="image/*"
            capture="user"
            className="hidden"
            onChange={(e) => {
              void surFichier(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Bouton onClick={() => champ.current?.click()}>
            {sens === 'ENTREE' ? 'Je pointe mon arrivée' : 'Je pointe mon départ'}
          </Bouton>
          <p className="text-center text-sm text-vitrine-txt-doux">Un selfie est demandé à chaque pointage.</p>
        </>
      )}
    </>
  );
}

function ChoixCompte({ onChoisir, onErreur }: { onChoisir: (c: Compte) => void; onErreur: (m: string) => void }) {
  const [comptes, setComptes] = useState<Compte[] | null>(null);
  const [recherche, setRecherche] = useState('');

  useEffect(() => {
    api<Compte[]>('/api/pointage-tel/comptes').then(setComptes).catch((e) => onErreur(message(e)));
  }, [onErreur]);

  const filtre = recherche.trim().toLowerCase();
  const visibles = (comptes ?? []).filter((c) => !filtre || c.nom_complet.toLowerCase().includes(filtre));

  return (
    <>
      <h1 className="text-xl font-semibold text-center">Qui êtes-vous ?</h1>
      <p className="text-center text-sm text-vitrine-txt-doux">
        Ce téléphone sera rattaché à votre compte : il ne pourra servir qu’à vous.
      </p>
      <input
        type="search"
        value={recherche}
        onChange={(e) => setRecherche(e.target.value)}
        placeholder="Chercher mon nom"
        className="min-h-[48px] rounded-xl px-4 bg-vitrine-surface border border-vitrine-bordure text-base"
      />
      <ul className="flex flex-col gap-2">
        {comptes === null && <li className="text-center text-vitrine-txt-doux">Chargement…</li>}
        {visibles.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onChoisir(c)}
              className="w-full min-h-[56px] rounded-xl px-4 flex items-center gap-3 bg-vitrine-surface border border-vitrine-bordure text-left text-base"
            >
              <Avatar compte={c} />
              {c.nom_complet}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function PremierPin({
  compte,
  occupe,
  onValider,
  onRetour,
}: {
  compte: Compte;
  occupe: boolean;
  onValider: (code: string, pin: string) => void;
  onRetour: () => void;
}) {
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const pret = /^\d{6}$/.test(code) && /^\d{4,6}$/.test(pin);
  const champ = 'min-h-[52px] rounded-xl px-4 bg-vitrine-surface border border-vitrine-bordure text-xl tracking-widest text-center';
  return (
    <>
      <Identite compte={compte} />
      <Bloc titre="Créez votre PIN">
        <p className="text-sm text-vitrine-txt-doux">Demandez votre code temporaire (6 chiffres) au gérant.</p>
        <input className={champ} inputMode="numeric" maxLength={6} placeholder="Code temporaire" value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        <input className={champ} inputMode="numeric" type="password" maxLength={6} placeholder="Nouveau PIN (4 à 6 chiffres)" value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        <Bouton onClick={() => onValider(code, pin)} desactive={!pret || occupe}>Créer mon PIN</Bouton>
        <Lien onClick={onRetour}>Retour</Lien>
      </Bloc>
    </>
  );
}

function Identite({ compte }: { compte: Compte }) {
  return (
    <div className="flex flex-col items-center gap-2 mt-2">
      <Avatar compte={compte} grand />
      <div className="text-xl font-semibold">Bonjour {compte.nom_complet.split(' ')[0]}</div>
    </div>
  );
}

function Avatar({ compte, grand = false }: { compte: Compte; grand?: boolean }) {
  const taille = grand ? 'w-20 h-20 text-2xl' : 'w-10 h-10 text-base';
  return compte.photo_url ? (
    <img src={compte.photo_url} alt="" className={`${taille} rounded-full object-cover`} />
  ) : (
    <div className={`${taille} rounded-full bg-marque text-sur-marque flex items-center justify-center font-semibold`}>
      {compte.nom_complet.charAt(0).toUpperCase()}
    </div>
  );
}

function Bloc({ titre, children }: { titre: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-vitrine-surface border border-vitrine-bordure p-4 flex flex-col gap-3 mt-2">
      <h1 className="text-xl font-semibold">{titre}</h1>
      {children}
    </section>
  );
}

function Bouton({ children, onClick, desactive = false }: { children: React.ReactNode; onClick: () => void; desactive?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={desactive}
      className="min-h-[60px] rounded-xl bg-marque text-sur-marque text-lg font-semibold disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Lien({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="min-h-[48px] text-vitrine-txt-doux underline">
      {children}
    </button>
  );
}
