const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posSamer', {
  fermer: () => ipcRenderer.send('fermer-app'),
  // Utilisé uniquement par l'écran « La caisse n'a pas pu démarrer » : relance
  // Postgres et le serveur sans quitter l'application.
  reessayer: () => ipcRenderer.send('reessayer-demarrage'),
});
