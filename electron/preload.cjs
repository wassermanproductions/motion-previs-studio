const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motionPrevis', {
  openMedia: () => ipcRenderer.invoke('dialog:open-media'),
  importUrl: (url) => ipcRenderer.invoke('media:import-url', url),
  prepareAnalysis: (payload) => ipcRenderer.invoke('analysis:prepare', payload),
  savePoseArtifacts: (payload) => ipcRenderer.invoke('analysis:save-pose-artifacts', payload),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('shell:reveal-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getVersions: () => ipcRenderer.invoke('app:versions')
});
