const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motionPrevis', {
  openMedia: () => ipcRenderer.invoke('dialog:open-media'),
  importPath: (sourcePath) => ipcRenderer.invoke('media:import-path', sourcePath),
  importUrl: (url) => ipcRenderer.invoke('media:import-url', url),
  prepareAnalysis: (payload) => ipcRenderer.invoke('analysis:prepare', payload),
  savePoseArtifacts: (payload) => ipcRenderer.invoke('analysis:save-pose-artifacts', payload),
  // Deterministic frame encoder (renderer streams PNGs -> main pipes to ffmpeg).
  encodeFramesBegin: (payload) => ipcRenderer.invoke('analysis:encode-frames:begin', payload),
  encodeFramesFrame: (payload) => ipcRenderer.invoke('analysis:encode-frames:frame', payload),
  encodeFramesEnd: (payload) => ipcRenderer.invoke('analysis:encode-frames:end', payload),
  encodeFramesCancel: (payload) => ipcRenderer.invoke('analysis:encode-frames:cancel', payload),
  cancelAnalysis: () => ipcRenderer.invoke('analysis:cancel'),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),
  revealPath: (targetPath) => ipcRenderer.invoke('shell:reveal-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  getVersions: () => ipcRenderer.invoke('app:versions'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  // Project session save / restore.
  saveSession: (session) => ipcRenderer.invoke('project:save-session', session),
  loadSession: () => ipcRenderer.invoke('project:load-session'),
  // Send to Blockout cross-app handoff.
  sendToBlockout: (payload) => ipcRenderer.invoke('blockout:send-reference', payload),
  blockoutStatus: () => ipcRenderer.invoke('blockout:status'),
  // Agent control server (MCP): renderer receives whitelisted actions and
  // replies with results over the correlation-id IPC pair.
  onControlInvoke: (cb) => {
    const listener = (_event, id, action, params) => cb(id, action, params);
    ipcRenderer.on('control:invoke', listener);
    return () => ipcRenderer.removeListener('control:invoke', listener);
  },
  controlResult: (id, result) => ipcRenderer.send('control:result', id, result)
});
