'use client';

import { useState, useEffect, useCallback } from 'react';
import { toast } from 'react-hot-toast';
import {
  Settings,
  Key,
  FolderOpen,
  Save,
  Eye,
  EyeOff,
  Info,
  Bug,
  RefreshCw,
} from 'lucide-react';
import {
  isElectron,
  getAllSettings,
  setSetting,
  getAppInfo,
  listContainers,
} from '@/lib/electron-api';

interface AppSettings {
  anthropicApiKey: string;
  backupRoot: string;
  autoRefreshInterval: number;
  theme: 'dark' | 'light';
}

interface AppInfo {
  version: string;
  name: string;
  platform: string;
  arch: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>({
    anthropicApiKey: '',
    backupRoot: 'C:\\BCBackups',
    autoRefreshInterval: 30,
    theme: 'dark',
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyStored, setApiKeyStored] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [isElectronApp] = useState(() => isElectron());
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      // The API key is write-only — the main process reports whether one is
      // stored but never returns the value, so the input starts empty.
      const stored = await getAllSettings();

      setSettings((prev) => ({
        ...prev,
        anthropicApiKey: '',
        backupRoot: (stored.backupRoot as string) || 'C:\\BCBackups',
        autoRefreshInterval: (stored.autoRefreshInterval as number) || 30,
      }));
      setApiKeyStored(Boolean(stored.anthropicApiKeySet));

      // Get app info
      const info = await getAppInfo();
      if (info) setAppInfo(info);
    } catch (error) {
      console.error('Failed to load settings:', error);
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      // An empty field means "leave the stored key alone" — the current value
      // is never loaded back into the input, so saving it would wipe the key.
      if (settings.anthropicApiKey) {
        await setSetting('anthropicApiKey', settings.anthropicApiKey);
        setSettings((prev) => ({ ...prev, anthropicApiKey: '' }));
        setApiKeyStored(true);
      }
      await setSetting('backupRoot', settings.backupRoot);
      await setSetting('autoRefreshInterval', settings.autoRefreshInterval);

      toast.success('Settings saved successfully');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save settings');
      console.error(error);
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const handleClearApiKey = useCallback(async () => {
    try {
      await setSetting('anthropicApiKey', '');
      setSettings((prev) => ({ ...prev, anthropicApiKey: '' }));
      setApiKeyStored(false);
      toast.success('Stored API key removed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove API key');
    }
  }, []);

  const runDiagnostics = useCallback(async () => {
    setLoadingDiagnostics(true);
    setDiagnostics(null);
    try {
      // Get first running container for stats test
      const containers = await listContainers();
      const runningContainer = containers.find(c => c.status === 'running');

      // Call diagnostics endpoint
      const electron = (window as unknown as { electronAPI?: { docker: { getDiagnostics: (id?: string) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }> } } }).electronAPI;
      if (electron?.docker?.getDiagnostics) {
        const result = await electron.docker.getDiagnostics(runningContainer?.id);
        if (result.success) {
          setDiagnostics(result.data || {});
        } else {
          setDiagnostics({ error: result.error });
        }
      } else {
        setDiagnostics({ error: 'Diagnostics not available' });
      }
    } catch (error) {
      setDiagnostics({ error: String(error) });
    } finally {
      setLoadingDiagnostics(false);
    }
  }, []);

