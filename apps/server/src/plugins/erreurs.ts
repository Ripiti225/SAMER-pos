import type { FastifyInstance } from 'fastify';
import { ErreurMetier } from '../lib/erreurs.js';

/**
 * Gestion d'erreurs en français courant (§15) :
 * jamais de code technique ni d'anglais dans le message renvoyé à la caisse.
 */
export function enregistrerGestionErreurs(app: FastifyInstance): void {
  app.setErrorHandler((erreur, _req, reply) => {
    if (erreur instanceof ErreurMetier) {
      return reply.status(erreur.statusCode).send({ erreur: erreur.message });
    }
    // Contrainte d'unicité du service ouvert (index un_service_ouvert_par_caissier)
    if ((erreur as { code?: string }).code === '23505') {
      return reply.status(409).send({ erreur: 'Cette opération entre en conflit avec un enregistrement existant' });
    }
    // Violation de clé étrangère (23503) : le plus souvent une référence devenue
    // invalide — par ex. une action auditée par une session dont le compte a été
    // supprimé/réinitialisé. On log et on demande de se reconnecter plutôt que
    // d'afficher un « erreur interne » opaque.
    if ((erreur as { code?: string }).code === '23503') {
      app.log.error(erreur);
      return reply.status(409).send({ erreur: 'Reconnectez-vous, puis réessayez cette action' });
    }
    app.log.error(erreur);
    return reply.status(500).send({ erreur: 'Une erreur interne est survenue, réessayez' });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ erreur: 'Page ou ressource introuvable' });
  });
}
