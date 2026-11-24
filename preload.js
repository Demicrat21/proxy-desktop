'use strict';
// Re-creates the native "window.AndroidProxy" bridge that the original Android app injected
// into its WebView, so the original UI runs unchanged.
const { contextBridge, ipcRenderer } = require('electron');

const SYNC = ['getClipboardText', 'getAppIcon', 'getFcmToken', 'getFcmDiagnostics', 'getDeviceEnvironment', 'getConnectionDiagnostics'];
const ASYNC = [
  'connectProxy', 'reconnectProxy', 'disconnectProxy', 'updateDomainRules',
  'getConnectionStatus', 'getConnectionLog', 'clearConnectionLog', 'getInstalledApps',
  'syncExpiryNotifications', 'clearExpiryNotifications', 'refreshFcmToken',
  'copyToClipboard', 'openExternalUrl', 'minimizeApp', 'hideKeyboard', 'showKeyboard',
];

const api = {};
for (const m of SYNC) api[m] = (payload) => ipcRenderer.sendSync('bridge:sync', m, typeof payload === 'string' ? payload : '');
for (const m of ASYNC) api[m] = (payload) => { ipcRenderer.send('bridge:call', m, typeof payload === 'string' ? payload : ''); };

contextBridge.exposeInMainWorld('AndroidProxy', api);
