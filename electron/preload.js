/**
 * BC Container Manager - Preload Script
 *
 * This script runs in the renderer process before the web content loads.
 * It exposes a secure API to the renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose protected methods that allow the renderer process
 * to use ipcRenderer without exposing the entire object
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // Docker Operations
  docker: {
    checkConnection: () => ipcRenderer.invoke('docker:check-connection'),
    listContainers: () => ipcRenderer.invoke('docker:list-containers'),
    getContainer: (id) => ipcRenderer.invoke('docker:get-container', id),
    getContainerStats: (id) => ipcRenderer.invoke('docker:get-container-stats', id),
    getContainerLogs: (id, options) => ipcRenderer.invoke('docker:get-container-logs', id, options),
    startContainer: (id) => ipcRenderer.invoke('docker:start-container', id),
    stopContainer: (id) => ipcRenderer.invoke('docker:stop-container', id),
    restartContainer: (id) => ipcRenderer.invoke('docker:restart-container', id),
    removeContainer: (id, force) => ipcRenderer.invoke('docker:remove-container', id, force),
    getDockerInfo: () => ipcRenderer.invoke('docker:get-info'),
    getDiagnostics: (containerId) => ipcRenderer.invoke('docker:diagnostics', containerId),
    startDesktop: () => ipcRenderer.invoke('docker:start-desktop'),
  },

  // Backup Operations
  backups: {
    list: (containerName) => ipcRenderer.invoke('backups:list', containerName),
    create: (containerId) => ipcRenderer.invoke('backups:create', containerId),
    delete: (filePath) => ipcRenderer.invoke('backups:delete', filePath),
    restore: (backupPath, containerName) => ipcRenderer.invoke('backups:restore', backupPath, containerName),
    getPath: () => ipcRenderer.invoke('backups:get-path'),
  },

  // AI Operations
  ai: {
    chat: (messages, containerContext) => ipcRenderer.invoke('ai:chat', messages, containerContext),
  },

  // PowerShell Script Execution
  powershell: {
    run: (script, args) => ipcRenderer.invoke('run-powershell', { script, args }),
    // Password is written to a mode-600 temp file in the main process and
    // passed as -PasswordFile; it never reaches argv or the settings store.
    runWithPassword: (script, args, password) =>
      ipcRenderer.invoke('run-powershell-with-password', { script, args, password }),
    onOutput: (callback) => {
      const subscription = (event, data) => callback(data);
      ipcRenderer.on('powershell-output', subscription);
      return () => ipcRenderer.removeListener('powershell-output', subscription);
    },
  },

  // Settings
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:get-all'),
  },

  // Dialogs
  dialog: {
    showOpen: (options) => ipcRenderer.invoke('show-open-dialog', options),
    showSave: (options) => ipcRenderer.invoke('show-save-dialog', options),
  },

  // Shell operations
  shell: {
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
  },

  // App info
  app: {
    getInfo: () => ipcRenderer.invoke('get-app-info'),
  },

  // Platform detection
  platform: process.platform,
  isElectron: true,
});

// Log when preload script loads successfully (only in development)
if (process.env.NODE_ENV === 'development') {
  console.log('BC Container Manager: Preload script loaded');
}
