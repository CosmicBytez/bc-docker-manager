/**
 * Executes the handlers registered by electron/main.js in a mocked Electron
 * runtime — the module is actually required and its `docker:start-desktop`,
 * `run-powershell` and `run-powershell-with-password` handlers are invoked,
 * not grepped for. The Windows-only halves (shell.openPath launching an .exe,
 * powershell.exe itself) stay operator-verified; everything up to those calls
 * runs here.
 *
 * @jest-environment node
 */

jest.mock('electron', () => {
  const handlers = new Map();
  const webContents = {
    session: { webRequest: { onHeadersReceived: jest.fn() } },
    openDevTools: jest.fn(),
    on: jest.fn(),
    setWindowOpenHandler: jest.fn(),
    send: jest.fn(),
  };
  const win = {
    webContents,
    loadURL: jest.fn(),
    once: jest.fn(),
    on: jest.fn(),
    show: jest.fn(),
  };
  const BrowserWindow = jest.fn(() => win);
  BrowserWindow.getAllWindows = jest.fn(() => [win]);
  return {
    app: {
      isPackaged: false,
      whenReady: jest.fn(() => Promise.resolve()),
      on: jest.fn(),
      quit: jest.fn(),
      requestSingleInstanceLock: jest.fn(() => true),
      getAppPath: jest.fn(() => '/app'),
      getPath: jest.fn(() => '/app/exe'),
      getVersion: jest.fn(() => '0.0.0-test'),
      getName: jest.fn(() => 'bc-container-manager-test'),
    },
    BrowserWindow,
    ipcMain: {
      handle: jest.fn((channel, fn) => handlers.set(channel, fn)),
      _handlers: handlers,
    },
    shell: { openPath: jest.fn(), openExternal: jest.fn() },
    dialog: {
      showOpenDialog: jest.fn(),
      showSaveDialog: jest.fn(),
      showMessageBoxSync: jest.fn(),
    },
    protocol: { registerSchemesAsPrivileged: jest.fn(), handle: jest.fn() },
    net: { fetch: jest.fn() },
    session: {},
  };
});

jest.mock('child_process', () => ({ spawn: jest.fn(), execSync: jest.fn() }));

jest.mock('../../electron/ipc-handlers', () => ({ registerIpcHandlers: jest.fn() }));

