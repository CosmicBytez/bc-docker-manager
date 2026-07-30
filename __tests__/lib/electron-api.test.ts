import {
  getSetting,
  setSetting,
  getAllSettings,
  runPowerShell,
  runPowerShellWithPassword,
  startDockerDesktop,
  isElectron,
} from '@/lib/electron-api';

type MockElectronAPI = {
  isElectron: boolean;
  settings: { get: jest.Mock; set: jest.Mock; getAll: jest.Mock };
  powershell: { run: jest.Mock; runWithPassword: jest.Mock; onOutput: jest.Mock };
  docker: { startDesktop: jest.Mock };
};

function installElectronApi(): MockElectronAPI {
  const api: MockElectronAPI = {
    isElectron: true,
    settings: {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue({ success: true }),
      getAll: jest.fn().mockResolvedValue({ success: true, data: {} }),
    },
    powershell: {
      run: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      runWithPassword: jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      onOutput: jest.fn(),
    },
    docker: {
      startDesktop: jest.fn().mockResolvedValue({ success: true }),
    },
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = api;
  return api;
}

function removeElectronApi() {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
}

describe('electron-api settings', () => {
  afterEach(() => {
    removeElectronApi();
    localStorage.clear();
  });

  it('detects Electron mode from the injected bridge', () => {
    expect(isElectron()).toBe(false);
    installElectronApi();
    expect(isElectron()).toBe(true);
  });

  // Regression: setSetting discarded the IPC response, so a rejected key
  // (deployPassword) or a failed validator (autoRefreshInterval) looked like a
  // successful save and the UI toasted "Settings saved successfully".
  it('throws when the main process rejects the key', async () => {
    const api = installElectronApi();
    api.settings.set.mockResolvedValue({
      success: false,
      error: 'Setting key "deployPassword" is not allowed',
    });

    await expect(setSetting('deployPassword', 'hunter2')).rejects.toThrow(
      'Setting key "deployPassword" is not allowed'
    );
  });

  it('throws when the value fails validation', async () => {
    const api = installElectronApi();
    api.settings.set.mockResolvedValue({
      success: false,
      error: 'Invalid value for setting "autoRefreshInterval"',
    });

    await expect(setSetting('autoRefreshInterval', 30)).rejects.toThrow(
      'Invalid value for setting "autoRefreshInterval"'
    );
  });

  it('throws a generic error when the response carries no message', async () => {
    const api = installElectronApi();
    api.settings.set.mockResolvedValue({ success: false });

    await expect(setSetting('backupRoot', 'C:\\X')).rejects.toThrow(
      'Failed to save setting "backupRoot"'
    );
  });

  it('resolves when the save succeeds', async () => {
    const api = installElectronApi();
    await expect(setSetting('autoRefreshInterval', 60)).resolves.toBeUndefined();
    expect(api.settings.set).toHaveBeenCalledWith('autoRefreshInterval', 60);
  });

  it('refuses to put sensitive values in localStorage in web mode', async () => {
    await setSetting('anthropicApiKey', 'sk-ant-secret');
    expect(localStorage.getItem('bc-manager-anthropicApiKey')).toBeNull();
  });

  it('reads settings through the bridge', async () => {
    const api = installElectronApi();
    api.settings.get.mockResolvedValue({ success: true, data: 45 });
    await expect(getSetting<number>('autoRefreshInterval')).resolves.toBe(45);

    api.settings.getAll.mockResolvedValue({
      success: true,
      data: { backupRoot: 'C:\\BCBackups', anthropicApiKeySet: true },
    });
    await expect(getAllSettings()).resolves.toEqual({
      backupRoot: 'C:\\BCBackups',
      anthropicApiKeySet: true,
    });
  });
});

describe('electron-api PowerShell', () => {
  afterEach(removeElectronApi);

  it('sends a password over the dedicated channel, never as an argument', async () => {
    const api = installElectronApi();
    const args = ['-Version', 'Latest', '-ContainerName', 'bcserver-latest', '-Username', 'admin'];

    await runPowerShellWithPassword('scripts/Deploy-BC-Container.ps1', args, 'hunter2');

    expect(api.powershell.runWithPassword).toHaveBeenCalledWith(
      'scripts/Deploy-BC-Container.ps1',
      args,
      'hunter2'
    );
    expect(args).not.toContain('hunter2');
    expect(api.powershell.run).not.toHaveBeenCalled();
  });

  it('uses the plain channel when no password is involved', async () => {
    const api = installElectronApi();
    await runPowerShell('scripts/Diagnose-HNS-Ports.ps1', []);
    expect(api.powershell.run).toHaveBeenCalled();
    expect(api.powershell.runWithPassword).not.toHaveBeenCalled();
  });

  it('rejects PowerShell execution outside the desktop app', async () => {
    await expect(runPowerShellWithPassword('scripts/Deploy-BC-Container.ps1', [], 'x')).rejects.toThrow(
      'only available in the desktop app'
    );
  });
});

describe('startDockerDesktop', () => {
  afterEach(removeElectronApi);

  // Regression: the launcher went through powershell.run('cmd', ...), which is
  // not whitelisted — the handler resolved { exitCode: 1 } and the caller
  // reported success anyway.
  it('reports the main-process failure instead of swallowing it', async () => {
    const api = installElectronApi();
    api.docker.startDesktop.mockResolvedValue({
      success: false,
      error: 'Docker Desktop executable not found',
    });

    await expect(startDockerDesktop()).resolves.toEqual({
      success: false,
      error: 'Docker Desktop executable not found',
    });
  });

  it('reports success when the launch works', async () => {
    installElectronApi();
    await expect(startDockerDesktop()).resolves.toEqual({ success: true });
  });

  it('reports failure in web mode', async () => {
    await expect(startDockerDesktop()).resolves.toEqual({
      success: false,
      error: 'Desktop app required',
    });
  });
});
