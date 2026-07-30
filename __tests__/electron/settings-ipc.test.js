/**
 * Executes the real settings IPC handlers registered by registerIpcHandlers.
 *
 * The write-only API-key enforcement lives in the `settings:get` and
 * `settings:get-all` handler bodies, not in the exported allowlist constants —
 * asserting on READABLE_SETTINGS_KEYS alone stays green when the handlers are
 * reverted to returning the decrypted key. These tests round-trip a secret
 * through the handlers themselves and assert it never crosses the IPC
 * boundary and never reaches the settings file in plaintext.
 *
 * @jest-environment node
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// The settings path is computed from APPDATA at module load, so it must be
// pointed at a scratch directory before the module is required.
const SETTINGS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-settings-ipc-'));
process.env.APPDATA = SETTINGS_ROOT;
const SETTINGS_FILE = path.join(SETTINGS_ROOT, 'bc-container-manager', 'settings.json');

// A reversible fake keeps the "encrypted at rest" path executable on Linux:
// what lands on disk is base64 of the reversed string, never the plaintext.
jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v) => Buffer.from(String(v).split('').reverse().join(''), 'utf8'),
    decryptString: (b) => b.toString('utf8').split('').reverse().join(''),
  },
}));

jest.mock('../../electron/rag-helper', () => ({
  buildContext: jest.fn(),
  getOfflineResponse: jest.fn(),
  listDocuments: jest.fn(),
}));

const { registerIpcHandlers } = require('../../electron/ipc-handlers');

const SECRET = 'sk-ant-test-write-only-secret';

const handlers = new Map();
registerIpcHandlers({ handle: (channel, fn) => handlers.set(channel, fn) });

function invoke(channel, ...args) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({ /* IpcMainInvokeEvent */ }, ...args);
}

beforeEach(() => {
  fs.rmSync(SETTINGS_FILE, { force: true });
});

afterAll(() => {
  fs.rmSync(SETTINGS_ROOT, { recursive: true, force: true });
});

describe('settings:get', () => {
  it('rejects the API key and returns no data', async () => {
    expect(await invoke('settings:set', 'anthropicApiKey', SECRET)).toEqual({ success: true });

    const result = await invoke('settings:get', 'anthropicApiKey');

    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('still returns readable keys', async () => {
    await invoke('settings:set', 'backupRoot', 'D:\\Backups');

    expect(await invoke('settings:get', 'backupRoot')).toEqual({
      success: true,
      data: 'D:\\Backups',
    });
  });
});

describe('settings:get-all', () => {
  it('reports only a set/unset flag for the stored key, never the value', async () => {
    await invoke('settings:set', 'anthropicApiKey', SECRET);
    await invoke('settings:set', 'backupRoot', 'D:\\Backups');

    const result = await invoke('settings:get-all');

    expect(result.success).toBe(true);
    expect(result.data.anthropicApiKeySet).toBe(true);
    expect(result.data).not.toHaveProperty('anthropicApiKey');
    expect(result.data.backupRoot).toBe('D:\\Backups');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reports the flag as false when no key is stored', async () => {
    const result = await invoke('settings:get-all');

    expect(result.success).toBe(true);
    expect(result.data.anthropicApiKeySet).toBe(false);
  });

  it('reports the flag as false again after the key is cleared', async () => {
    await invoke('settings:set', 'anthropicApiKey', SECRET);
    expect(await invoke('settings:set', 'anthropicApiKey', '')).toEqual({ success: true });

    const result = await invoke('settings:get-all');

    expect(result.data.anthropicApiKeySet).toBe(false);
  });
});

describe('settings file at rest', () => {
  it('never contains the plaintext secret', async () => {
    await invoke('settings:set', 'anthropicApiKey', SECRET);

    const onDisk = fs.readFileSync(SETTINGS_FILE, 'utf8');

    expect(onDisk).not.toContain(SECRET);
    expect(JSON.parse(onDisk).anthropicApiKey).toMatch(/^enc:/);
  });
});
