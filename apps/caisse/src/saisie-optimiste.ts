/**
 * Saisie optimiste de l'addition : le doigt du caissier ne doit JAMAIS attendre
 * le serveur. Une ligne tapée apparaît immédiatement, une quantité suit le tap.
 *
 * RÈGLE ABSOLUE — AUCUN CALCUL MONÉTAIRE CÔTÉ CLIENT.
 * L'optimisme porte uniquement sur des éléments NON monétaires : la présence
 * d'une ligne, son nom, sa quantité. Aucun montant n'est jamais inventé ici :
 *  - le total dépend de la meilleure promotion active à l'horloge du SERVEUR,
 *    puis d'un écrêtage en cascade remise → promo → fidélité (non commutatif) ;
 *  - le prix unitaire d'un nouvel article dépend du canal (prix_canaux en
 *    emporter/livraison), que le catalogue local peut ignorer.
 * Une ligne en attente s'affiche donc SANS montant, et les totaux gardent la
 * dernière valeur confirmée par le serveur. C'est ce qui garantit qu'un montant
 * faux ne peut pas exister, même une fraction de seconde — le total est lu à
 * voix haute au client et sert de base à l'encaissement.
 *
 * Les mutations sont SÉRIALISÉES (une requête en vol à la fois) :
 *  - le serveur verrouille la commande (FOR UPDATE) à chaque opération, le
 *    parallélisme n'apporterait aucun débit réel ;
 *  - deux PATCH concurrents sur le même article n'ont pas d'ordre garanti — la
 *    quantité finale en base pourrait être l'ancienne ;
 *  - deux POST concurrents pourraient afficher une ligne à la fois confirmée et
 *    encore en attente (doublon visuel fugace).
 * En prime, l'ordre des lignes du ticket suit exactement l'ordre des taps.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommandeItemVue, CommandeVue } from '@pos/shared';
import { api, ErreurApi } from './api';
import { attendreEcho } from './echo-mutations';

/** Quantité maximale par ligne — miroir de ModifierItemSchema (@pos/shared). */
const QUANTITE_MAX = 99;

/** Ligne tapée, pas encore créée en base. */
export interface LigneEnAttente {
  cle: string;
  nom: string;
  quantite: number;
}

type Operation =
  | { genre: 'ajout'; cle: string; corps: unknown }
  | { genre: 'quantite'; itemId: string };

// Compteur local : `crypto.randomUUID()` n'existe QU'EN contexte sécurisé, et
// la caisse tourne en http://IP-LAN (même piège que apps/client/PageTable.tsx).
let compteur = 0;
function nouvelleCle(): string {
  compteur += 1;
  return `attente-${compteur}`;
}

