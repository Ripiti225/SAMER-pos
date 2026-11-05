/**
 * Correction du stock initial. Le caissier saisit le stock À L'OUVERTURE du
 * shift, pas celui qu'il a sous les yeux : les sorties sont rappelées pour lui
 * permettre de faire le lien. L'écran prévient, le serveur décide.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { effetCorrectionSortant, type LigneSortantCorrection } from '@pos/shared';
import { api } from '../api';
import { Modale } from './Modale';

interface ContexteCorrection {
  stock_reporte: number;
  sorties_payees: number;
  sorties_en_cours: number;
  sortant_nom: string | null;
  meme_caissier: boolean;
  intermediaire: boolean;
  ligne_sortant: LigneSortantCorrection | null;
}

type TypeCode = 'sortant' | 'manager';

const qte = (n: number): string => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

const corpsCode = (type: TypeCode, pin: string) => (type === 'sortant' ? { pin_sortant: pin } : { pin_manager: pin });

function ChoixCode({
  nomSortant,
  pin,
  setPin,
  type,
  setType,
}: {
  nomSortant: string | null;
  pin: string;
  setPin: (valeur: string) => void;
  type: TypeCode;
  setType: (type: TypeCode) => void;
}) {
  return (
    <div>
      <div className="mb-2 grid grid-cols-2 gap-2">
        {(['sortant', 'manager'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setType(t);
              setPin('');
            }}
            className={type === t ? 'btn-accent' : 'btn-blanc'}
          >
            {t === 'sortant' ? `Code de ${nomSortant ?? 'l’ancien caissier'}` : 'Code manager'}
          </button>
        ))}
      </div>
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-label={type === 'sortant' ? 'Code du caissier sortant' : 'Code du manager'}
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 text-2xl tracking-[0.4em] outline-none focus:border-marque"
      />
    </div>
  );
}

export function ModaleCorrectionStock({
  ligne,
  onFermer,
  onCorrige,
  onErreur,
}: {
  ligne: { produit_id: string; nom: string; unite: string };
  onFermer: () => void;
  onCorrige: () => void;
  onErreur: (message: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['correction-stock', ligne.produit_id],
    gcTime: 0,
    queryFn: () => api<ContexteCorrection>(`/api/inventaire/lignes/${ligne.produit_id}/correction`),
  });
  const [valeur, setValeur] = useState('');
  const [explication, setExplication] = useState('');
  const [pin, setPin] = useState('');
  const [type, setType] = useState<TypeCode>('sortant');

  const nombre = valeur.trim() === '' ? null : Number(valeur);
  const effet = data?.ligne_sortant && nombre !== null ? effetCorrectionSortant(data.ligne_sortant, nombre) : null;
  const peutSigner = Boolean(effet?.litige) && !data?.meme_caissier && !data?.intermediaire;

  const corriger = useMutation({
    mutationFn: () =>
      api(`/api/inventaire/lignes/${ligne.produit_id}/corriger-initial`, {
        method: 'POST',
        corps: {
          stock_initial: nombre,
          explication,
          ...(peutSigner && pin ? corpsCode(type, pin) : {}),
        },
      }),
    onSuccess: onCorrige,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  return (
    <Modale
      titre={`Modifier le stock initial — ${ligne.nom}`}
      onFermer={onFermer}
      enfants={
        !data ? (
          <p className="py-8 text-center text-doux">Chargement…</p>
        ) : (
          <div className="space-y-4">
            <div className="rounded-jeton bg-surface-douce px-4 py-3 text-sm text-doux">
              <div>
                Chiffre repris : <b className="text-fort">{qte(data.stock_reporte)} {ligne.unite}</b>
                {data.sortant_nom ? ` (${data.sortant_nom})` : ''}
              </div>
              <div>
                Déjà sorti depuis l’ouverture : <b className="text-fort">{qte(data.sorties_payees)}</b> payé,{' '}
                <b className="text-fort">{qte(data.sorties_en_cours)}</b> en cours
              </div>
            </div>
            <div>
              <div className="mb-2 text-sm font-semibold text-doux">Stock à l’ouverture du shift</div>
              <input
                type="number"
                inputMode="decimal"
                step="any"
                min={0}
                autoFocus
                aria-label="Stock à l’ouverture du shift"
                value={valeur}
                onChange={(e) => setValeur(e.target.value)}
                className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 text-2xl font-bold tabular-nums outline-none focus:border-marque"
              />
            </div>
            <div>
              <div className="mb-2 text-sm font-semibold text-doux">Explication (obligatoire)</div>
              <input
                type="text"
                aria-label="Explication"
                value={explication}
                onChange={(e) => setExplication(e.target.value)}
                placeholder="Ex. recompté à la prise de poste"
                className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 outline-none focus:border-marque"
              />
            </div>
            {effet && (
              <div
                className={`rounded-jeton px-4 py-3 text-sm font-semibold ${
                  effet.litige ? 'bg-attente-tint text-attente-txt' : 'bg-ok-tint text-ok-txt'
                }`}
              >
                {effet.litige
                  ? `Manquant de ${qte(effet.manque_apres - effet.manque_avant)} pour ${data.sortant_nom ?? 'le caissier sortant'}`
                  : 'Aucun litige'}
              </div>
            )}
            {peutSigner && (
              <div>
                <p className="mb-2 text-sm text-doux">
                  Facultatif. Sans code, un manager pourra valider avant la clôture. Sinon, la décision se prendra dans
                  SamerTrackly.
                </p>
                <ChoixCode nomSortant={data.sortant_nom} pin={pin} setPin={setPin} type={type} setType={setType} />
              </div>
            )}
            {effet?.litige && data.intermediaire && (
              <p className="text-sm text-doux">
                Le shift précédent a été débloqué sans comptage : la décision se prendra dans SamerTrackly.
              </p>
            )}
            <button
              type="button"
              disabled={nombre === null || nombre < 0 || !explication.trim() || corriger.isPending}
              className="btn-accent w-full py-4 text-lg disabled:opacity-50"
              onClick={() => corriger.mutate()}
            >
              Enregistrer la correction
            </button>
          </div>
        )
      }
    />
  );
}

export function ModaleValiderCorrection({
  correction,
  onFermer,
  onValide,
  onErreur,
}: {
  correction: { id: string; produit_nom: string; sortant_nom: string | null };
  onFermer: () => void;
  onValide: () => void;
  onErreur: (message: string) => void;
}) {
  const [pin, setPin] = useState('');
  const [type, setType] = useState<TypeCode>('manager');

  const validerCorrection = useMutation({
    mutationFn: () =>
      api(`/api/inventaire/corrections/${correction.id}/valider`, { method: 'POST', corps: corpsCode(type, pin) }),
    onSuccess: onValide,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  return (
    <Modale
      titre={`Valider — ${correction.produit_nom}`}
      onFermer={onFermer}
      enfants={
        <div className="space-y-4">
          <p className="text-sm text-doux">
            Valider fait payer le manquant à <b className="text-fort">{correction.sortant_nom ?? 'l’ancien caissier'}</b>.
          </p>
          <ChoixCode nomSortant={correction.sortant_nom} pin={pin} setPin={setPin} type={type} setType={setType} />
          <button
            type="button"
            disabled={pin.length < 4 || validerCorrection.isPending}
            className="btn-accent w-full py-4 text-lg disabled:opacity-50"
            onClick={() => validerCorrection.mutate()}
          >
            Valider
          </button>
        </div>
      }
    />
  );
}
