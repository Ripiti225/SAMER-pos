import { useState } from 'react';
import { Modale } from './Modale';
import { Numpad } from './Numpad';

interface Props {
  titre: string;
  demanderMotif?: boolean;
  demanderMontant?: boolean;
  onConfirmer: (donnees: { pin: string; motif: string; montant: number }) => void;
  onFermer: () => void;
  enCours?: boolean;
  /** « PIN manager » par défaut ; « PIN administrateur » pour annuler un paiement. */
  libellePin?: string;
  /** Une ligne d'explication sous le titre (ce que l'action va défaire). */
  explication?: string;
}

/**
 * Action protégée : PIN manager + motif obligatoires (remise, annulation
 * d'article envoyé en cuisine, réouverture d'une note payée). Sert aussi au
 * PIN administrateur (annulation d'un paiement) : seul le libellé change, le
 * serveur décide qui a l'autorité.
 */
export function ModalePinManager({
  titre,
  demanderMotif = true,
  demanderMontant = false,
  onConfirmer,
  onFermer,
  enCours,
  libellePin = 'PIN manager',
  explication,
}: Props) {
  const [pin, setPin] = useState('');
  const [motif, setMotif] = useState('');
  const [montant, setMontant] = useState('');

  const pret =
    pin.length >= 4 && (!demanderMotif || motif.trim().length >= 3) && (!demanderMontant || Number(montant) > 0);

  return (
    <Modale titre={titre} onFermer={onFermer} enfants={
      <div className="space-y-4">
        {explication && <p className="text-sm text-doux">{explication}</p>}
        {demanderMontant && (
          <div>
            <label className="mb-1 block text-sm text-doux">Montant (FCFA)</label>
            <input
              className="champ"
              inputMode="numeric"
              value={montant}
              onChange={(e) => setMontant(e.target.value.replace(/\D/g, ''))}
              placeholder="ex : 1000"
            />
          </div>
        )}
        {demanderMotif && (
          <div>
            <label className="mb-1 block text-sm text-doux">Motif (obligatoire)</label>
            <input
              className="champ"
              value={motif}
              onChange={(e) => setMotif(e.target.value)}
              placeholder="ex : Client fidèle, erreur de saisie…"
            />
          </div>
        )}
        <div>
          <label className="mb-1 block text-sm text-doux">{libellePin}</label>
          <div className="champ mb-2 flex items-center text-2xl tracking-[0.5em]">
            {'•'.repeat(pin.length) || <span className="text-doux text-base tracking-normal">Saisir le PIN…</span>}
          </div>
          <Numpad
            valeur={pin}
            onChange={setPin}
            longueurMax={6}
            code
            onValider={() => onConfirmer({ pin, motif: motif.trim(), montant: Number(montant) })}
            libelleValider={enCours ? 'Vérification…' : 'Confirmer'}
            validerDesactive={!pret || enCours}
          />
        </div>
      </div>
    } />
  );
}
