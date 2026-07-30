/**
 * Electron API Abstraction Layer
 *
 * This module provides a unified API that works in both:
 * - Web mode: Uses Next.js API routes via fetch()
 * - Electron mode: Uses IPC via window.electronAPI
 *
 * Components import from here instead of calling APIs directly.
 */

import { BCContainer, ContainerStats, ContainerLog, BackupInfo } from './types';

// Type definitions for Electron API exposed via preload
interface DockerConnectionStatus {
  connected: boolean;
  error?: string;
  suggestion?: string;
}

interface ElectronAPI {
  docker: {
    checkConnection: () => Promise<DockerConnectionStatus>;
    listContainers: () => Promise<ApiResponse<BCContainer[]>>;
    getContainer: (id: string) => Promise<ApiResponse<BCContainer>>;
    getContainerStats: (id: string) => Promise<ApiResponse<ContainerStats>>;
    getContainerLogs: (id: string, options?: LogOptions) => Promise<ApiResponse<ContainerLog[]>>;
    startContainer: (id: string) => Promise<ApiResponse<void>>;
    stopContainer: (id: string) => Promise<ApiResponse<void>>;
    restartContainer: (id: string) => Promise<ApiResponse<void>>;
    removeContainer: (id: string, force?: boolean) => Promise<ApiResponse<void>>;
    getDockerInfo: () => Promise<ApiResponse<DockerInfo>>;
    startDesktop: () => Promise<{ success: boolean; error?: string }>;
  };
  backups: {
    list: (containerName?: string) => Promise<ApiResponse<BackupInfo[]>>;
    create: (containerId: string) => Promise<ApiResponse<BackupInfo>>;
    delete: (filePath: string) => Promise<ApiResponse<void>>;
    restore: (backupPath: string, containerName: string) => Promise<ApiResponse<void>>;
    getPath: () => Promise<ApiResponse<string>>;
  };
  ai: {
    chat: (messages: ChatMessage[], containerContext?: BCContainer) => Promise<ApiResponse<ChatMessage>>;
  };
  powershell: {
    run: (script: string, args: string[]) => Promise<PowerShellResult>;
    runWithPassword: (script: string, args: string[], password: string) => Promise<PowerShellResult>;
    onOutput: (callback: (data: { type: string; data: string }) => void) => () => void;
  };
  settings: {
    get: (key: string) => Promise<ApiResponse<unknown>>;
    set: (key: string, value: unknown) => Promise<ApiResponse<void>>;
    getAll: () => Promise<ApiResponse<Record<string, unknown>>>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  app: {
    getInfo: () => Promise<AppInfo>;
  };
  platform: string;
  isElectron: boolean;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

interface LogOptions {
  tail?: number;
  since?: number;
}

interface DockerInfo {
  version: string;
  containers: number;
  running: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PowerShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface AppInfo {
  version: string;
  name: string;
  platform: string;
  arch: string;
}

// Window type extension is declared in electron.d.ts

/**
 * Check if running in Electron
 */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.isElectron;
}

/**
 * Get the Electron API if available
 */
function getElectronAPI(): ElectronAPI | null {
  if (typeof window !== 'undefined' && window.electronAPI) {
    return window.electronAPI;
  }
  return null;
}

/**
 * Helper to handle fetch responses consistently
 * Validates HTTP status and parses JSON response
 */
async function handleFetchResponse<T>(response: Response, errorContext: string): Promise<ApiResponse<T>> {
  if (!response.ok) {
    throw new Error(`${errorContext}: HTTP ${response.status} ${response.statusText}`);
  }

  try {
    const data = await response.json();
    return data as ApiResponse<T>;
  } catch {
    throw new Error(`${errorContext}: Invalid JSON response`);
  }
}

/**
 * Safely extracts data from API response with proper null handling
 */
function extractData<T>(result: ApiResponse<T>, errorContext: string): T {
  if (!result.success) {
    throw new Error(result.error || `${errorContext} failed`);
  }
  if (result.data === undefined || result.data === null) {
    throw new Error(`${errorContext}: No data returned`);
  }
  return result.data;
}

// ============================================
// Docker API
// ============================================

export async function checkDockerConnection(): Promise<DockerConnectionStatus> {
  const electron = getElectronAPI();

  if (electron) {
    return electron.docker.checkConnection();
  }

  // Web mode: try to fetch containers to check connection
  try {
    const response = await fetch('/api/containers');
    if (!response.ok) {
      return { connected: false, error: `HTTP ${response.status}` };
    }
    const data = await response.json();
    return { connected: data.success };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : 'Failed to connect to API' };
  }
}

export async function listContainers(): Promise<BCContainer[]> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.docker.listContainers();
    if (!result.success) throw new Error(result.error || 'Failed to list containers');
    return result.data || [];
  }

  const response = await fetch('/api/containers');
  const data = await handleFetchResponse<BCContainer[]>(response, 'List containers');
  if (!data.success) throw new Error(data.error || 'Failed to list containers');
  return data.data || [];
}

