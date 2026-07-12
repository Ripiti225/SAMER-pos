import { Component, type ReactNode } from 'react';

/**
 * Filet anti-page-blanche : une erreur de rendu non gérée n'efface plus tout
 * l'écran (mauvaise expérience pour un client au restaurant). On affiche un
 * message en français avec un bouton pour recharger.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { erreur: boolean }> {
  state = { erreur: false };

  static getDerivedStateFromError(): { erreur: boolean } {
    return { erreur: true };
  }

  componentDidCatch(erreur: unknown): void {
    // Trace console pour le diagnostic ; l'écran reste utilisable.
    console.error('Erreur non gérée (app client) :', erreur);
  }

  render(): ReactNode {
    if (!this.state.erreur) return this.props.children;
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 bg-fond p-8 text-center text-fort">
        <p className="text-lg font-semibold">Une erreur est survenue.</p>
        <p className="text-doux">Rechargez la page, ou appelez un serveur si cela persiste.</p>
        <button type="button" className="btn-accent min-h-[52px] px-6" onClick={() => location.reload()}>
          Recharger
        </button>
      </div>
    );
  }
}