  if (!isElectronApp) {
    return (
      <div className="p-8">
        <div className="card p-6 max-w-2xl">
          <div className="flex items-center gap-3 mb-4">
            <Info className="w-6 h-6 text-blue-400" />
            <h2 className="text-xl font-semibold">Desktop App Required</h2>
          </div>
          <p className="text-gray-400">
            Settings are only available in the desktop version of BC Container Manager.
            Download the desktop app to access configuration options.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold flex items-center gap-3">
          <Settings className="w-8 h-8" />
          Settings
        </h1>
        <p className="text-gray-400 mt-2">
          Configure your BC Container Manager preferences
        </p>
      </div>

      <div className="max-w-2xl space-y-6">
        {/* API Key */}
        <div className="card p-6">
          <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <Key className="w-5 h-5 text-yellow-400" />
            Anthropic API Key
          </h3>
          <p className="text-sm text-gray-400 mb-4">
            Required for AI-powered troubleshooting. Get your key from{' '}
            <a
              href="https://console.anthropic.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              console.anthropic.com
            </a>
          </p>
          <p className={`text-sm mb-3 ${apiKeyStored ? 'text-green-400' : 'text-gray-400'}`}>
            {apiKeyStored ? 'A key is stored and encrypted' : 'No key stored'}
          </p>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={settings.anthropicApiKey}
              onChange={(e) =>
                setSettings((prev) => ({ ...prev, anthropicApiKey: e.target.value }))
              }
              placeholder={apiKeyStored ? 'Enter a new key to replace the stored one' : 'sk-ant-...'}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 pr-10 focus:outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
            >
              {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            The stored key never leaves the main process, so it cannot be displayed here.
            Leave this blank to keep the existing key.
          </p>
          {apiKeyStored && (
            <button
              type="button"
              onClick={handleClearApiKey}
              className="mt-3 text-sm text-red-400 hover:text-red-300"
            >
              Remove stored key
            </button>
          )}
        </div>

        {/* Backup Path */}
        <div className="card p-6">
          <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <FolderOpen className="w-5 h-5 text-blue-400" />
            Backup Directory
          </h3>
          <p className="text-sm text-gray-400 mb-4">
            Where container backups will be stored
          </p>
          <input
            type="text"
            value={settings.backupRoot}
            onChange={(e) =>
              setSettings((prev) => ({ ...prev, backupRoot: e.target.value }))
            }
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Auto Refresh */}
        <div className="card p-6">
          <h3 className="text-lg font-semibold mb-4">Dashboard Refresh Interval</h3>
          <p className="text-sm text-gray-400 mb-4">
            How often to refresh container status (in seconds)
          </p>
          <select
            value={settings.autoRefreshInterval}
            onChange={(e) =>
              setSettings((prev) => ({
                ...prev,
                autoRefreshInterval: parseInt(e.target.value),
              }))
            }
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 focus:outline-none focus:border-blue-500"
          >
            <option value={10}>10 seconds</option>
            <option value={30}>30 seconds</option>
            <option value={60}>1 minute</option>
            <option value={120}>2 minutes</option>
            <option value={300}>5 minutes</option>
          </select>
        </div>

        {/* Save Button */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          {saving ? (
            <>Saving...</>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Save Settings
            </>
          )}
        </button>

        {/* App Info */}
        {appInfo && (
          <div className="card p-6 mt-8">
            <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
              <Info className="w-5 h-5 text-gray-400" />
              About
            </h3>
            <div className="space-y-2 text-sm text-gray-400">
              <p>
                <span className="text-gray-300">App:</span> {appInfo.name}
              </p>
              <p>
                <span className="text-gray-300">Version:</span> {appInfo.version}
              </p>
              <p>
                <span className="text-gray-300">Platform:</span> {appInfo.platform} ({appInfo.arch})
              </p>
            </div>
          </div>
        )}

        {/* Diagnostics */}
        <div className="card p-6 mt-8">
          <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
            <Bug className="w-5 h-5 text-orange-400" />
            Docker Diagnostics
          </h3>
          <p className="text-sm text-gray-400 mb-4">
            Run diagnostics to debug Docker connection and stats issues
          </p>
          <button
            onClick={runDiagnostics}
            disabled={loadingDiagnostics}
            className="btn-secondary flex items-center gap-2 mb-4"
          >
            <RefreshCw className={`w-4 h-4 ${loadingDiagnostics ? 'animate-spin' : ''}`} />
            {loadingDiagnostics ? 'Running...' : 'Run Diagnostics'}
          </button>

          {diagnostics && (
            <div className="bg-gray-900 rounded-lg p-4 overflow-auto max-h-96">
              <pre className="text-xs text-gray-300 whitespace-pre-wrap">
                {JSON.stringify(diagnostics, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