export async function getContainer(id: string): Promise<BCContainer | null> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.docker.getContainer(id);
    if (!result.success) return null;
    return result.data || null;
  }

  try {
    const response = await fetch(`/api/containers/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.success) return null;
    return data.data || null;
  } catch {
    return null;
  }
}

export async function getContainerStats(id: string): Promise<ContainerStats> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.docker.getContainerStats(id);
    return extractData(result, 'Get container stats');
  }

  const response = await fetch(`/api/containers/${encodeURIComponent(id)}/stats`);
  const data = await handleFetchResponse<ContainerStats>(response, 'Get container stats');
  return extractData(data, 'Get container stats');
}

export async function getContainerLogs(id: string, options?: LogOptions): Promise<ContainerLog[]> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.docker.getContainerLogs(id, options);
    if (!result.success) throw new Error(result.error || 'Failed to get logs');
    return result.data || [];
  }

  const params = new URLSearchParams();
  if (options?.tail) params.set('tail', options.tail.toString());
  if (options?.since) params.set('since', options.since.toString());

  const response = await fetch(`/api/logs?containerId=${encodeURIComponent(id)}&${params}`);
  const data = await handleFetchResponse<ContainerLog[]>(response, 'Get container logs');
  if (!data.success) throw new Error(data.error || 'Failed to get logs');
  return data.data || [];
}

export async function containerAction(
  id: string,
  action: 'start' | 'stop' | 'restart' | 'remove'
): Promise<void> {
  const electron = getElectronAPI();

  if (electron) {
    let result: ApiResponse<void>;
    switch (action) {
      case 'start':
        result = await electron.docker.startContainer(id);
        break;
      case 'stop':
        result = await electron.docker.stopContainer(id);
        break;
      case 'restart':
        result = await electron.docker.restartContainer(id);
        break;
      case 'remove':
        result = await electron.docker.removeContainer(id);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    if (!result.success) throw new Error(result.error || `${action} failed`);
    return;
  }

  const response = await fetch('/api/containers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, containerId: id }),
  });
  const data = await handleFetchResponse<void>(response, `Container ${action}`);
  if (!data.success) throw new Error(data.error || `${action} failed`);
}

export async function getDockerInfo(): Promise<DockerInfo> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.docker.getDockerInfo();
    return extractData(result, 'Get Docker info');
  }

  const response = await fetch('/api/docker/info');
  const data = await handleFetchResponse<DockerInfo>(response, 'Get Docker info');
  return extractData(data, 'Get Docker info');
}

// ============================================
// Backup API
// ============================================

export async function listBackups(containerName?: string): Promise<BackupInfo[]> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.backups.list(containerName);
    if (!result.success) throw new Error(result.error || 'Failed to list backups');
    return result.data || [];
  }

  const url = containerName
    ? `/api/backups?containerName=${encodeURIComponent(containerName)}`
    : '/api/backups';
  const response = await fetch(url);
  const data = await handleFetchResponse<BackupInfo[]>(response, 'List backups');
  if (!data.success) throw new Error(data.error || 'Failed to list backups');
  return data.data || [];
}

export async function createBackup(containerId: string): Promise<BackupInfo> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.backups.create(containerId);
    return extractData(result, 'Create backup');
  }

  const response = await fetch('/api/backups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ containerId }),
  });
  const data = await handleFetchResponse<BackupInfo>(response, 'Create backup');
  return extractData(data, 'Create backup');
}

export async function deleteBackup(filePath: string): Promise<void> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.backups.delete(filePath);
    if (!result.success) throw new Error(result.error || 'Failed to delete backup');
    return;
  }

  const response = await fetch('/api/backups', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath }),
  });
  const data = await handleFetchResponse<void>(response, 'Delete backup');
  if (!data.success) throw new Error(data.error || 'Failed to delete backup');
}

export async function restoreBackup(backupPath: string, containerName: string): Promise<void> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.backups.restore(backupPath, containerName);
    if (!result.success) throw new Error(result.error || 'Failed to restore backup');
    return;
  }

  // Web mode: restore not supported
  throw new Error('Restore requires the desktop app');
}

// ============================================
// AI API
// ============================================

export async function sendAIMessage(
  messages: ChatMessage[],
  containerContext?: BCContainer
): Promise<ChatMessage> {
  const electron = getElectronAPI();

  if (electron) {
    const result = await electron.ai.chat(messages, containerContext);
    return extractData(result, 'AI chat');
  }

  const response = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, containerContext }),
  });
  const data = await handleFetchResponse<ChatMessage>(response, 'AI chat');
  return extractData(data, 'AI chat');
}

// ============================================
// PowerShell API (Electron only)
// ============================================

export async function runPowerShell(
  script: string,
  args: string[] = []
): Promise<PowerShellResult> {
  const electron = getElectronAPI();

  if (!electron) {
    throw new Error('PowerShell execution is only available in the desktop app');
  }

  return electron.powershell.run(script, args);
}

/**
 * Runs a script that needs a password. The password is handed to the main
 * process, which stages it in a mode-600 temp file and passes -PasswordFile.
 * It is never written to the settings store or to a command line.
 */
export async function runPowerShellWithPassword(
  script: string,
  args: string[],
  password: string
): Promise<PowerShellResult> {
  const electron = getElectronAPI();

  if (!electron) {
    throw new Error('PowerShell execution is only available in the desktop app');
  }

  return electron.powershell.runWithPassword(script, args, password);
}

export function onPowerShellOutput(
  callback: (data: { type: string; data: string }) => void
): () => void {
  const electron = getElectronAPI();

  if (!electron) {
    return () => {}; // No-op cleanup function
  }

  return electron.powershell.onOutput(callback);
}

// ============================================
// Settings API (Electron only)
// ============================================

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const electron = getElectronAPI();

  if (!electron) {
    // Fall back to localStorage in web mode
    if (typeof window !== 'undefined') {
      const value = localStorage.getItem(`bc-manager-${key}`);
      if (!value) return undefined;
      try {
        return JSON.parse(value) as T;
      } catch {
        // If JSON parsing fails, return undefined and log warning
        console.warn(`Failed to parse setting '${key}' from localStorage`);
        return undefined;
      }
    }
    return undefined;
  }

  const result = await electron.settings.get(key);
  return result.data as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const electron = getElectronAPI();

  if (!electron) {
    // Fall back to localStorage in web mode
    if (typeof window !== 'undefined') {
      const sensitiveKeys = ['anthropicApiKey', 'apiKey', 'password', 'secret', 'token', 'credential'];
      if (sensitiveKeys.some(k => key.toLowerCase().includes(k.toLowerCase()))) {
        console.warn(`Cannot store sensitive key "${key}" outside of Electron's safeStorage`);
        return;
      }
      localStorage.setItem(`bc-manager-${key}`, JSON.stringify(value));
    }
    return;
  }

  const result = await electron.settings.set(key, value);
  // A rejected key or a failed validator must surface — silently discarding
  // { success: false } is what let disallowed keys and out-of-range values
  // look like successful saves.
  if (!result?.success) {
    throw new Error(result?.error || `Failed to save setting "${key}"`);
  }
}

/**
 * Launches Docker Desktop via the main process.
 * Returns the handler result so the caller can distinguish success from a
 * missing installation.
 */
export async function startDockerDesktop(): Promise<{ success: boolean; error?: string }> {
  const electron = getElectronAPI();

  if (!electron) {
    return { success: false, error: 'Desktop app required' };
  }

  return electron.docker.startDesktop();
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  const electron = getElectronAPI();

  if (!electron) {
    return {};
  }

  const result = await electron.settings.getAll();
  return result.data || {};
}

// ============================================
// Shell API
// ============================================

export async function openExternal(url: string): Promise<void> {
  const electron = getElectronAPI();

  if (electron) {
    await electron.shell.openExternal(url);
  } else {
    window.open(url, '_blank');
  }
}

// ============================================
// App Info
// ============================================

export async function getAppInfo(): Promise<AppInfo | null> {
  const electron = getElectronAPI();

  if (!electron) {
    return null;
  }

  return electron.app.getInfo();
}
