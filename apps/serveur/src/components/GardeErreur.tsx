import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Filet de sécurité du terminal de salle.
 *
 * Sans lui, une seule erreur de rendu démonte tout l'arbre React : le serveur
 * se retrouve devant un écran BLANC, sans rien à toucher, en plein service.
 * C'est ce qui arrivait avec `crypto.randomUUID()` en http (voir uuidLocal()).
 * La cause est corrigée ; ce garde-fou reste, parce qu'un POS doit toujours
 * offrir une porte de sortie plutôt qu'une page vide.
 */
export class GardeErreur extends Component<{ enfants: ReactNode }, { erreur: Error | null }> {
  state: { erreur: Error | null } = { erreur: null };

  static getDerivedStateFromError(erreur: Error) {
    return { erreur };
  }

  componentDidCatch(erreur: Error, infos: ErrorInfo) {
    // Sans réseau ni console ouverte, la trace doit rester lisible sur place.
    console.error('Erreur de rendu du terminal serveur :', erreur, infos.componentStack);
  }

  render() {
    if (!this.state.erreur) return this.props.enfants;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 p-6 text-center">
        <div className="text-2xl font-bold text-alerte">L’écran s’est interrompu</div>
        <p className="max-w-sm text-doux">
          Rien n’est perdu côté caisse : les commandes déjà envoyées en cuisine sont enregistrées.
          Rechargez pour reprendre le service.
        </p>
        <button type="button" className="btn-accent min-h-[52px] px-8 text-lg" onClick={() => location.reload()}>
          Recharger l’application
        </button>
        <details className="max-w-full text-left text-xs text-faible">
          <summary className="cursor-pointer">Détail technique (pour l’assistance)</summary>
          <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words">
            {this.state.erreur.message}
          </pre>
        </details>
      </div>
    );
  }
}
