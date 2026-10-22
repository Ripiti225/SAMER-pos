import type { StockPlat } from '@pos/shared';

/**
 * Stock en cuisine sous la photo d'un plat (caisse et tablette serveur).
 *
 * Une petite bande en bas de la photo, pas un bloc de plus sous la vignette :
 * la grille garde sa hauteur et le nom du plat reste lisible. Trois états :
 *  - normal : bande sombre discrète, on la lit si on la cherche ;
 *  - bientôt épuisé (seuil du site) : bande orange, le même orange que la
 *    pastille de synchro (`SanteSync`) ;
 *  - épuisé : photo grisée et « ÉPUISÉ » en rouge. La vignette reste
 *    CLIQUABLE — le stock est théorique, une livraison non saisie suffit à le
 *    tromper ; c'est au personnel de trancher, pas à l'écran.
 *
 * À placer DANS le conteneur `relative` de la photo.
 */
export function BandeStock({ stock }: { stock: StockPlat | undefined }) {
  if (!stock) return null;
  const epuise = stock.etat === 'EPUISE';
  const fond = epuise ? 'bg-alerte' : stock.etat === 'BIENTOT' ? 'bg-[#D85A30]' : 'bg-black/55';
  return (
    <>
      {epuise && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/35 backdrop-grayscale">
          <span className="rounded-full bg-alerte px-2.5 py-0.5 text-xs font-bold tracking-wide text-white shadow-e1">ÉPUISÉ</span>
        </div>
      )}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-[11px] font-semibold leading-tight text-white tabular-nums ${fond}`}
        title={stock.texte}
      >
        {stock.texte}
      </div>
    </>
  );
}

/**
 * Événements WebSocket après lesquels le stock a pu bouger : une vente, un
 * envoi en cuisine, une annulation (`commande*`), une réception ou une
 * correction des Réglages (`inventaire`), une relève (`service`), un plat
 * ajouté ou retiré (`catalogue`).
 */
export function evenementToucheStock(type: string): boolean {
  return type.startsWith('commande') || type === 'inventaire' || type === 'service' || type === 'catalogue';
}

/** Filet de sécurité si un événement est perdu (WiFi coupé, mise en veille). */
export const INTERVALLE_STOCK_PLATS_MS = 60_000;
