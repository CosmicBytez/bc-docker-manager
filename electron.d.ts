/**
 * TypeScript declarations for Electron IPC API
 *
 * These types match the API exposed via preload.js
 */

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

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
