// Envoi au cloud depuis le poste de publication — par la console du siège.
//
// Pas de clé `service_role` sur ce PC (plan § 2) : on se connecte comme une
// personne, avec le compte siège du propriétaire (e-mail + mot de passe,
// Supabase Auth), puis on passe par la fonction `siege` comme la console web.
// Les morceaux partent directement dans le bucket privé via des URL de
// téléversement signées (`maj_preparer_envoi`) ; `maj_enregistrer` relit tout
// dans le stockage et revérifie la signature avant d'accepter.

export class ErreurCloud extends Error {
  constructor(message, statut = 0) {
    super(message);
    this.statut = statut;
  }
}

/** Lit VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY dans un fichier .env (celui de la console). */
export function lireEnvConsole(texte) {
  const valeurs = {};
  for (const ligne of String(texte).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(ligne);
    if (m) valeurs[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return { url: valeurs.VITE_SUPABASE_URL ?? null, cleAnon: valeurs.VITE_SUPABASE_ANON_KEY ?? null };
}

export class ClientSiege {
  /** `fetch` injectable pour les tests. */
  constructor({ url, cleAnon, fetch: f = globalThis.fetch }) {
    if (!url || !cleAnon) throw new ErreurCloud('Adresse du cloud ou clé publique (anon) manquante');
    this.url = url.replace(/\/+$/, '');
    this.cleAnon = cleAnon;
    this.fetch = f;
    this.session = null;
  }

  async #jetonAuth(corps, type) {
    const rep = await this.fetch(`${this.url}/auth/v1/token?grant_type=${type}`, {
      method: 'POST',
      headers: { apikey: this.cleAnon, 'content-type': 'application/json' },
      body: JSON.stringify(corps),
    });
    const data = await rep.json().catch(() => ({}));
    if (!rep.ok || !data.access_token) {
      throw new ErreurCloud(type === 'password' ? 'Connexion refusée : e-mail ou mot de passe incorrect' : 'Session expirée', rep.status);
    }
    this.session = { jeton: data.access_token, rafraichissement: data.refresh_token, expire: Date.now() + (data.expires_in ?? 3600) * 1000 };
  }

  connecter(email, motDePasse) {
    return this.#jetonAuth({ email, password: motDePasse }, 'password');
  }

  /** La session dure une heure ; la vérification et le build peuvent en prendre plus. */
  async #sessionValide() {
    if (!this.session) throw new ErreurCloud('Non connecté');
    if (Date.now() > this.session.expire - 5 * 60 * 1000) {
      await this.#jetonAuth({ refresh_token: this.session.rafraichissement }, 'refresh_token');
    }
    return this.session.jeton;
  }

  /** Appelle une action de la fonction `siege`. Lève ErreurCloud avec le message français du cloud. */
  async siege(action, corps = {}) {
    const jeton = await this.#sessionValide();
    const rep = await this.fetch(`${this.url}/functions/v1/siege`, {
      method: 'POST',
      headers: { apikey: this.cleAnon, authorization: `Bearer ${jeton}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...corps }),
    });
    const data = await rep.json().catch(() => ({}));
    if (!rep.ok || data.erreur) throw new ErreurCloud(data.erreur ?? `Le cloud a répondu ${rep.status}`, rep.status);
    return data;
  }

  /** Dépose un fichier sur une URL de téléversement signée (3 essais : réseau des restaurants…). */
  async televerser(url, octets, essais = 3) {
    let derniere;
    for (let i = 1; i <= essais; i++) {
      try {
        const rep = await this.fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true' },
          body: octets,
        });
        if (rep.ok) return;
        derniere = new ErreurCloud(`Téléversement refusé (${rep.status}) : ${(await rep.text()).slice(0, 200)}`, rep.status);
      } catch (e) {
        derniere = e;
      }
    }
    throw derniere;
  }

  /**
   * Envoie un paquet complet : préparer → déposer chaque fichier → enregistrer.
   * `fichiers` : [{ nom, lire: () => Buffer }] — manifeste, signature, morceaux.
   */
  async envoyerPaquet(destination, fichiers, journal = () => {}) {
    const prep = await this.siege('maj_preparer_envoi', { ...destination, fichiers: fichiers.map((f) => f.nom) });
    const urls = new Map(prep.fichiers.map((f) => [f.nom, f.url]));
    // Le manifeste et sa signature EN DERNIER : un envoi coupé ne laisse pas un
    // manifeste qui pointe vers des morceaux absents (et enregistrer le verrait).
    const ordre = [...fichiers].sort((a, b) => Number(a.nom.startsWith('manifeste')) - Number(b.nom.startsWith('manifeste')));
    let n = 0;
    for (const f of ordre) {
      const url = urls.get(f.nom);
      if (!url) throw new ErreurCloud(`Pas d'URL d'envoi pour ${f.nom}`);
      await this.televerser(url, f.lire());
      journal(`  envoyé ${++n}/${ordre.length} : ${f.nom}`);
    }
    return this.siege('maj_enregistrer', destination);
  }
}
