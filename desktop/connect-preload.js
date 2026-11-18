const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hubBridge', {
  send: (address) => ipcRenderer.send('hub-address', address)
});
