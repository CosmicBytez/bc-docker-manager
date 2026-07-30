/**
 * BC Container Manager - IPC Handlers
 *
 * These handlers mirror the Next.js API routes but run directly
 * in the Electron main process with full Node.js access.
 */

const Docker = require('dockerode');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;
const { APIConnectionError } = require('@anthropic-ai/sdk');
const { buildContext, getOfflineResponse, listDocuments } = require('./rag-helper');
const { app, safeStorage } = require('electron');

// Check if running in development mode
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

/**
 * Development-only logging helper
 * Only logs in development mode to keep production clean
 */
function devLog(...args) {
  if (isDev) {
    console.log(...args);
  }
}

/**
 * Development-only error logging helper
 * Only logs errors in development mode
 */
function devError(...args) {
  if (isDev) {
    console.error(...args);
  }
}

/**
 * Safely extracts error message from any error type
 * Handles Error objects, strings, and unknown types
 */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validates a container ID parameter
 * Docker container IDs are alphanumeric (hex) strings
 * @param {string} id - Container ID to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
function validateContainerId(id) {
  if (!id || typeof id !== 'string') {
    return { valid: false, error: 'Container ID is required' };
  }
  // Docker IDs are 64-char hex, but short IDs (12+ chars) are also accepted
  // Also allow container names which can have alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id)) {
    return { valid: false, error: 'Invalid container ID format' };
  }
  if (id.length > 128) {
    return { valid: false, error: 'Container ID too long' };
  }
  return { valid: true };
}

/**
 * Validates a file path to ensure it's within allowed directories
 * Prevents path traversal attacks
 * @param {string} filePath - Path to validate
 * @param {string} allowedRoot - Root directory that path must be within
 * @returns {{valid: boolean, resolvedPath?: string, error?: string}} Validation result
 */
function validateFilePath(filePath, allowedRoot) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, error: 'File path is required' };
  }

  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(allowedRoot);

  // Use path.relative to check if path is within root
  const relative = path.relative(resolvedRoot, resolvedPath);

  // If relative path starts with '..' or is absolute, it's outside the root
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { valid: false, error: 'Path is outside allowed directory' };
  }

  return { valid: true, resolvedPath };
}

/**
 * Get Docker connection options based on environment
 * Supports: Windows named pipe, Unix socket, WSL2 with Docker Desktop
 */
function getDockerOptions() {
  // Check for explicit DOCKER_HOST environment variable first
  if (process.env.DOCKER_HOST) {
    const host = process.env.DOCKER_HOST;
    if (host.startsWith('tcp://')) {
      const url = new URL(host);
      return {
        host: url.hostname,
        port: parseInt(url.port) || 2375,
      };
    }
    if (host.startsWith('unix://')) {
      return { socketPath: host.replace('unix://', '') };
    }
    if (host.startsWith('npipe://')) {
      return { socketPath: host.replace('npipe://', '') };
    }
  }

  // Windows: use named pipe
  if (process.platform === 'win32') {
    return { socketPath: '//./pipe/docker_engine' };
  }

  // Check for Docker socket in common locations
  const socketPaths = [
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/mnt/wsl/docker-desktop/docker.sock',
  ];

  for (const socketPath of socketPaths) {
    try {
      fsSync.accessSync(socketPath, fsSync.constants.R_OK | fsSync.constants.W_OK);
      return { socketPath };
    } catch {
      // Socket not accessible, try next
    }
  }

  // Fallback: TCP connection
  return { host: 'localhost', port: 2375 };
}

// Initialize Docker client with best available connection
const dockerOptions = getDockerOptions();
devLog('[Docker] Initializing with options:', JSON.stringify(dockerOptions));
const docker = new Docker(dockerOptions);

// Settings store (simple file-based)
const settingsPath = path.join(
  process.env.APPDATA || process.env.HOME,
  'bc-container-manager',
  'settings.json'
);

// BC Container name pattern - matches containers with 'bc' in name (case insensitive)
// Supports: bcserver-*, mybc-*, bc-test, any-bc-container, etc.
const BC_CONTAINER_PATTERN = /bc/i;

// Default backup root
const DEFAULT_BACKUP_ROOT = 'C:\\BCBackups';

// Encrypted settings key prefix to distinguish from plaintext
const ENCRYPTED_PREFIX = 'enc:';

// Keys that should be encrypted at rest
const ENCRYPTED_KEYS = ['anthropicApiKey'];

// ============================================
// Settings allowlists & validators
// ============================================

const ALLOWED_SETTINGS_KEYS = [
  'anthropicApiKey', 'backupRoot', 'autoRefreshInterval',
  'theme', 'dockerSocketPath', 'defaultBcVersion',
];

// Write-only keys are accepted by settings:set but never handed back to the
// renderer — the decrypted API key must not leave the main process.
const WRITE_ONLY_SETTINGS_KEYS = ['anthropicApiKey'];

const READABLE_SETTINGS_KEYS = ALLOWED_SETTINGS_KEYS.filter(
  (key) => !WRITE_ONLY_SETTINGS_KEYS.includes(key)
);

