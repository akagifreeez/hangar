const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hangar', {
  pickFolder: (opts) => ipcRenderer.invoke('pick-folder', opts),
  scan: (folder) => ipcRenderer.invoke('scan', folder),
  detect: (folders) => ipcRenderer.invoke('detect', folders),
  regen: () => ipcRenderer.invoke('regen'),
  rescan: () => ipcRenderer.invoke('rescan'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  render: (name) => ipcRenderer.invoke('render', name),
  catalogExists: () => ipcRenderer.invoke('catalog-exists'),
  catalogUrl: () => ipcRenderer.invoke('catalog-url'),
  capabilities: () => ipcRenderer.invoke('render-capabilities'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onStatus: (cb) => ipcRenderer.on('status', (_e, m) => cb(m)),
  onCatalogUrl: (cb) => ipcRenderer.on('catalog-url', (_e, u) => cb(u)),
});
