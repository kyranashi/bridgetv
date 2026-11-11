/*
 * BridgeTV для ПК — preload. Единственная связь страницы с системой: window.TVBridge,
 * тот же набор, что у Android (info/saved синхронно, postMessage — команды).
 * Страница работает в изолированном мире (contextIsolation + sandbox), доступа к Node.js нет.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('TVBridge', {
  info: () => ipcRenderer.sendSync('tv:info'),
  saved: () => ipcRenderer.sendSync('tv:saved'),
  postMessage: (json) => { if (typeof json === 'string' && json.length < 200000) ipcRenderer.send('tv:msg', json); }
});
