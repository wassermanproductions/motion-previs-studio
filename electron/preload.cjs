const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motionPrevis', {
  openMedia: () => ipcRenderer.invoke('dialog:open-media'),
  importUrl: (url) => ipcRenderer.invoke('media:import-url', url),
  prepareAnalysis: (payload) => ipcRenderer.invoke('analysis:prepare', payload),
  savePoseArtifacts: (payload) => ipcRenderer.invoke('analysis:save-pose-artifacts', payload),
  // Deterministic frame encoder (renderer streams PNGs -> main pipes to ffmpeg).
  encodeFramesBegin: (payload) => ipcRenderer.invoke('analysis:encode-frames:begin', payload),
  encodeFramesFrame: (payload) => ipcRenderer.invoke('analysis:encode-frames:frame', payload),
  encodeFramesEnd: (payload) => ipcRenderer.invoke('analysis:encode-frames:end', payload),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('shell:reveal-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getVersions: () => ipcRenderer.invoke('app:versions'),
  // Project session save / restore.
  saveSession: (session) => ipcRenderer.invoke('project:save-session', session),
  loadSession: () => ipcRenderer.invoke('project:load-session'),
  // Send to Blockout cross-app handoff.
  sendToBlockout: (payload) => ipcRenderer.invoke('blockout:send-reference', payload),
  blockoutStatus: () => ipcRenderer.invoke('blockout:status')
});