export function useSaisieOptimiste(commandeId: string | null, surErreur: (e: Error) => void) {
  const queryClient = useQueryClient();
  const [lignesEnAttente, setLignesEnAttente] = useState<LigneEnAttente[]>([]);
  /** Quantités visées par le doigt, en attente de confirmation serveur. */
  const [cibles, setCibles] = useState<Record<string, number>>({});

  // Miroir des cibles lisible depuis les callbacks asynchrones : l'état React
  // y serait périmé (fermeture capturée au moment de l'empilement).
  const ciblesRef = useRef<Record<string, number>>({});
  const file = useRef<Operation[]>([]);
  const enVol = useRef(false);

  const poserCible = useCallback((itemId: string, quantite: number) => {
    ciblesRef.current = { ...ciblesRef.current, [itemId]: quantite };
    setCibles(ciblesRef.current);
  }, []);

  const retirerCible = useCallback((itemId: string) => {
    const copie = { ...ciblesRef.current };
    delete copie[itemId];
    ciblesRef.current = copie;
    setCibles(copie);
  }, []);

  // Changement de commande : on repart d'un état propre (l'écran est réutilisé).
  useEffect(() => {
    file.current = [];
    enVol.current = false;
    ciblesRef.current = {};
    setCibles({});
    setLignesEnAttente([]);
  }, [commandeId]);

  const traiter = useCallback(
    async (op: Operation): Promise<void> => {
      if (!commandeId) return;
      // Jeton posé AVANT l'envoi : le serveur diffuse juste après le commit,
      // l'écho peut arriver avant que React ait traité la réponse HTTP.
      const echo = attendreEcho(commandeId);

      try {
        let vue: CommandeVue;
        if (op.genre === 'ajout') {
          vue = await api<CommandeVue>(`/api/commandes/${commandeId}/items`, {
            method: 'POST',
            corps: op.corps,
          });
        } else {
          const quantite = ciblesRef.current[op.itemId];
          if (quantite === undefined) {
            echo.abandonner();
            return;
          }
          vue = await api<CommandeVue>(`/api/commandes/${commandeId}/items/${op.itemId}`, {
            method: 'PATCH',
            corps: { quantite },
          });
          // On ne lève la cible que si le doigt n'a pas retapé entre-temps :
          // sinon l'affichage doit rester sur la nouvelle valeur visée.
          if (ciblesRef.current[op.itemId] === quantite) retirerCible(op.itemId);
        }

        echo.confirmer();
        // La vue du serveur fait autorité, et la ligne en attente disparaît
        // dans le MÊME cycle de rendu : aucun doublon n'est observable.
        queryClient.setQueryData(['commande', commandeId], vue);
        if (op.genre === 'ajout') {
          setLignesEnAttente((prev) => prev.filter((l) => l.cle !== op.cle));
        }
      } catch (e) {
        // Aucun événement n'a été diffusé (le serveur lève avant de diffuser).
        echo.abandonner();
        if (op.genre === 'ajout') {
          setLignesEnAttente((prev) => prev.filter((l) => l.cle !== op.cle));
        } else {
          retirerCible(op.itemId);
        }
        surErreur(e as Error);
        // 409 = l'état réel a changé sous nos pieds (article épuisé, article
        // déjà parti en cuisine) : on resynchronise pour que le caissier voie
        // pourquoi, au lieu de retaper dans le vide.
        if (e instanceof ErreurApi && e.statusCode === 409) {
          void queryClient.invalidateQueries({ queryKey: ['catalogue'] });
          void queryClient.invalidateQueries({ queryKey: ['commande', commandeId] });
        }
      }
    },
    [commandeId, queryClient, retirerCible, surErreur],
  );

  const lancer = useCallback(() => {
    if (enVol.current) return;
    // On retire l'opération au moment de l'ENVOI (pas à la réponse) : sinon une
    // opération arrivée pendant le vol serait vue comme « déjà en file ».
    const op = file.current.shift();
    if (!op) return;
    enVol.current = true;
    void traiter(op).finally(() => {
      enVol.current = false;
      lancer();
    });
  }, [traiter]);

  /** Tap sur un article ou un combo : la ligne apparaît tout de suite. */
  const ajouter = useCallback(
    (nom: string, quantite: number, corps: unknown) => {
      const cle = nouvelleCle();
      setLignesEnAttente((prev) => [...prev, { cle, nom, quantite }]);
      file.current.push({ genre: 'ajout', cle, corps });
      lancer();
    },
    [lancer],
  );

  /** Tap sur + / − : le chiffre suit le doigt, une requête par rafale. */
  const changerQuantite = useCallback(
    (item: CommandeItemVue, delta: 1 | -1) => {
      const actuelle = ciblesRef.current[item.id] ?? item.quantite;
      const cible = Math.min(QUANTITE_MAX, Math.max(1, actuelle + delta));
      if (cible === actuelle) return;
      poserCible(item.id, cible);
      // Coalescence : l'opération ne transporte pas de valeur, elle lira la
      // cible au moment de l'envoi. Cinq taps sur + = 2 requêtes.
      const dejaEnFile = file.current.some((o) => o.genre === 'quantite' && o.itemId === item.id);
      if (!dejaEnFile) file.current.push({ genre: 'quantite', itemId: item.id });
      lancer();
    },
    [lancer, poserCible],
  );

  return {
    lignesEnAttente,
    /** Quantité à afficher : la cible du doigt si elle existe, sinon le serveur. */
    quantiteAffichee: (item: CommandeItemVue) => cibles[item.id] ?? item.quantite,
    /** true = le total de cette ligne est en cours de recalcul serveur. */
    ligneEnRecalcul: (itemId: string) => itemId in cibles,
    /** true = au moins une opération n'est pas encore confirmée. */
    enAttente: lignesEnAttente.length > 0 || Object.keys(cibles).length > 0,
    ajouter,
    changerQuantite,
    QUANTITE_MAX,
  };
}
