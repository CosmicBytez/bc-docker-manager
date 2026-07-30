/**
 * BC Container Manager - Electron Main Process
 *
 * This is the main entry point for the Electron app.
 * It creates the browser window and handles IPC communication.
 */

const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const url = require('url');

// Import IPC handlers
const { registerIpcHandlers } = require('./ipc-handlers');

// Keep a global reference of the window object
let mainWindow = null;

// Determine if we're in development mode
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

/**
 * Get the correct path for app resources
 */
function getAppPath() {
  if (isDev) {
    return path.join(__dirname, '..');
  }
  // In production, app.getAppPath() returns the path to the app.asar or unpacked directory
  return app.getAppPath();
}

/**
 * Register custom protocol for serving static files
 * This allows Next.js absolute paths to work in Electron
 */
function registerCustomProtocol() {
  protocol.handle('app', (request) => {
    // Parse the URL and get the path
    const urlObj = new URL(request.url);
    let filePath = urlObj.pathname;

    // Handle root path
    if (filePath === '/' || filePath === '') {
      filePath = '/index.html';
    }

    // Build the full file path
    const outDir = path.resolve(getAppPath(), 'out');
    let fullPath = path.resolve(outDir, filePath.replace(/^\//, ''));

    // SECURITY: Prevent path traversal - ensure resolved path is within outDir
    if (!fullPath.startsWith(outDir + path.sep) && fullPath !== outDir) {
      return new Response('Forbidden', { status: 403 });
    }

    // Handle directory requests - append index.html
    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        fullPath = path.join(fullPath, 'index.html');
      }
    } catch (e) {
      // File doesn't exist, will be handled below
    }

    // Convert to file:// URL for net.fetch
    const fileUrl = url.pathToFileURL(fullPath).href;

    return net.fetch(fileUrl);
  });
}

/**
 * Creates the main application window
 */
function createWindow() {
  // Get icon path based on dev/prod environment
  const iconPath = isDev
    ? path.join(__dirname, '..', 'assets', 'icon.png')
    : path.join(process.resourcesPath, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 400,
    title: 'BC Container Manager',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // dockerode runs in main process via IPC, not renderer
    },
    show: false, // Don't show until ready
    backgroundColor: '#1f2937', // Match app background
  });

  // SECURITY: Inject Content Security Policy headers for the Electron window
  // This protects against XSS even when loading local content
  const cspHeader = [
    "default-src 'self' app:",
    "script-src 'self' 'unsafe-inline' app:",
    "style-src 'self' 'unsafe-inline' app:",
    "img-src 'self' data: app:",
    "connect-src 'self' ws://localhost:* wss://localhost:* app:",
    "font-src 'self' app:",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspHeader],
      },
    });
  });

  // Load the app
  if (isDev) {
    // In development, load from Next.js dev server on port 3333
    const devPort = process.env.DEV_PORT || '3333';
    mainWindow.loadURL(`http://localhost:${devPort}`);
    mainWindow.webContents.openDevTools();
  } else {
    // In production, use custom protocol for proper path resolution
    mainWindow.loadURL('app://./index.html');
  }

  // Log any load errors (only in development)
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    if (isDev) {
      console.error('Failed to load:', errorCode, errorDescription);
    }
  });

  // Show window when ready to prevent visual flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Handle external links (only allow http/https URLs)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)) {
        shell.openExternal(url);
      }
    } catch { /* ignore invalid URLs */ }
    return { action: 'deny' };
  });

  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle navigation to BC web client
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow internal navigation, open BC URLs externally (only http/https)
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol) && (url.includes('/BC/') || url.includes(':443'))) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch { /* ignore invalid URLs */ }
  });
}

/**
 * Register all IPC handlers for communication with renderer
 */
