import type { FastifyInstance } from 'fastify';
import { ErreurMetier } from '../lib/erreurs.js';
import { enregistrerIncident, expliquerErreur } from '../modules/sante/incidents.js';

/**
 * Gestion d'erreurs en français courant (§15) :
 * jamais de code technique ni d'anglais dans le message renvoyé à la caisse.
 */
export function enregistrerGestionErreurs(app: FastifyInstance): void {
  app.setErrorHandler(async (erreur, req, reply) => {
    if (erreur instanceof ErreurMetier) {
      if (erreur.statusCode < 500) return reply.status(erreur.statusCode).send({ erreur: erreur.message });
      const incident = await enregistrerIncident('API', erreur, {
        methode: req.method, chemin: req.url, request_id: req.id,
        utilisateur_id: req.session?.utilisateur_id ?? null,
      }, erreur.message);
      const reference = incident ? ` Incident ${incident.id.slice(0, 8)} enregistré dans Santé du système.` : '';
      return reply.status(erreur.statusCode).send({ erreur: `${erreur.message}${reference}` });
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
      const incident = await enregistrerIncident('BASE_DE_DONNEES', erreur, {
        methode: req.method, chemin: req.url, request_id: req.id,
        utilisateur_id: req.session?.utilisateur_id ?? null,
      });
      const reference = incident ? ` Incident ${incident.id.slice(0, 8)}.` : '';
      return reply.status(409).send({ erreur: `${incident?.message_fr ?? expliquerErreur(erreur, { chemin: req.url })}${reference}` });
    }
    app.log.error(erreur);
    const incident = await enregistrerIncident('API', erreur, {
      methode: req.method, chemin: req.url, request_id: req.id,
      utilisateur_id: req.session?.utilisateur_id ?? null,
    });
    const message = incident?.message_fr ?? expliquerErreur(erreur, { chemin: req.url });
    const reference = incident ? ` Incident ${incident.id.slice(0, 8)} enregistré dans Santé du système.` : '';
    return reply.status(500).send({ erreur: `${message}${reference}` });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ erreur: 'Page ou ressource introuvable' });
  });
}
