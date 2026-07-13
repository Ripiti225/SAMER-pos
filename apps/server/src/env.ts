// Charge apps/server/.env dans process.env s'il existe (Node ≥ 20.12).
// Importé en tout premier par index.ts pour que les clés (SamerTrackly, DB…)
// soient disponibles avant l'exécution des autres modules.
try {
  process.loadEnvFile();
} catch {
  /* pas de fichier .env : on se rabat sur les variables d'environnement système */
}