function setupIpcHandlers() {
  registerIpcHandlers(ipcMain);

  // Handle PowerShell script execution (for Install-BC-Helper)
  // SECURITY: Whitelist of allowed scripts to prevent path traversal attacks
  const ALLOWED_SCRIPTS = [
    'scripts/Install-BC-Helper.ps1',
    'scripts/Deploy-BC-Container.ps1',  // Docker-direct deployment (bypasses HNS issues)
    'scripts/Backup-BC-Container.ps1',
    'scripts/Restore-BC-Container.ps1',
    'scripts/Fix-HNS-State.ps1',
    'scripts/Diagnose-HNS-Ports.ps1',
  ];

  // SECURITY: Sanitize PowerShell arguments to prevent command injection
  function sanitizePowerShellArg(arg) {
    if (typeof arg !== 'string') return String(arg);
    // Escape single quotes for PowerShell (double them up)
    return arg.replace(/'/g, "''");
  }

  function validateContainerName(name) {
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name);
  }

  /**
   * Writes a secret to a randomly named file in the per-user temp directory.
   * Mode 0600 is the protection on POSIX; on Windows the per-user temp
   * directory is what keeps it out of other accounts' reach. The consuming
   * script deletes the file as soon as it has been read; the caller removes it
   * again in a finally block in case the script died first.
   */
  function writeSecretFile(secret) {
    const crypto = require('crypto');
    const os = require('os');
    const filePath = path.join(os.tmpdir(), `bc-deploy-${crypto.randomBytes(16).toString('hex')}.txt`);
    fs.writeFileSync(filePath, secret, { encoding: 'utf8', mode: 0o600 });
    return filePath;
  }

  /**
   * Runs a whitelisted PowerShell script.
   * @param {string} script - repo-relative script path (must be in ALLOWED_SCRIPTS)
   * @param {string[]} args - arguments originating from the renderer (validated + sanitized)
   * @param {string[]} trustedArgs - arguments generated by the main process; appended
   *   after validation because they are not renderer-controlled. spawn() passes argv
   *   directly (no shell), so metacharacters in a generated temp path are inert.
   */
  function executePowerShell(script, args, trustedArgs = []) {
    return new Promise((resolve, reject) => {
      // SECURITY: Validate script is in whitelist
      if (!ALLOWED_SCRIPTS.includes(script)) {
        mainWindow?.webContents.send('powershell-output', {
          type: 'stderr',
          data: `[ERROR] Script not allowed: ${script}\n`
        });
        resolve({ stdout: '', stderr: `Script not allowed: ${script}`, exitCode: 1 });
        return;
      }

      // SECURITY: Validate and sanitize arguments to prevent command injection
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-ContainerName' && i + 1 < args.length) {
          if (!validateContainerName(args[i + 1])) {
            mainWindow?.webContents.send('powershell-output', {
              type: 'stderr',
              data: `[ERROR] Invalid container name format: ${args[i + 1]}\n`
            });
            return reject(new Error('Invalid container name format'));
          }
        }
        // Reject args containing shell metacharacters (including password values)
        if (args[i] !== '-Password') {
          if (/[;&|`$(){}]/.test(args[i])) {
            mainWindow?.webContents.send('powershell-output', {
              type: 'stderr',
              data: `[ERROR] Invalid characters in argument: ${args[i]}\n`
            });
            return reject(new Error('Invalid characters in argument'));
          }
        }
      }
      // Sanitize all arguments, then append main-process-generated ones
      const sanitizedArgs = args.map((arg, i) => {
        // Don't sanitize parameter names (they start with -)
        if (typeof arg === 'string' && arg.startsWith('-')) return arg;
        return sanitizePowerShellArg(arg);
      }).concat(trustedArgs);
      // Resolve script path based on dev/prod environment
      // Scripts are unpacked from asar to app.asar.unpacked/scripts/
      let scriptPath;
      if (isDev) {
        scriptPath = path.join(__dirname, '..', script);
      } else {
        // In production, scripts are unpacked from asar
        const appPath = app.getAppPath();
        scriptPath = path.join(appPath.replace('app.asar', 'app.asar.unpacked'), script);
      }

      // Mask sensitive args in debug output
      const safeArgs = sanitizedArgs.map((arg, i) => {
        if (i > 0 && sanitizedArgs[i - 1] === '-Password') return '********';
        return arg;
      });

      // Log script path for debugging (only in development mode)
      if (isDev) {
        console.log('PowerShell script path:', scriptPath);
        console.log('Script exists:', require('fs').existsSync(scriptPath));
        mainWindow?.webContents.send('powershell-output', {
          type: 'stdout',
          data: `[DEBUG] Script path: ${scriptPath}\n`
        });
        mainWindow?.webContents.send('powershell-output', {
          type: 'stdout',
          data: `[DEBUG] Args: ${safeArgs.join(' ')}\n`
        });
      }

      // Check if script exists
      if (!require('fs').existsSync(scriptPath)) {
        mainWindow?.webContents.send('powershell-output', {
          type: 'stderr',
          data: `[ERROR] Script not found at: ${scriptPath}\n`
        });
        resolve({ stdout: '', stderr: `Script not found: ${scriptPath}`, exitCode: 1 });
        return;
      }

      // Run PowerShell with proper flags
      // NOTE: App must be run as administrator for NetNat cmdlets to work
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        ...sanitizedArgs
      ]);

      let stdout = '';
      let stderr = '';

      ps.stdout.on('data', (data) => {
        stdout += data.toString();
        // Send real-time output to renderer
        mainWindow?.webContents.send('powershell-output', {
          type: 'stdout',
          data: data.toString()
        });
      });

      ps.stderr.on('data', (data) => {
        stderr += data.toString();
        mainWindow?.webContents.send('powershell-output', {
          type: 'stderr',
          data: data.toString()
        });
      });

      ps.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code });
      });

      ps.on('error', (err) => {
        reject(err);
      });
    });
  }

  ipcMain.handle('run-powershell', async (event, { script, args }) => {
    return executePowerShell(script, Array.isArray(args) ? args : []);
  });

  // Runs a script that needs a password, passing it via a mode-600 temp file
  // instead of the process command line. The password is never persisted to
  // the settings store and never appears in argv or the output log.
  ipcMain.handle('run-powershell-with-password', async (event, { script, args, password }) => {
    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
      return { stdout: '', stderr: 'Invalid password', exitCode: 1 };
    }

    let passwordFile;
    try {
      passwordFile = writeSecretFile(password);
    } catch (err) {
      return { stdout: '', stderr: `Failed to stage password file: ${err.message}`, exitCode: 1 };
    }

    try {
      return await executePowerShell(
        script,
        Array.isArray(args) ? args : [],
        ['-PasswordFile', passwordFile]
      );
    } finally {
      try {
        fs.rmSync(passwordFile, { force: true });
      } catch { /* script already deleted it */ }
    }
  });

  // Launches Docker Desktop. Deliberately not a general "open any path" channel —
  // the renderer can only ask for this one known executable.
  const DOCKER_DESKTOP_PATHS = [
    'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
    'C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe',
  ];

  ipcMain.handle('docker:start-desktop', async () => {
    for (const exePath of DOCKER_DESKTOP_PATHS) {
      if (fs.existsSync(exePath)) {
        const error = await shell.openPath(exePath);
        if (error) return { success: false, error };
        return { success: true };
      }
    }
    return { success: false, error: 'Docker Desktop executable not found' };
  });

  // Handle file/folder dialogs
  ipcMain.handle('show-open-dialog', async (event, options) => {
    return dialog.showOpenDialog(mainWindow, options);
  });

  ipcMain.handle('show-save-dialog', async (event, options) => {
    return dialog.showSaveDialog(mainWindow, options);
  });

  // Handle opening external URLs (only allow http/https)
  ipcMain.handle('open-external', async (event, url) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http/https URLs are allowed');
      }
    } catch (e) {
      return;
    }
    return shell.openExternal(url);
  });

  // Get app info
  ipcMain.handle('get-app-info', async () => {
    return {
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      arch: process.arch,
    };
  });
}

// Register the app:// protocol scheme as privileged (must be done before app ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// Check if running with administrator privileges (Windows only)
function isAdmin() {
  if (process.platform !== 'win32') return true;

  try {
    // Try to open a handle to the system32 directory with write access
    // Only admin processes can do this
    const { execSync } = require('child_process');
    execSync('net session', { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Request elevation if not running as admin
function requestElevation() {
  const { shell } = require('electron');
  const { spawn } = require('child_process');

  // Get the executable path
  const exePath = app.getPath('exe');

  // Show elevation dialog
  const result = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Administrator Privileges Required',
    message: 'BC Container Manager requires administrator privileges to manage Docker containers and network settings.',
    detail: 'The application will now restart with administrator privileges. Click OK to continue.',
    buttons: ['OK', 'Cancel'],
    cancelId: 1,
  });

  if (result === 1) {
    // User clicked Cancel - exit without elevation
    app.quit();
    return;
  }

  // Relaunch with elevation using PowerShell Start-Process
  spawn('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Start-Process -FilePath "${exePath}" -Verb RunAs`
  ], { detached: true, stdio: 'ignore' });

  app.quit();
}

// App lifecycle events

app.whenReady().then(() => {
  // Check for admin privileges on Windows
  if (process.platform === 'win32' && !isAdmin()) {
    console.log('Not running as administrator - requesting elevation...');
    requestElevation();
    return;
  }

  // Register custom protocol for static file serving
  registerCustomProtocol();

  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    // On macOS, re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep app running until Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle certificate errors for self-signed BC containers
app.on('certificate-error', (event, webContents, urlString, error, certificate, callback) => {
  // SECURITY: Only allow self-signed certs for truly local connections
  // Prevents DNS spoofing attacks via domains like 'bcserver-attacker.com'
  try {
    const parsedUrl = new URL(urlString);
    const hostname = parsedUrl.hostname.toLowerCase();

    // Allow self-signed certs only for:
    // 1. localhost or 127.0.0.1 (loopback)
    // 2. Container names containing 'bc' on local network (.local or no TLD)
    // 3. Private IP ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1';
    const isLocalBcContainer = /bc/i.test(hostname) && (
      hostname.endsWith('.local') ||
      !hostname.includes('.') // hostname without TLD (e.g., 'mybc-test')
    );
    const isPrivateIp = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(hostname);

    if (isLoopback || isLocalBcContainer || isPrivateIp) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  } catch {
    // If URL parsing fails, reject the certificate
    callback(false);
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Focus existing window if user tries to open another instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
