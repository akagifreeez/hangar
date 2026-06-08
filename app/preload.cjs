const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hangar', {
  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts),
  scan: (folder) => ipcRenderer.invoke('scan', folder),
  detect: (folders) => ipcRenderer.invoke('detect', folders),
  regen: () => ipcRenderer.invoke('regen'),
  rescan: () => ipcRenderer.invoke('rescan'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  render: (target) => ipcRenderer.invoke('render', target),
  catalogExists: () => ipcRenderer.invoke('catalog-exists'),
  catalogUrl: () => ipcRenderer.invoke('catalog-url'),
  capabilities: () => ipcRenderer.invoke('render-capabilities'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  pickFile: () => ipcRenderer.invoke('pick-file'),
  diff: (pkg, project) => ipcRenderer.invoke('diff', pkg, project),
  saveTemplate: (projectDir, outDir) => ipcRenderer.invoke('save-template', projectDir, outDir),
  restoreTemplate: (templateDir, projectDir, force) => ipcRenderer.invoke('restore-template', templateDir, projectDir, force),
  onStatus: (cb) => ipcRenderer.on('status', (_e, m) => cb(m)),
  onCatalogUrl: (cb) => ipcRenderer.on('catalog-url', (_e, u) => cb(u)),
});
