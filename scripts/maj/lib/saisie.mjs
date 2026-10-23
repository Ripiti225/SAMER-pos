// Saisie au clavier : e-mail, mot de passe, phrase de passe de la clé.
//
// Les secrets ne passent JAMAIS par un argument de commande (visible dans la
// liste des processus et l'historique) ni par une variable d'environnement
// (héritée par tous les sous-processus : tsc, vitest, vite…). Au clavier, la
// saisie est masquée. Depuis un tube (tests automatisés), les lignes sont lues
// dans l'ordre, une par question.
import readline from 'node:readline';

let lignesTube = null;

async function ligneDuTube() {
  if (lignesTube === null) {
    let texte = '';
    for await (const b of process.stdin) texte += b;
    lignesTube = texte.split(/\r?\n/);
  }
  return lignesTube.shift() ?? '';
}

/** Pose une question ; `masque` : la réponse ne s'affiche pas. */
export async function demander(question, { masque = false } = {}) {
  if (!process.stdin.isTTY) {
    process.stderr.write(question);
    const l = await ligneDuTube();
    process.stderr.write('\n');
    return l;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let cacher = false;
  rl._writeToOutput = (s) => {
    if (!cacher || s.includes('\n')) rl.output.write(cacher ? '\n' : s);
  };
  return new Promise((resolve) => {
    rl.output.write(question);
    cacher = masque;
    rl.question('', (reponse) => {
      rl.close();
      resolve(reponse);
    });
  });
}
