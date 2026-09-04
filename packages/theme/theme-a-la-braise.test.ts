import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const commande = readFileSync(new URL('../../apps/caisse/src/screens/Commande.tsx', import.meta.url), 'utf8');

describe('thème À la Braise', () => {
  it('possède une identité noire, or et rouge distincte de Samer', () => {
    const bloc = css.match(/:root\[data-marque='A_LA_BRAISE'\][\s\S]*?\n}/)?.[0] ?? '';
    expect(bloc).toContain('--ard-900: #070604');
    expect(bloc).toContain('--marque: #d99a2b');
    expect(bloc).toContain('--braise-rouge: #be2e36');
    expect(bloc).toContain('--cat-pizzas: var(--braise-rouge)');
    expect(bloc).toContain('--plan: #12100d');
  });

  it('demande la palette propre au restaurant pour les catégories', () => {
    expect(commande).toContain('couleurCategorie(c.nom, session?.restaurant.marque)');
  });
});
