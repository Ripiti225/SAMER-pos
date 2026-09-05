export function destinationAddition(table: { commande_id: string | null }) {
  return table.commande_id
    ? { ecran: 'commande' as const, commandeId: table.commande_id }
    : { ecran: 'tables' as const, commandeId: null };
}