const SETTINGS_VALIDATORS = {
  anthropicApiKey: (v) => typeof v === 'string' && v.length <= 500,
  backupRoot: (v) => typeof v === 'string' && v.length <= 260,
  // SECONDS, not milliseconds — the settings page stores seconds and the
  // dashboard multiplies by 1000 on read.
  autoRefreshInterval: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 5 && v <= 3600,
  theme: (v) => typeof v === 'string' && ['light', 'dark', 'system'].includes(v),
  dockerSocketPath: (v) => typeof v === 'string' && v.length <= 260,
  defaultBcVersion: (v) => typeof v === 'string' && v.length <= 100,
};

/**
 * Builds the message window sent to the Messages API.
 * The API rejects a conversation whose first message is an assistant turn, so
 * leading assistant messages (the UI's welcome message, offline fallbacks) are
 * dropped and the window is re-trimmed to start on a user turn.
 * @param {Array<{role: string, content: string}>} messages
 * @param {number} maxMessages - size of the trailing window
 * @returns {Array<{role: string, content: string}>}
 */
function buildApiMessages(messages, maxMessages = 10) {
  const startFromFirstUser = (list) => {
    const firstUser = list.findIndex((m) => m.role === 'user');
    return firstUser === -1 ? [] : list.slice(firstUser);
  };

  const trimmed = startFromFirstUser(messages);
  const windowed = startFromFirstUser(trimmed.slice(-maxMessages));

  return windowed.map((m) => ({ role: m.role, content: m.content }));
}

// Socket-level failures raised by Node's networking stack. The Anthropic SDK
// wraps these: the code lives on `error.cause`, not on the SDK error itself.
const SOCKET_ERROR_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'];

/**
 * True when an Anthropic SDK error is a transport/connectivity failure rather
 * than an API-level rejection. Only connectivity failures justify silently
 * degrading to the offline documentation responses.
 *
 * No SDK error class assigns `this.name`, so every one of them reports
 * `name === 'Error'` (verified against @anthropic-ai/sdk 0.71.2). Reading
 * `error.name` first therefore short-circuits on a truthy but useless value and
 * makes any constructor-name fallback unreachable — which is why this checks
 * the class first and treats `name` only as a last-resort hint for errors that
 * have crossed a serialization boundary.
 */
function isConnectivityError(error) {
  if (!error || typeof error !== 'object') return false;
  // An HTTP status means the request reached the API and was rejected there.
  if (typeof error.status === 'number') return false;

  // APIConnectionTimeoutError extends APIConnectionError, so one check covers both.
  if (error instanceof APIConnectionError) return true;

  const className = error.constructor?.name || '';
  if (/^APIConnection(Timeout)?Error$/.test(className)) return true;
  if (/^APIConnection(Timeout)?Error$/.test(error.name || '')) return true;

  // Walk the cause chain: `new APIConnectionError({ cause })` keeps the
  // underlying socket error (and its `code`) at `error.cause`.
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 5; current = current.cause, depth++) {
    if (SOCKET_ERROR_CODES.includes(current.code)) return true;
  }
  return false;
}

/**
 * Encrypts a string value using Electron's safeStorage (OS keychain).
 * Returns Base64-encoded encrypted buffer prefixed with 'enc:'.
 * Falls back to plaintext if encryption is unavailable (e.g., Linux without keyring).
 */
function encryptValue(value) {
  if (!value || typeof value !== 'string') return value;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value);
      return ENCRYPTED_PREFIX + encrypted.toString('base64');
    }
  } catch (e) {
    devError('safeStorage encryption failed, storing plaintext:', e);
  }
  return value;
}

/**
 * Decrypts a value previously encrypted with encryptValue().
 * If the value is not prefixed with 'enc:', returns it as-is (plaintext migration).
 */
function decryptValue(value) {
  if (!value || typeof value !== 'string') return value;
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value; // plaintext, not yet migrated
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
      return safeStorage.decryptString(encrypted);
    }
  } catch (e) {
    devError('safeStorage decryption failed:', e);
  }
  return ''; // Cannot decrypt without keychain — return empty rather than ciphertext
}

// Docker connectivity state
let dockerConnected = false;
let lastDockerCheck = 0;
const DOCKER_CHECK_INTERVAL = 30000; // Check every 30 seconds

/**
 * Pre-flight check for Docker connectivity
 * Caches result to avoid repeated checks
 */
async function checkDockerConnectivity() {
  const now = Date.now();
  if (dockerConnected && (now - lastDockerCheck) < DOCKER_CHECK_INTERVAL) {
    return { connected: true };
  }

  try {
    await docker.ping();
    dockerConnected = true;
    lastDockerCheck = now;
    return { connected: true };
  } catch (error) {
    dockerConnected = false;
    return {
      connected: false,
      error: getErrorMessage(error),
      suggestion: process.platform === 'win32'
        ? 'Ensure Docker is running and you have administrator privileges.'
        : 'Ensure Docker is running and you have access to /var/run/docker.sock.'
    };
  }
}

/**
 * Register all IPC handlers
 */