const { EventEmitter } = require('events');
const fs = require('fs');
const { ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const { registerIpcHandlers } = require('../../electron/ipc-handlers');

const PRIMARY_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe';
const X86_EXE = 'C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe';

// The spy consults this map for the two hardcoded Docker Desktop paths and
// falls through to the real filesystem for everything else (script paths,
// password temp files).
const realExistsSync = fs.existsSync;
const fakeExistingPaths = new Map();
let existsSyncSpy;

function invoke(channel, ...args) {
  const handler = ipcMain._handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({ /* IpcMainInvokeEvent */ }, ...args);
}

// Captured in beforeAll: the per-test jest.clearAllMocks() wipes boot-time
// call counts, so the bootstrap assertion reads this snapshot instead.
let registerCallsOnBoot = 0;

beforeAll(async () => {
  require('../../electron/main');
  // setupIpcHandlers runs inside app.whenReady().then(...)
  await new Promise((resolve) => setImmediate(resolve));
  registerCallsOnBoot = registerIpcHandlers.mock.calls.length;
});

beforeEach(() => {
  jest.clearAllMocks();
  fakeExistingPaths.clear();
  existsSyncSpy = jest
    .spyOn(fs, 'existsSync')
    .mockImplementation((p) =>
      fakeExistingPaths.has(p) ? fakeExistingPaths.get(p) : realExistsSync(p)
    );
});

afterEach(() => {
  existsSyncSpy.mockRestore();
});

describe('main.js bootstrap', () => {
  it('registers the renderer-facing IPC handlers', () => {
    expect(registerCallsOnBoot).toBe(1);
    for (const channel of [
      'docker:start-desktop',
      'run-powershell',
      'run-powershell-with-password',
      'open-external',
      'get-app-info',
    ]) {
      expect(ipcMain._handlers.has(channel)).toBe(true);
    }
  });
});

describe('docker:start-desktop', () => {
  it('reports not-found without opening anything when no install exists', async () => {
    fakeExistingPaths.set(PRIMARY_EXE, false);
    fakeExistingPaths.set(X86_EXE, false);

    const result = await invoke('docker:start-desktop');

    expect(result).toEqual({ success: false, error: 'Docker Desktop executable not found' });
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('launches the default install location', async () => {
    fakeExistingPaths.set(PRIMARY_EXE, true);
    shell.openPath.mockResolvedValue('');

    const result = await invoke('docker:start-desktop');

    expect(shell.openPath).toHaveBeenCalledTimes(1);
    expect(shell.openPath).toHaveBeenCalledWith(PRIMARY_EXE);
    expect(result).toEqual({ success: true });
  });

  it('falls back to the x86 install location', async () => {
    fakeExistingPaths.set(PRIMARY_EXE, false);
    fakeExistingPaths.set(X86_EXE, true);
    shell.openPath.mockResolvedValue('');

    const result = await invoke('docker:start-desktop');

    expect(shell.openPath).toHaveBeenCalledWith(X86_EXE);
    expect(result).toEqual({ success: true });
  });

  it('surfaces a launch failure from shell.openPath', async () => {
    fakeExistingPaths.set(PRIMARY_EXE, true);
    shell.openPath.mockResolvedValue('Access is denied.');

    const result = await invoke('docker:start-desktop');

    expect(result).toEqual({ success: false, error: 'Access is denied.' });
  });

  it('ignores renderer-supplied arguments — only the fixed paths are opened', async () => {
    fakeExistingPaths.set(PRIMARY_EXE, true);
    fakeExistingPaths.set('C:\\evil\\payload.exe', true);
    shell.openPath.mockResolvedValue('');

    await invoke('docker:start-desktop', 'C:\\evil\\payload.exe');

    expect(shell.openPath).toHaveBeenCalledTimes(1);
    expect(shell.openPath).toHaveBeenCalledWith(PRIMARY_EXE);
  });
});

describe('run-powershell', () => {
  it('refuses a script outside the whitelist without spawning anything', async () => {
    // The pre-fix Setup page sent 'cmd' here; the handler must resolve with a
    // failing exit code, not run it.
    const result = await invoke('run-powershell', { script: 'cmd', args: ['/c', 'start', ''] });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Script not allowed: cmd');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('run-powershell-with-password', () => {
  it('rejects an empty password before touching the filesystem', async () => {
    const result = await invoke('run-powershell-with-password', {
      script: 'scripts/Deploy-BC-Container.ps1',
      args: [],
      password: '',
    });

    expect(result).toEqual({ stdout: '', stderr: 'Invalid password', exitCode: 1 });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects an oversized password', async () => {
    const result = await invoke('run-powershell-with-password', {
      script: 'scripts/Deploy-BC-Container.ps1',
      args: [],
      password: 'x'.repeat(257),
    });

    expect(result.exitCode).toBe(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('stages the password in a mode-600 temp file passed as -PasswordFile and removes it after the run', async () => {
    const staged = {};
    spawn.mockImplementation((cmd, args) => {
      const idx = args.indexOf('-PasswordFile');
      if (idx !== -1) {
        staged.path = args[idx + 1];
        staged.content = fs.readFileSync(args[idx + 1], 'utf8');
        staged.mode = fs.statSync(args[idx + 1]).mode & 0o777;
      }
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('deployed\n'));
        proc.emit('close', 0);
      });
      return proc;
    });

    const password = 'P@ss;w0rd$1';
    const result = await invoke('run-powershell-with-password', {
      script: 'scripts/Deploy-BC-Container.ps1',
      args: ['-Version', '26', '-ContainerName', 'bcserver-bc26'],
      password,
    });

    expect(result.exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);

    const argv = spawn.mock.calls[0][1];
    expect(argv).not.toContain(password);
    expect(staged.path).toBeDefined();
    expect(staged.content).toBe(password);
    if (process.platform !== 'win32') {
      // libuv reports 0o666 for any writable file on Windows; the 0600 staging
      // mode is only enforceable (and only meaningful) on POSIX.
      expect(staged.mode).toBe(0o600);
    }
    // Cleaned up in the handler's finally block.
    expect(realExistsSync(staged.path)).toBe(false);
  });
});
