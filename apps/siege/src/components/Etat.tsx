/** Bandeau d'erreur, en français courant — jamais un code technique. */
export function Erreur({ texte }: { texte: string }) {
  return <div className="mb-4 rounded-jeton bg-alerte-tint px-4 py-3 text-alerte-txt">{texte}</div>;
}

/** Bandeau explicatif (fond informatif). */
export function Info({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 rounded-jeton bg-info-tint px-4 py-3 text-info-txt">{children}</div>;
}

/** Squelettes plutôt qu'un écran « Chargement… » vide (DESIGN_V2 § 5). */
export function Squelette({ lignes = 3 }: { lignes?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: lignes }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-jeton border border-filet bg-carte-douce" />
      ))}
    </div>
  );
}

/** Pastille de marque : chaque enseigne garde sa couleur d'accent. */
export function PastilleMarque({ marque }: { marque: 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE' }) {
  const couleur = marque === 'AL_KAYAN' ? '#2d7d46' : marque === 'A_LA_BRAISE' ? '#d89a2b' : '#ef9f27';
  const titre = marque === 'AL_KAYAN' ? 'Al Kayan' : marque === 'A_LA_BRAISE' ? 'À la Braise' : 'Chez Samer';
  return (
    <span
      className="inline-block h-2.5 w-2.5 flex-none rounded-full"
      style={{ background: couleur }}
      title={titre}
    />
  );
}