function registerIpcHandlers(ipcMain) {
  // ============================================
  // Docker Handlers
  // ============================================

  // Pre-flight Docker connectivity check
  ipcMain.handle('docker:check-connection', async () => {
    return await checkDockerConnectivity();
  });

  ipcMain.handle('docker:list-containers', async () => {
    try {
      // Pre-flight check
      const connectivity = await checkDockerConnectivity();
      if (!connectivity.connected) {
        return {
          success: false,
          error: `Docker not connected: ${connectivity.error}`,
          suggestion: connectivity.suggestion
        };
      }

      const containers = await docker.listContainers({ all: true });

      const bcContainers = containers
        .filter(c => c.Names.some(n => BC_CONTAINER_PATTERN.test(n.replace('/', ''))))
        .map(c => mapContainerToBCContainer(c));

      // Fetch stats, uptime, and accurate port info for all containers
      const enrichedContainers = await Promise.all(
        bcContainers.map(async (container) => {
          try {
            // Always fetch inspect to get accurate port mappings
            const containerInfo = await docker.getContainer(container.id).inspect();
            const ports = mapPorts(containerInfo.NetworkSettings.Ports);
            const webClientUrl = buildWebClientUrl(containerInfo);

            if (container.status === 'running') {
              try {
                const stats = await getContainerStats(container.id);
                return {
                  ...container,
                  ports, // Use accurate ports from inspect
                  webClientUrl,
                  cpuUsage: `${stats.cpuPercent.toFixed(1)}%`,
                  memoryUsage: formatBytes(stats.memoryUsage),
                  uptime: containerInfo.State?.StartedAt
                    ? calculateUptime(containerInfo.State.StartedAt)
                    : undefined,
                  health: containerInfo.State?.Health?.Status || 'none',
                  statsError: stats.statsWarning,
                };
              } catch (statsError) {
                devError(`[Stats Error] Failed to get stats for ${container.name}:`, getErrorMessage(statsError));
                return {
                  ...container,
                  ports,
                  webClientUrl,
                  statsError: getErrorMessage(statsError),
                };
              }
            }
            // Non-running containers - still return accurate ports
            return {
              ...container,
              ports,
              webClientUrl,
            };
          } catch (inspectError) {
            devError(`[Inspect Error] Failed to inspect ${container.name}:`, getErrorMessage(inspectError));
            return container; // Return original container data if inspect fails
          }
        })
      );

      return { success: true, data: enrichedContainers };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('docker:get-container', async (event, id) => {
    // Validate container ID
    const validation = validateContainerId(id);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const container = docker.getContainer(id);
      const info = await container.inspect();

      return {
        success: true,
        data: {
          id: info.Id,
          name: info.Name.replace('/', ''),
          status: mapStatus(info.State.Status),
          image: info.Config.Image,
          created: info.Created,
          ports: mapPorts(info.NetworkSettings.Ports),
          health: info.State.Health?.Status,
          bcVersion: extractBCVersion(info.Config.Image),
          webClientUrl: buildWebClientUrl(info),
          uptime: info.State.Running ? calculateUptime(info.State.StartedAt) : undefined,
        }
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('docker:get-container-stats', async (event, id) => {
    // Validate container ID
    const validation = validateContainerId(id);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const stats = await getContainerStats(id);
      return { success: true, data: stats };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('docker:get-container-logs', async (event, id, options = {}) => {
    // Validate container ID
    const validation = validateContainerId(id);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Sanitize options: ensure tail and since are valid numbers
    const tail = Number.isFinite(Number(options.tail)) ? Math.max(1, Math.min(Number(options.tail), 10000)) : 100;
    const since = Number.isFinite(Number(options.since)) ? Math.max(0, Number(options.since)) : 0;

    try {
      const container = docker.getContainer(id);
      const logStream = await container.logs({
        stdout: true,
        stderr: true,
        tail,
        since,
        timestamps: true,
      });

      const logs = parseDockerLogs(logStream);
      return { success: true, data: logs };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('docker:start-container', async (event, id) => {
    // Validate container ID
    const validation = validateContainerId(id);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const container = docker.getContainer(id);
      await container.start();
      return { success: true, message: 'Container started' };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('docker:stop-container', async (event, id) => {
    // Validate container ID
    const validation = validateContainerId(id);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const container = docker.getContainer(id);
      await container.stop();
      return { success: true, message: 'Container stopped' };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('docker:restart-container', async (event, id) => {
    // Validate container ID
    const validation = validateContainerId(id);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const container = docker.getContainer(id);
      await container.restart();
      return { success: true, message: 'Container restarted' };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('docker:remove-container', async (event, id, force = false) => {
    // Validate container ID
    const validation = validateContainerId(id);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    try {
      const container = docker.getContainer(id);
      await container.remove({ force });
      return { success: true, message: 'Container removed' };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('docker:get-info', async () => {
    try {
      const info = await docker.info();
      return {
        success: true,
        data: {
          version: info.ServerVersion,
          containers: info.Containers,
          running: info.ContainersRunning,
        }
      };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  // Diagnostic endpoint to debug stats issues
  ipcMain.handle('docker:diagnostics', async (event, containerId) => {
    // Validate container ID if provided
    if (containerId) {
      const validation = validateContainerId(containerId);
      if (!validation.valid) {
        return { success: false, error: validation.error };
      }
    }

    try {
      const diagnostics = {
        platform: process.platform,
        dockerOptions: dockerOptions,
        timestamp: new Date().toISOString(),
      };

      // Test Docker connection
      try {
        const info = await docker.info();
        diagnostics.dockerConnected = true;
        diagnostics.dockerVersion = info.ServerVersion;
        diagnostics.osType = info.OSType; // 'linux' or 'windows'
        diagnostics.isolation = info.Isolation; // 'hyperv' or 'process'
      } catch (err) {
        diagnostics.dockerConnected = false;
        diagnostics.dockerError = getErrorMessage(err);
      }

      // Get raw stats if container ID provided
      if (containerId && diagnostics.dockerConnected) {
        try {
          const container = docker.getContainer(containerId);
          const rawStats = await container.stats({ stream: false });
          diagnostics.rawStats = {
            hasCpuStats: !!rawStats.cpu_stats,
            hasMemoryStats: !!rawStats.memory_stats,
            cpuStatsKeys: rawStats.cpu_stats ? Object.keys(rawStats.cpu_stats) : [],
            memoryStatsKeys: rawStats.memory_stats ? Object.keys(rawStats.memory_stats) : [],
            // Include actual values for debugging
            cpu_stats: rawStats.cpu_stats,
            memory_stats: rawStats.memory_stats,
            precpu_stats: rawStats.precpu_stats,
          };
        } catch (err) {
          diagnostics.statsError = getErrorMessage(err);
        }
      }

      return { success: true, data: diagnostics };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  // ============================================
  // Backup Handlers
  // ============================================

  ipcMain.handle('backups:list', async (event, containerName) => {
    try {
      // Validate container name if provided to prevent path traversal
      if (containerName) {
        const nameValidation = validateContainerId(containerName);
        if (!nameValidation.valid) {
          return { success: false, error: 'Invalid container name format' };
        }
      }

      const settings = await loadSettings();
      const backupRoot = settings.backupRoot || DEFAULT_BACKUP_ROOT;
      const backups = [];

      // Helper to find backups in a container directory
      // Searches both direct .bak files AND timestamped subdirectories
      async function findBackupsInDir(containerBackupDir, containerNameForBackup) {
        const entries = await safeReadDir(containerBackupDir);

        for (const entry of entries) {
          const entryPath = path.join(containerBackupDir, entry);

          try {
            const entryStat = await fs.stat(entryPath);

            if (entry.endsWith('.bak') && entryStat.isFile()) {
              // Direct .bak file (legacy format)
              backups.push({
                id: `backup_${entryStat.mtimeMs}`,
                containerName: containerNameForBackup,
                fileName: entry,
                filePath: entryPath,
                size: entryStat.size,
                createdAt: entryStat.mtime.toISOString(),
                status: 'completed',
              });
            } else if (entryStat.isDirectory()) {
              // Timestamped subdirectory - look for .bak files inside
              const subFiles = await safeReadDir(entryPath);

              for (const subFile of subFiles) {
                if (subFile.endsWith('.bak')) {
                  const bakPath = path.join(entryPath, subFile);
                  const bakStat = await fs.stat(bakPath);

                  // Try to read manifest.json for metadata
                  let createdAt = bakStat.mtime.toISOString();
                  try {
                    const manifestPath = path.join(entryPath, 'manifest.json');
                    const manifestData = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
                    if (manifestData.CompletedAt) {
                      createdAt = manifestData.CompletedAt;
                    }
                  } catch {
                    // No manifest, use file mtime
                  }

                  backups.push({
                    id: `backup_${bakStat.mtimeMs}`,
                    containerName: containerNameForBackup,
                    fileName: subFile,
                    filePath: bakPath,
                    backupFolder: entryPath,
                    size: bakStat.size,
                    createdAt,
                    status: 'completed',
                  });
                }
              }
            }
          } catch {
            // Skip entries that can't be accessed
          }
        }
      }

      if (containerName) {
        // List backups for specific container
        const containerBackupDir = path.join(backupRoot, containerName);
        await findBackupsInDir(containerBackupDir, containerName);
      } else {
        // List all backups
        const containers = await safeReadDir(backupRoot);

        for (const container of containers) {
          const containerBackupDir = path.join(backupRoot, container);

          try {
            const stat = await fs.stat(containerBackupDir);
            if (stat.isDirectory()) {
              await findBackupsInDir(containerBackupDir, container);
            }
          } catch {
            // Skip inaccessible directories
          }
        }
      }

      // Sort by date descending
      backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      return { success: true, data: backups };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('backups:create', async (event, containerId) => {
    const idValidation = validateContainerId(containerId);
    if (!idValidation.valid) {
      return { success: false, error: idValidation.error };
    }

    try {
      const container = docker.getContainer(containerId);
      const info = await container.inspect();
      const containerName = info.Name.replace('/', '');

      // Get configured backup path
      const settings = await loadSettings();
      const backupRoot = settings.backupRoot || DEFAULT_BACKUP_ROOT;

      // Use BcContainerHelper via PowerShell script for proper backup
      // This handles database detection, backup creation, and file management
      const { spawn } = require('child_process');

      // Resolve script path based on dev/prod environment
      const { app } = require('electron');
      const isDev = !app.isPackaged;
      let scriptPath;
      if (isDev) {
        scriptPath = path.join(__dirname, '..', 'scripts', 'Backup-BC-Container.ps1');
      } else {
        // In production, try extraResources path first (resources/scripts/), then asar.unpacked
        scriptPath = path.join(process.resourcesPath, 'scripts', 'Backup-BC-Container.ps1');
        if (!fsSync.existsSync(scriptPath)) {
          scriptPath = path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'scripts', 'Backup-BC-Container.ps1');
        }
      }

      // Check if script exists
      if (!fsSync.existsSync(scriptPath)) {
        return { success: false, error: `Backup script not found at: ${scriptPath}` };
      }

      return new Promise((resolve) => {
        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-ContainerName', containerName,
          '-BackupPath', backupRoot,
          '-Silent'
        ]);

        let stdout = '';
        let stderr = '';

        ps.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        ps.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ps.on('close', (code) => {
          if (code === 0) {
            // Parse backup info from script output
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            resolve({
              success: true,
              data: {
                id: `backup_${Date.now()}`,
                containerName,
                fileName: `${containerName}-backup.bak`,
                filePath: path.join(backupRoot, containerName),
                createdAt: new Date().toISOString(),
                status: 'completed',
              }
            });
          } else {
            resolve({
              success: false,
              error: `Backup failed (exit code ${code}): ${stderr || stdout}`
            });
          }
        });

        ps.on('error', (err) => {
          resolve({ success: false, error: `Failed to start backup: ${getErrorMessage(err)}` });
        });
      });
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('backups:delete', async (event, filePath) => {
    try {
      const settings = await loadSettings();
      const backupRoot = settings.backupRoot || DEFAULT_BACKUP_ROOT;

      // Security check: use path.relative to prevent traversal attacks
      // This catches cases like 'C:\BCBackups..\..\..\Windows\file.bak'
      const pathValidation = validateFilePath(filePath, backupRoot);
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error || 'Invalid backup path' };
      }

      const resolvedPath = pathValidation.resolvedPath;

      // Additional check: ensure file has .bak extension
      if (!resolvedPath.endsWith('.bak')) {
        return { success: false, error: 'Only .bak files can be deleted' };
      }

      // Verify file exists before attempting deletion
      try {
        await fs.access(resolvedPath);
      } catch {
        return { success: false, error: 'Backup file not found' };
      }

      await fs.unlink(resolvedPath);
      return { success: true, message: 'Backup deleted' };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('backups:get-path', async () => {
    const settings = await loadSettings();
    return { success: true, data: settings.backupRoot || DEFAULT_BACKUP_ROOT };
  });

  ipcMain.handle('backups:restore', async (event, backupPath, containerName) => {
    try {
      // Validate container name format
      const nameValidation = validateContainerId(containerName);
      if (!nameValidation.valid) {
        return { success: false, error: 'Invalid container name format' };
      }

      // Validate backup path
      if (!backupPath || typeof backupPath !== 'string') {
        return { success: false, error: 'Backup path is required' };
      }

      const settings = await loadSettings();
      const backupRoot = settings.backupRoot || DEFAULT_BACKUP_ROOT;

      // Security: Validate backup path is within backup root
      const pathValidation = validateFilePath(backupPath, backupRoot);
      if (!pathValidation.valid) {
        return { success: false, error: pathValidation.error || 'Invalid backup path' };
      }

      const resolvedBackupPath = pathValidation.resolvedPath;

      // Verify backup path exists
      try {
        await fs.access(resolvedBackupPath);
      } catch {
        return { success: false, error: 'Backup path not found' };
      }

      const { spawn } = require('child_process');

      // Resolve script path based on dev/prod environment
      const { app } = require('electron');
      const isDev = !app.isPackaged;
      let scriptPath;
      if (isDev) {
        scriptPath = path.join(__dirname, '..', 'scripts', 'Restore-BC-Container.ps1');
      } else {
        // In production, try extraResources path first (resources/scripts/), then asar.unpacked
        scriptPath = path.join(process.resourcesPath, 'scripts', 'Restore-BC-Container.ps1');
        if (!fsSync.existsSync(scriptPath)) {
          scriptPath = path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'scripts', 'Restore-BC-Container.ps1');
        }
      }

      // Check if script exists
      if (!fsSync.existsSync(scriptPath)) {
        return { success: false, error: `Restore script not found at: ${scriptPath}` };
      }

      return new Promise((resolve) => {
        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File', scriptPath,
          '-ContainerName', containerName,
          '-BackupPath', resolvedBackupPath,
          '-Force'  // Skip confirmation since UI handles it
        ]);

        let stdout = '';
        let stderr = '';

        ps.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        ps.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        ps.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true, message: 'Restore completed successfully' });
          } else {
            resolve({
              success: false,
              error: `Restore failed (exit code ${code}): ${stderr || stdout}`
            });
          }
        });

        ps.on('error', (err) => {
          resolve({ success: false, error: `Failed to start restore: ${err.message}` });
        });
      });
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  // ============================================
  // AI Handlers
  // ============================================

  ipcMain.handle('ai:chat', async (event, messages, containerContext) => {
    try {
      // Validate messages array
      if (!Array.isArray(messages) || messages.length === 0) {
        return { success: false, error: 'Messages must be a non-empty array' };
      }
      if (messages.length > 100) {
        return { success: false, error: 'Too many messages' };
      }
      // Validate containerContext if provided
      if (containerContext !== undefined && containerContext !== null) {
        if (typeof containerContext !== 'object' || Array.isArray(containerContext)) {
          return { success: false, error: 'containerContext must be an object' };
        }
        if (JSON.stringify(containerContext).length > 10000) {
          return { success: false, error: 'containerContext too large' };
        }
      }
      // Validate each message has role and content strings
      for (const msg of messages) {
        if (!msg || typeof msg.role !== 'string' || typeof msg.content !== 'string') {
          return { success: false, error: 'Each message must have role and content strings' };
        }
        if (!['user', 'assistant'].includes(msg.role)) {
          return { success: false, error: 'Message role must be "user" or "assistant"' };
        }
        // Limit individual message length to prevent abuse
        if (msg.content.length > 50000) {
          return { success: false, error: 'Message content too long (max 50000 characters)' };
        }
      }

      const settings = await loadSettings();
      const apiKey = settings.anthropicApiKey || process.env.ANTHROPIC_API_KEY;

      // Get the latest user message
      const lastUserMessage = messages.filter(m => m.role === 'user').pop();
      if (!lastUserMessage) {
        return { success: false, error: 'No user message provided' };
      }

      // OFFLINE MODE: Use documentation-based responses when no API key
      if (!apiKey) {
        const offlineResponse = await getOfflineResponse(lastUserMessage.content);
        return {
          success: true,
          data: {
            content: offlineResponse.content + '\n\n---\n*📚 Offline mode - responses from local documentation. Add an API key in Settings for AI-powered assistance.*',
            role: 'assistant',
            isOffline: true,
            sources: offlineResponse.sources,
          }
        };
      }

      // ONLINE MODE: Use Claude API with RAG context
      const anthropic = new Anthropic({ apiKey });
      const ragContext = await buildContext(lastUserMessage.content);
      const systemPrompt = buildSystemPrompt(containerContext, ragContext);

      const apiMessages = buildApiMessages(messages, 10);
      if (apiMessages.length === 0) {
        return { success: false, error: 'No user message provided' };
      }

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages: apiMessages,
      });

      return {
        success: true,
        data: {
          content: response.content[0].text,
          role: 'assistant',
        }
      };
    } catch (error) {
      // Only a connectivity failure degrades to local documentation. An
      // API-level rejection (bad key, 400, rate limit) must reach the user —
      // masking it as "offline mode" hides a broken configuration forever.
      if (isConnectivityError(error)) {
        try {
          const lastUserMessage = messages.filter(m => m.role === 'user').pop();
          if (lastUserMessage) {
            const offlineResponse = await getOfflineResponse(lastUserMessage.content);
            return {
              success: true,
              data: {
                content: offlineResponse.content + `\n\n---\n*📚 Offline mode (could not reach the Claude API: ${getErrorMessage(error)})*`,
                role: 'assistant',
                isOffline: true,
                sources: offlineResponse.sources,
              }
            };
          }
        } catch {
          // Fall through to the error response below
        }
      }

      const status = typeof error?.status === 'number' ? ` (HTTP ${error.status})` : '';
      return { success: false, error: `Claude API error${status}: ${getErrorMessage(error)}` };
    }
  });

  // Get available RAG documents
  ipcMain.handle('ai:list-documents', async () => {
    try {
      const docs = await listDocuments();
      return { success: true, data: docs };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  // ============================================
  // Settings Handlers
  // ============================================

  ipcMain.handle('settings:get', async (event, key) => {
    // Validate key is in the allowlist to prevent reading arbitrary data
    if (!key || typeof key !== 'string' || !ALLOWED_SETTINGS_KEYS.includes(key)) {
      return { success: false, error: 'Invalid settings key' };
    }
    if (WRITE_ONLY_SETTINGS_KEYS.includes(key)) {
      return { success: false, error: `Setting "${key}" is write-only` };
    }
    const settings = await loadSettings();
    return { success: true, data: settings[key] };
  });

  ipcMain.handle('settings:set', async (event, key, value) => {
    if (!ALLOWED_SETTINGS_KEYS.includes(key)) {
      return { success: false, error: `Setting key "${key}" is not allowed` };
    }
    const validator = SETTINGS_VALIDATORS[key];
    if (validator && !validator(value)) {
      return { success: false, error: `Invalid value for setting "${key}"` };
    }
    try {
      const settings = await loadSettings();
      settings[key] = value;
      await saveSettings(settings);
      return { success: true };
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });

  ipcMain.handle('settings:get-all', async () => {
    const settings = await loadSettings();
    const filtered = {};
    for (const key of READABLE_SETTINGS_KEYS) {
      if (key in settings) {
        filtered[key] = settings[key];
      }
    }
    // Write-only keys are reported as set/unset flags so the UI can show state
    // without ever receiving the secret itself.
    for (const key of WRITE_ONLY_SETTINGS_KEYS) {
      filtered[`${key}Set`] = Boolean(settings[key]);
    }
    return { success: true, data: filtered };
  });
}

// ============================================
// Helper Functions
// ============================================

async function getContainerStats(containerId, timeoutMs = 5000) {
  const container = docker.getContainer(containerId);

  // Add timeout for Windows containers that may be slow to respond
  const statsPromise = container.stats({ stream: false });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Stats request timed out')), timeoutMs)
  );

  const stats = await Promise.race([statsPromise, timeoutPromise]);

  // Detect Windows container by checking for Windows-specific memory fields
  // Windows uses: commitbytes, commitpeakbytes, privateworkingset
  // Linux uses: usage, limit, stats.cache
  const isWindowsContainer = stats.memory_stats?.commitbytes !== undefined ||
                             stats.memory_stats?.privateworkingset !== undefined ||
                             stats.num_procs > 0;

  let cpuPercent = 0;
  let memoryUsage = 0;
  let memoryLimit = 0;
  let statsWarning = null;

  if (isWindowsContainer) {
    // === WINDOWS CONTAINER CPU CALCULATION ===
    // Windows uses 100-nanosecond intervals for CPU time
    // Reference: https://github.com/docker/cli/blob/master/cli/command/container/stats_helpers.go
    if (stats.cpu_stats?.cpu_usage?.total_usage !== undefined &&
        stats.precpu_stats?.cpu_usage?.total_usage !== undefined &&
        stats.read && stats.preread) {

      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;

      // Try system_cpu_usage first (if available)
      if (stats.cpu_stats.system_cpu_usage && stats.precpu_stats.system_cpu_usage) {
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const numCpus = stats.cpu_stats.online_cpus || stats.num_procs || 1;
        if (systemDelta > 0) {
          cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
        }
      } else {
        // Fallback: time-based calculation for Windows
        // Convert timestamps to get time delta in 100ns intervals
        const readTime = new Date(stats.read).getTime();
        const preReadTime = new Date(stats.preread).getTime();
        const timeDeltaMs = readTime - preReadTime;

        if (timeDeltaMs > 0) {
          // 1ms = 10,000 100ns intervals
          const possibleIntervals = timeDeltaMs * 10000 * (stats.num_procs || 1);
          cpuPercent = (cpuDelta / possibleIntervals) * 100;
        }
      }
    }

    // === WINDOWS CONTAINER MEMORY ===
    // Windows uses: privateworkingset (what docker stats shows), commitbytes, commitpeakbytes
    memoryUsage = stats.memory_stats?.privateworkingset ||
                  stats.memory_stats?.commitbytes || 0;
    memoryLimit = stats.memory_stats?.commitpeakbytes ||
                  stats.memory_stats?.limit || 0;

    // Check if stats are actually available
    if (!stats.memory_stats?.privateworkingset && !stats.memory_stats?.commitbytes) {
      statsWarning = 'Windows container stats limited (Hyper-V isolation)';
    }
  } else {
    // === LINUX CONTAINER CPU CALCULATION ===
    if (stats.cpu_stats?.cpu_usage?.total_usage && stats.precpu_stats?.cpu_usage?.total_usage) {
      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = (stats.cpu_stats.system_cpu_usage || 0) - (stats.precpu_stats.system_cpu_usage || 0);
      const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;

      if (systemDelta > 0) {
        cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
      }
    }

    // === LINUX CONTAINER MEMORY ===
    memoryUsage = stats.memory_stats?.usage
      ? stats.memory_stats.usage - (stats.memory_stats.stats?.cache || stats.memory_stats.stats?.inactive_file || 0)
      : 0;
    memoryLimit = stats.memory_stats?.limit || 0;
  }

  const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

  // Handle network stats (may use different interface names)
  const networks = stats.networks || {};
  const networkInterface = networks.eth0 || networks.nat || Object.values(networks)[0] || {};

  return {
    cpuPercent: isNaN(cpuPercent) || !isFinite(cpuPercent) ? 0 : cpuPercent,
    memoryUsage: memoryUsage || 0,
    memoryLimit: memoryLimit || 0,
    memoryPercent: isNaN(memoryPercent) || !isFinite(memoryPercent) ? 0 : memoryPercent,
    networkRx: networkInterface.rx_bytes || 0,
    networkTx: networkInterface.tx_bytes || 0,
    statsWarning,
    isWindowsContainer,
  };
}

function mapContainerToBCContainer(container) {
  const name = container.Names[0]?.replace('/', '') || 'unknown';

  // Filter out ports without public mappings and map properly
  // Docker returns ports with IP, PrivatePort, PublicPort, Type
  const mappedPorts = (container.Ports || [])
    .filter(p => p.PublicPort) // Only include ports that have a public mapping
    .map(p => ({
      privatePort: p.PrivatePort,
      publicPort: p.PublicPort,
      type: p.Type || 'tcp',
    }));

  return {
    id: container.Id,
    name,
    status: mapStatus(container.State),
    image: container.Image,
    created: new Date(container.Created * 1000).toISOString(),
    ports: mappedPorts,
    bcVersion: extractBCVersion(container.Image),
    webClientUrl: buildWebClientUrlFromPorts(name, container.Ports),
  };
}

function mapStatus(state) {
  const statusMap = {
    running: 'running',
    exited: 'exited',
    paused: 'paused',
    restarting: 'restarting',
    dead: 'dead',
    created: 'stopped',
  };
  return statusMap[state.toLowerCase()] || 'stopped';
}

function mapPorts(ports) {
  const mappings = [];
  for (const [key, bindings] of Object.entries(ports || {})) {
    if (bindings) {
      const [port, type] = key.split('/');
      for (const binding of bindings) {
        mappings.push({
          privatePort: parseInt(port),
          publicPort: parseInt(binding.HostPort),
          type,
        });
      }
    }
  }
  return mappings;
}

function extractBCVersion(image) {
  const match = image.match(/bc(\d+)|businesscentral[:\-]?(\d+)/i);
  return match ? (match[1] || match[2]) : undefined;
}

function buildWebClientUrl(info) {
  const ports = info.NetworkSettings.Ports;
  const httpsPort = ports?.['443/tcp']?.[0]?.HostPort;
  const name = info.Name.replace('/', '');
  return httpsPort ? `https://${name}:${httpsPort}/BC/` : undefined;
}

function buildWebClientUrlFromPorts(name, ports) {
  const httpsPort = ports.find(p => p.PrivatePort === 443)?.PublicPort;
  return httpsPort ? `https://${name}:${httpsPort}/BC/` : undefined;
}

function calculateUptime(startedAt) {
  const start = new Date(startedAt);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0 || isNaN(bytes) || !isFinite(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  if (i < 0 || i >= sizes.length) return '0 B';
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function parseDockerLogs(logStream) {
  const logs = [];
  const lines = logStream.toString().split('\n').filter(Boolean);

  for (const line of lines) {
    const cleanLine = line.substring(8);
    const match = cleanLine.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s(.*)$/);

    if (match) {
      logs.push({
        timestamp: match[1],
        stream: line.charCodeAt(0) === 1 ? 'stdout' : 'stderr',
        message: match[2],
      });
    }
  }

  return logs;
}

function buildSystemPrompt(containerContext, ragContext = '') {
  let prompt = `You are an expert assistant for managing Business Central Docker containers.
You have deep knowledge of:
- Microsoft Dynamics 365 Business Central
- BcContainerHelper PowerShell module
- Docker container management
- BC licensing and extensions
- Common BC errors and troubleshooting

Provide clear, actionable solutions. When suggesting PowerShell commands, format them as code blocks.
Be concise but thorough.

IMPORTANT: You have access to internal documentation. When relevant documentation is provided below,
use it to give accurate, organization-specific answers. Cite the documentation when applicable.`;

  if (containerContext) {
    prompt += `\n\nCurrent container context:
- Name: ${containerContext.name}
- Status: ${containerContext.status}
- BC Version: ${containerContext.bcVersion || 'Unknown'}
- Health: ${containerContext.health || 'Unknown'}
- Memory Usage: ${containerContext.memoryUsage || 'Unknown'}`;
  }

  if (ragContext) {
    prompt += `\n\n${ragContext}`;
  }

  return prompt;
}

async function loadSettings() {
  try {
    const data = await fs.readFile(settingsPath, 'utf8');
    const settings = JSON.parse(data);

    // Migrate plaintext encrypted keys to encrypted form and decrypt for use
    let needsSave = false;
    for (const key of ENCRYPTED_KEYS) {
      if (settings[key] && typeof settings[key] === 'string') {
        if (!settings[key].startsWith(ENCRYPTED_PREFIX)) {
          // Plaintext key found — encrypt and save (migration)
          const plaintext = settings[key];
          settings[key] = encryptValue(plaintext);
          needsSave = true;
        }
      }
    }
    if (needsSave) {
      // Save the migrated (now encrypted) settings back to disk
      const dir = path.dirname(settingsPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    }

    // Return settings with encrypted keys decrypted for runtime use
    const result = { ...settings };
    for (const key of ENCRYPTED_KEYS) {
      if (result[key]) {
        result[key] = decryptValue(result[key]);
      }
    }
    return result;
  } catch {
    return {};
  }
}

async function saveSettings(settings) {
  // Encrypt sensitive keys before writing to disk
  const toSave = { ...settings };
  for (const key of ENCRYPTED_KEYS) {
    if (toSave[key] && typeof toSave[key] === 'string' && !toSave[key].startsWith(ENCRYPTED_PREFIX)) {
      toSave[key] = encryptValue(toSave[key]);
    }
  }
  const dir = path.dirname(settingsPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(toSave, null, 2));
}

async function safeReadDir(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

module.exports = {
  registerIpcHandlers,
  // Exported for unit tests
  ALLOWED_SETTINGS_KEYS,
  READABLE_SETTINGS_KEYS,
  WRITE_ONLY_SETTINGS_KEYS,
  SETTINGS_VALIDATORS,
  validateContainerId,
  validateFilePath,
  buildApiMessages,
  isConnectivityError,
};
